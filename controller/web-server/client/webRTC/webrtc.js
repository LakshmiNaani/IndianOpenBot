/**
 * function to enable webRTC connection
 * @param connection
 * @constructor
 */
export function WebRTC (connection) {
    const {RTCPeerConnection} = window

    let peerConnection = null
    let onDataMessageReceivedCallback = null

    this.onDataMessageReceived = (callback) => {
        onDataMessageReceivedCallback = callback
    }

    this.handle = (data) => {
        if (!peerConnection) {
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
        connection.send(JSON.stringify({webrtc_event: answer}))
    }

    // starting webrtc connection
    this.start = () => {
        console.log('WebRTC: start...')

        peerConnection = new RTCPeerConnection()
        peerConnection.onconnectionstatechange = () => {
            console.log('WebRTC connectionState:', peerConnection?.connectionState)
            if (peerConnection?.connectionState === 'connected') {
            }
        }
        peerConnection.oniceconnectionstatechange = () => {
            console.log('WebRTC iceConnectionState:', peerConnection?.iceConnectionState)
        }
        peerConnection.onicegatheringstatechange = () => {
            console.log('WebRTC iceGatheringState:', peerConnection?.iceGatheringState)
        }

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
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
            console.log('WebRTC ontrack: received remote track', event.track.kind)
            video.srcObject = event.streams[0]
        }
    }

    this.stop = () => {
        console.log('WebRTC: stop...')

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
