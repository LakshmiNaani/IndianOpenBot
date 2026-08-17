// Used when no ICE server endpoint is configured, or when it cannot be reached.
// STUN alone only works when both peers are on friendly NATs; a relay is needed
// for anything crossing CGNAT (see VITE_PUBLIC_ICE_SERVERS_URL in .env.example).
const FALLBACK_ICE_SERVERS = [{urls: 'stun:stun.l.google.com:19302'}]

/**
 * Fetch short-lived TURN credentials from the configured endpoint. The endpoint
 * holds the provider API token, so no credentials are shipped in this bundle.
 * @returns {Promise<Array>} ICE servers, falling back to STUN-only on failure
 */
const fetchIceServers = async () => {
    const url = import.meta.env.VITE_PUBLIC_ICE_SERVERS_URL
    if (!url) {
        console.warn('WebRTC: no VITE_PUBLIC_ICE_SERVERS_URL set, using STUN only. Remote connections will likely fail.')
        return FALLBACK_ICE_SERVERS
    }

    try {
        const response = await fetch(url)
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`)
        }
        const body = await response.json()
        const iceServers = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers]
        if (!iceServers.length || !iceServers[0]) {
            throw new Error('response contained no iceServers')
        }
        return iceServers
    } catch (error) {
        console.error('WebRTC: could not fetch ICE servers, falling back to STUN only:', error)
        return FALLBACK_ICE_SERVERS
    }
}

/**
 * function to enable webRTC connection
 * @param connection
 * @constructor
 */
export function WebRTC (connection) {
    const {RTCPeerConnection} = window

    let peerConnection = null
    let onDataMessageReceivedCallback = null

    // Events can arrive before start() has finished building the peer connection
    // (it now awaits the ICE server fetch), and candidates cannot be added before
    // the remote description is set. Both cases are buffered rather than dropped.
    let pendingEvents = []
    let pendingCandidates = []
    let statsTimer = null
    const MAX_PENDING_EVENTS = 200

    this.onDataMessageReceived = (callback) => {
        onDataMessageReceivedCallback = callback
    }

    this.handle = (data) => {
        const webRtcEvent = typeof data === 'string' ? JSON.parse(data) : data

        if (!peerConnection) {
            // start() is still resolving its ICE servers. Hold the event so the
            // offer and its candidates are not lost.
            if (pendingEvents.length < MAX_PENDING_EVENTS) {
                pendingEvents.push(webRtcEvent)
            }
            return
        }

        handleEvent(webRtcEvent)
    }

    const handleEvent = async (webRtcEvent) => {
        const {RTCSessionDescription, RTCIceCandidate} = window

        // WebRTC type
        switch (webRtcEvent.type) {
            case 'offer':
                await peerConnection.setRemoteDescription(
                    new RTCSessionDescription({sdp: webRtcEvent.sdp, type: 'offer'})
                )
                await flushPendingCandidates()
                await doAnswer()
                break

            case 'candidate': {
                const candidate = new RTCIceCandidate({
                    candidate: webRtcEvent.candidate,
                    sdpMid: webRtcEvent.id,
                    sdpMLineIndex: webRtcEvent.label
                })
                // addIceCandidate() rejects until the remote description exists
                if (!peerConnection.remoteDescription) {
                    pendingCandidates.push(candidate)
                    break
                }
                await peerConnection.addIceCandidate(candidate)
                break
            }

            case 'bye':
                this.stop()
                break
        }
    }

    const flushPendingCandidates = async () => {
        const candidates = pendingCandidates
        pendingCandidates = []
        for (const candidate of candidates) {
            try {
                await peerConnection.addIceCandidate(candidate)
            } catch (error) {
                console.error('WebRTC: could not add buffered candidate:', error)
            }
        }
    }

    const flushPendingEvents = async () => {
        const events = pendingEvents
        pendingEvents = []
        for (const event of events) {
            await handleEvent(event)
        }
    }

    const doAnswer = async () => {
        const answer = await peerConnection.createAnswer()
        await peerConnection.setLocalDescription(answer)
        connection.send(JSON.stringify({webrtc_event: answer}))
    }

    // starting webrtc connection
    this.start = async () => {
        console.log('WebRTC: start...')

        const iceServers = await fetchIceServers()
        console.log('WebRTC: ICE servers:', iceServers.flatMap((server) => server.urls))

        peerConnection = new RTCPeerConnection({iceServers})
        peerConnection.onconnectionstatechange = () => {
            console.log('WebRTC connectionState:', peerConnection?.connectionState)
            if (peerConnection?.connectionState === 'connected') {
                logSelectedCandidatePair()
            }
        }
        peerConnection.oniceconnectionstatechange = () => {
            console.log('WebRTC iceConnectionState:', peerConnection?.iceConnectionState)
        }
        peerConnection.onicegatheringstatechange = () => {
            console.log('WebRTC iceGatheringState:', peerConnection?.iceGatheringState)
        }

        // Fires when a STUN/TURN server rejects us or cannot be reached. Without
        // this, a failed TURN allocation is silent - you just never see relay
        // candidates and have no idea why.
        peerConnection.onicecandidateerror = (event) => {
            console.error(`WebRTC ICE server error: ${event.url} -> ${event.errorCode} ${event.errorText}`)
        }

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                // candidate type tells you at a glance whether the relay is working:
                // "host" only means no STUN/TURN reached, "relay" means TURN is live
                console.log('WebRTC local candidate:', event.candidate.type, event.candidate.protocol)
                connection.send(JSON.stringify({
                    webrtc_event: {
                        type: 'candidate',
                        label: event.candidate.sdpMLineIndex,
                        id: event.candidate.sdpMid,
                        candidate: event.candidate.candidate
                    }
                }))
            }
        }

        // The robot's offer contains only audio and video m-lines, so this channel
        // has nothing to negotiate against and stays in "connecting" forever. It is
        // kept because commands are meant to move here eventually; until the robot
        // offers a data section, driving commands go over the websocket instead.
        this.dataChannel = peerConnection.createDataChannel('dataChannel') // Use this.dataChannel to set it as a property

        peerConnection.ondatachannel = (event) => {
            const dataChannel = event.channel
            dataChannel.onopen = () => {
                // eventHandlers.onDataChannelOpened(dataChannel);
            }
        }

        this.dataChannel.onopen = () => {
            console.log('DataChannel is open Ready to send the message:')
        }
        this.dataChannel.onmessage = (event) => {
            // Handle incoming messages here
            const message = event.data
            if (onDataMessageReceivedCallback) {
                onDataMessageReceivedCallback(message)
            }
        }
        const video = document.getElementById('video')

        video.srcObject = new MediaStream()
        video.srcObject.getTracks().forEach((track) => peerConnection.addTrack(track))

        peerConnection.ontrack = (event) => {
            console.log('WebRTC ontrack: received remote track', event.track.kind)
            video.srcObject = event.streams[0]
        }

        startStatsMonitor()
        await flushPendingEvents()
    }

    /**
     * Reports every two seconds whether media is actually arriving. This is the
     * question that matters when ICE says connected but the picture is blank:
     * bytes climbing means it is a rendering problem, bytes stuck at zero means
     * the media path never opened regardless of what ICE reported.
     */
    const startStatsMonitor = () => {
        clearInterval(statsTimer)
        statsTimer = setInterval(async () => {
            if (!peerConnection) {
                clearInterval(statsTimer)
                return
            }

            const stats = await peerConnection.getStats()
            let pair = null
            const inbound = []

            stats.forEach((report) => {
                if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
                    const local = stats.get(report.localCandidateId)
                    const remote = stats.get(report.remoteCandidateId)
                    pair = `${local?.candidateType}/${local?.protocol} -> ${remote?.candidateType}/${remote?.protocol}`
                }
                if (report.type === 'inbound-rtp') {
                    inbound.push(`${report.kind}: ${report.bytesReceived}B, ${report.packetsReceived} pkts` +
                        (report.kind === 'video' ? `, ${report.framesDecoded} frames decoded, ${report.frameWidth}x${report.frameHeight}` : ''))
                }
            })

            console.log(`WebRTC stats | conn=${peerConnection.connectionState} ice=${peerConnection.iceConnectionState} | pair=${pair || 'none nominated'} | ${inbound.join(' | ') || 'no inbound-rtp'}`)
        }, 2000)
    }

    /**
     * Logs which candidate pair actually carried the media. Tells you whether the
     * session went direct or via the relay, and what it is costing you.
     */
    const logSelectedCandidatePair = async () => {
        try {
            const stats = await peerConnection.getStats()
            stats.forEach((report) => {
                if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') {
                    const local = stats.get(report.localCandidateId)
                    const remote = stats.get(report.remoteCandidateId)
                    console.log(`WebRTC selected pair: local ${local?.candidateType} (${local?.protocol}) <-> remote ${remote?.candidateType} (${remote?.protocol})`)
                }
            })
        } catch (error) {
            console.error('WebRTC: could not read stats:', error)
        }
    }

    this.stop = () => {
        console.log('WebRTC: stop...')

        if (peerConnection) {
            peerConnection.close()
        }
        peerConnection = null
        pendingEvents = []
        pendingCandidates = []
        clearInterval(statsTimer)
        detachVideo()
    }

    /**
     * Closing the peer connection leaves the last frame on screen, so the feed
     * looks live when it is not. Release the tracks and blank the element.
     */
    const detachVideo = () => {
        const video = document.getElementById('video')
        if (!video || !video.srcObject) {
            return
        }
        video.srcObject.getTracks().forEach((track) => track.stop())
        video.srcObject = null
    }

    this.send = (message) => {
        console.log(this.dataChannel)
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            this.dataChannel.send(message)
            // console.log(`Message is send ::: ${message}`)
        } else {
            console.log('WebRTC: Data channel is not open. Cannot send message.')
        }
    }
}
