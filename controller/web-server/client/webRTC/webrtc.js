import {CameraSwitchDisplay} from '../utils/camera-switch-display.js'

/**
 * function to enable webRTC connection
 * @param connection
 * @param viewerId identifies this browser to the signaling server/robot among other viewers
 * @constructor
 */
export function WebRTC (connection, viewerId) {
    const {RTCPeerConnection} = window

    let peerConnection = null
    let onDataMessageReceivedCallback = null
    let telemetryInterval = null
    let cameraSwitchStartTime = null
    const cameraSwitchDisplay = new CameraSwitchDisplay()

    this.onDataMessageReceived = (callback) => {
        onDataMessageReceivedCallback = callback
    }

    // Called when the camera-switch button is clicked, so we can time how long it
    // takes the new camera's frames to actually reach the video feed.
    this.markCameraSwitchStart = () => {
        cameraSwitchStartTime = performance.now()
    }

    this.handle = (data, senderViewerId) => {
        if (!peerConnection) {
            return
        }
        // A room can hold multiple viewers; ignore signaling meant for someone else's session.
        if (senderViewerId !== undefined && senderViewerId !== viewerId) {
            return
        }

        const {RTCSessionDescription, RTCIceCandidate} = window
        let webRtcEvent
        console.log(typeof data)
        if (typeof data === 'string') {
            webRtcEvent = JSON.parse(data)
        } else {
            webRtcEvent = data
        }
        // WebRTC type
        switch (webRtcEvent.type) {
            case 'offer':
                peerConnection.setRemoteDescription(
                    new RTCSessionDescription({sdp: webRtcEvent.sdp, type: 'offer'})
                )
                doAnswer()
                break

            case 'candidate': {
                const candidate = new RTCIceCandidate({
                    candidate: webRtcEvent.candidate,
                    sdpMid: webRtcEvent.id,
                    sdpMLineIndex: webRtcEvent.label
                })
                peerConnection.addIceCandidate(candidate)
                break
            }

            case 'bye':
                this.stop()
                break
        }
    }

    const doAnswer = async () => {
        const answer = await peerConnection.createAnswer()
        await peerConnection.setLocalDescription(answer)
        connection.send(JSON.stringify({webrtc_event: answer, viewerId}))
    }

    // WebRTC Latency Telemetry Pipeline: logs and displays the active connection's RTT every 15s.
    const startLatencyTelemetry = () => {
        if (telemetryInterval) {
            clearInterval(telemetryInterval)
        }
        telemetryInterval = setInterval(() => {
            if (!peerConnection || peerConnection.connectionState !== 'connected') {
                return
            }
            peerConnection.getStats(null).then((stats) => {
                stats.forEach((report) => {
                    // The transport report points at whichever candidate-pair is
                    // actually carrying traffic, unlike scanning all 'succeeded' pairs.
                    if (report.type === 'transport' && report.selectedCandidatePairId) {
                        const activePair = stats.get(report.selectedCandidatePairId)
                        if (activePair && typeof activePair.currentRoundTripTime === 'number') {
                            const latencyMs = activePair.currentRoundTripTime * 1000
                            console.log(`[Telemetry] Active WebRTC RTT Latency: ${latencyMs.toFixed(2)} ms`)
                        }
                    }
                })
            })
        }, 15000) // 15000 milliseconds = 15 seconds
    }

    // starting webrtc connection
    this.start = () => {
        console.log('WebRTC: start...')

        peerConnection = new RTCPeerConnection()
        peerConnection.onconnectionstatechange = () => {
            if (peerConnection?.connectionState === 'connected') {
            }
        }

        // The robot already sends its candidates; without also sending ours back, the robot
        // only learns its own reachable addresses and ICE connectivity checks can't complete
        // once robot and viewer aren't on the same trivially-reachable network.
        peerConnection.onicecandidate = (event) => {
            if (!event.candidate) {
                return
            }
            connection.send(JSON.stringify({
                webrtc_event: {
                    type: 'candidate',
                    label: event.candidate.sdpMLineIndex,
                    id: event.candidate.sdpMid,
                    candidate: event.candidate.candidate
                },
                viewerId
            }))
        }

        startLatencyTelemetry()

        this.dataChannel = peerConnection.createDataChannel('dataChannel') // Use this.dataChannel to set it as a property
        console.log("readyState::", this.dataChannel.readyState)
        console.log('DataChannel Open:::', this.dataChannel.onopen)
        console.log('DataChannel On Message:::', this.dataChannel.onmessage)

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
            video.srcObject = event.streams[0]

            // Switching the robot's camera briefly stalls frame delivery on this same
            // track (its ID doesn't change), which the browser surfaces as mute/unmute -
            // that's what we use to detect when the new camera's feed actually arrives.
            if (event.track.kind === 'video') {
                event.track.onunmute = () => {
                    if (cameraSwitchStartTime !== null) {
                        const durationMs = performance.now() - cameraSwitchStartTime
                        console.log(`[Telemetry] Camera switch took: ${durationMs.toFixed(0)} ms`)
                        cameraSwitchDisplay.set(`Camera switch: ${durationMs.toFixed(0)} ms`)
                        cameraSwitchStartTime = null
                    }
                }
            }
        }
    }

    this.stop = () => {
        console.log('WebRTC: stop...')

        if (telemetryInterval) {
            clearInterval(telemetryInterval)
            telemetryInterval = null
        }
        cameraSwitchDisplay.reset()
        cameraSwitchStartTime = null

        if (peerConnection) {
            peerConnection.close()
        }
        peerConnection = null
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
