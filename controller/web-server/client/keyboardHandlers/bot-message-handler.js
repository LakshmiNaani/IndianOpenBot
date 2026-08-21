/*
 * Developed for the OpenBot project (https://openbot.org) by:
 *
 * Ivo Zivkov
 * izivkov@gmail.com
 *
 * Date: Mon Nov 29 2021
 */

import {WebRTC} from '../webRTC/webrtc.js'
import {ErrorDisplay} from '../utils/error-display.js'
import {Buttons} from './buttons.js'

export function BotMessageHandler (connection) {
    const webRtc = new WebRTC(connection)
    const buttons = new Buttons(connection)
    const errDisplay = new ErrorDisplay()

    webRtc.onDataMessageReceived((message) => {
        // Do something on data received;
    })

    // Webcam and mic default to on as soon as media is attached (see
    // attachLocalMedia in webrtc.js) and are independently toggleable. Wired
    // once since these buttons outlive individual calls. webRtc also reports
    // back through onWebcamStateChange/onMicStateChange when a track is
    // stopped from outside the app (e.g. the browser's camera/mic indicator),
    // so the icons stay accurate and clicking the button again restarts it.
    const webcamButton = document.getElementById('webcam_button')
    webcamButton.onclick = () => {
        webRtc.setWebcamEnabled(webcamButton.src.includes('videocam_off'))
    }
    webRtc.onWebcamStateChange((on) => {
        webcamButton.src = on ? 'icons/videocam_black_24dp.svg' : 'icons/videocam_off_black_24dp.svg'
    })

    const micButton = document.getElementById('mic_button')
    micButton.onclick = () => {
        webRtc.setMicEnabled(micButton.src.includes('mic_off'))
    }
    webRtc.onMicStateChange((on) => {
        micButton.src = on ? 'icons/mic_black_24dp.svg' : 'icons/mic_off_black_24dp.svg'
    })

    // Owns the only WebRTC instance, so anything that needs to tear the video
    // down (Escape, sign out) has to go through here.
    this.stopVideo = () => {
        webRtc.stop()
    }

    this.handle = (msg, connection) => {
        if (msg === undefined || msg === null) {
            return
        }

        const msgType = Object.keys(msg)[0]
        switch (msgType) {
            case 'VIDEO_PROTOCOL':
                if (msg.VIDEO_PROTOCOL !== 'WEBRTC') {
                    errDisplay.set('Only WebRTC video supported. Please set your andoid app for WebRTC')
                } else {
                    errDisplay.reset()
                }
                break

            case 'VIDEO_COMMAND':
                switch (msg.VIDEO_COMMAND) {
                    case 'START':
                        webRtc.start().catch((error) => {
                            errDisplay.set('Could not start the video connection. See the console for details.')
                            console.error('WebRTC: start failed:', error)
                        })
                        buttons.setMirrored(false)
                        break

                    case 'STOP':
                        webRtc.stop()
                        break
                }
                break

            case 'WEB_RTC_EVENT':
                webRtc.handle(msg.WEB_RTC_EVENT, connection)
                break
            case 'driveCmd' :
                connection.send(JSON.stringify(msg))
                // webRtc.send(JSON.stringify(msg))
                break

            case 'command' :
                connection.send(JSON.stringify(msg))
                // webRtc.send(JSON.stringify(msg))
                break

            default:
                // Process other status information here
                // This can be used to enhance the UI, for example
                // to display a blinking signal indicator, etc.
                break
        }
    }
}
