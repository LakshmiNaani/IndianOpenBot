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

    // The controller's own webcam/mic, sent to the robot so it can show the
    // operator's face. videoSender/audioSender are tied to the current
    // peerConnection and get re-bound on every reconnect (see attachLocalMedia);
    // videoTrack/audioTrack are the actual hardware captures and persist across
    // reconnects so toggling video/audio never needs a fresh permission prompt
    // unless the track was actually stopped (by us or by the browser).
    let videoTrack = null
    let audioTrack = null
    let videoSender = null
    let audioSender = null
    // What the user last asked for, independent of whether it is live right
    // now - reconnects restore to this, not to some hardcoded default.
    let webcamRequested = true
    let micRequested = true
    let onWebcamStateChanged = null
    let onMicStateChanged = null

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
                await attachLocalMedia()
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

    /**
     * Reserves sendrecv on the video/audio transceivers the robot's offer
     * already created, independent of whether a real track is attached yet.
     * This is what makes ensureTrack()/stopTrack() below able to turn the
     * webcam/mic fully on and off later purely via replaceTrack() - no
     * renegotiation is ever needed, which the robot side does not support.
     * Runs once per call, right before the answer is created.
     */
    const attachLocalMedia = async () => {
        for (const transceiver of peerConnection.getTransceivers()) {
            const kind = transceiver.receiver && transceiver.receiver.track && transceiver.receiver.track.kind
            if (kind !== 'video' && kind !== 'audio') {
                continue
            }
            transceiver.direction = 'sendrecv'
            if (kind === 'video') {
                videoSender = transceiver.sender
            } else {
                audioSender = transceiver.sender
            }
        }

        if (webcamRequested) {
            await ensureTrack('video')
        }
        if (micRequested) {
            await ensureTrack('audio')
        }
    }

    /**
     * Turns a webcam/mic track on: reuses it if still live (e.g. across a
     * reconnect, just re-bound to the new peer connection's sender), otherwise
     * prompts for a fresh capture. Denial/failure is non-fatal - the robot's
     * own feed still plays either way.
     */
    const ensureTrack = async (kind) => {
        let track = kind === 'video' ? videoTrack : audioTrack

        if (!track || track.readyState !== 'live') {
            try {
                const constraints = kind === 'video' ? {video: true} : {audio: true}
                const stream = await navigator.mediaDevices.getUserMedia(constraints)
                track = kind === 'video' ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0]
                // Fires when the browser itself stops the track - e.g. the
                // camera/mic indicator in the address bar - so the UI can
                // reflect it and the user can restart it from the buttons.
                track.onended = () => handleTrackEndedExternally(kind)
            } catch (error) {
                console.error(`WebRTC: could not access the ${kind === 'video' ? 'webcam' : 'microphone'}:`, error)
                notifyState(kind, false)
                return
            }
            if (kind === 'video') {
                videoTrack = track
            } else {
                audioTrack = track
            }
        }

        const sender = kind === 'video' ? videoSender : audioSender
        if (sender) {
            try {
                await sender.replaceTrack(track)
            } catch (error) {
                console.error(`WebRTC: could not attach the ${kind} track:`, error)
            }
        }

        if (kind === 'video') {
            updateSelfVideo()
            showSelfVideo(true)
        }
        notifyState(kind, true)
    }

    /**
     * Turns a webcam/mic track fully off: stops the hardware capture (so the
     * browser's camera/mic indicator actually clears) and clears the sender,
     * without renegotiating.
     */
    const stopTrack = (kind) => {
        const track = kind === 'video' ? videoTrack : audioTrack
        const sender = kind === 'video' ? videoSender : audioSender

        if (track) {
            track.onended = null // this is us stopping it, not an external interruption
            track.stop()
        }
        if (sender) {
            sender.replaceTrack(null).catch((error) => console.error('WebRTC: could not clear sender track:', error))
        }

        if (kind === 'video') {
            videoTrack = null
            showSelfVideo(false)
        } else {
            audioTrack = null
        }
        notifyState(kind, false)
    }

    /**
     * The browser (not us) ended a track - most commonly the user clicked
     * "stop" on the camera/mic indicator in the address bar. Reflect it in the
     * UI and in what the next reconnect should do: do not silently reacquire
     * something the user was never asked about again.
     */
    const handleTrackEndedExternally = (kind) => {
        console.warn(`WebRTC: ${kind} was stopped outside the app (e.g. the browser's camera/mic indicator)`)
        const sender = kind === 'video' ? videoSender : audioSender
        if (sender) {
            sender.replaceTrack(null).catch(() => {})
        }
        if (kind === 'video') {
            videoTrack = null
            webcamRequested = false
            showSelfVideo(false)
        } else {
            audioTrack = null
            micRequested = false
        }
        notifyState(kind, false)
    }

    const notifyState = (kind, on) => {
        if (kind === 'video' && onWebcamStateChanged) {
            onWebcamStateChanged(on)
        }
        if (kind === 'audio' && onMicStateChanged) {
            onMicStateChanged(on)
        }
    }

    const updateSelfVideo = () => {
        // Picture-in-picture of the operator's own feed, so they can see what
        // the robot sees them see. Muted - it's a preview of the outgoing
        // stream, playing it back would just echo the operator's own mic.
        const selfVideo = document.getElementById('self-video')
        if (selfVideo && videoTrack) {
            selfVideo.srcObject = new MediaStream([videoTrack])
        }
    }

    const showSelfVideo = (visible) => {
        const container = document.getElementById('self-video-container')
        if (container) {
            container.style.display = visible ? 'block' : 'none'
        }
    }

    /** Turns the operator's webcam on/off. Independent of the mic. */
    this.setWebcamEnabled = (enabled) => {
        webcamRequested = enabled
        if (!peerConnection) {
            return
        }
        if (enabled) {
            ensureTrack('video')
        } else {
            stopTrack('video')
        }
    }

    /** Turns the operator's mic on/off. Independent of the webcam. */
    this.setMicEnabled = (enabled) => {
        micRequested = enabled
        if (!peerConnection) {
            return
        }
        if (enabled) {
            ensureTrack('audio')
        } else {
            stopTrack('audio')
        }
    }

    // Fires whenever the on/off state changes for a reason other than the
    // caller's own setWebcamEnabled()/setMicEnabled() call - i.e. when the
    // browser itself stopped the track - so the UI buttons can stay in sync.
    this.onWebcamStateChange = (callback) => {
        onWebcamStateChanged = callback
    }
    this.onMicStateChange = (callback) => {
        onMicStateChanged = callback
    }

    this.isWebcamAvailable = () => !!videoTrack

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
        // Senders belong to the old peer connection and are invalid here;
        // attachLocalMedia() re-binds videoTrack/audioTrack to fresh ones
        // on the new one once the robot's offer arrives.
        videoSender = null
        audioSender = null
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

        if (videoTrack) {
            videoTrack.onended = null
            videoTrack.stop()
            videoTrack = null
        }
        if (audioTrack) {
            audioTrack.onended = null
            audioTrack.stop()
            audioTrack = null
        }
        videoSender = null
        audioSender = null
        const selfVideo = document.getElementById('self-video')
        if (selfVideo) {
            selfVideo.srcObject = null
        }
        showSelfVideo(false)
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
