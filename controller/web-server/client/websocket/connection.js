/*
 * Developed for the OpenBot project (https://openbot.org) by:
 *
 * Ivo Zivkov
 * izivkov@gmail.com
 *
 * Date: Mon Nov 29 2021
 */

import {ErrorDisplay} from '../utils/error-display.js'

// Render's free tier sleeps the signaling server after ~15 min idle and can
// take up to a minute to wake back up on the next connection attempt.
const SLOW_CONNECTION_TIMEOUT_MS = 8000

/**
 * function to connect websocket to remote server
 * @constructor
 */
export function Connection () {
    const connectToServer = (errDisplay) => {
        const signalingServerUrl = import.meta.env.VITE_PUBLIC_SIGNALING_SERVER_URL || `ws://${window.location.hostname}:8080/ws`
        errDisplay.set('Connecting to server...')
        const ws = new WebSocket(signalingServerUrl)

        return new Promise((resolve, reject) => {
            const slowConnectionTimer = setTimeout(() => {
                errDisplay.set('Still connecting - the server may be waking up from sleep, this can take up to a minute...')
            }, SLOW_CONNECTION_TIMEOUT_MS)

            ws.onopen = () => {
                clearTimeout(slowConnectionTimer)
                ws.onerror = null
                errDisplay.reset()
                resolve(ws)
            }

            ws.onerror = () => {
                clearTimeout(slowConnectionTimer)
                errDisplay.set('Could not connect to the server. Please reload the page.')
                reject(new Error('Failed to connect to signaling server'))
            }
        })
    }

    const sendToBot = (message) => {
        this.send(message)
    }

    this.start = async (onData) => {
        const errDisplay = new ErrorDisplay()
        let ws = await connectToServer(errDisplay)
        this.send = (data) => {
            if (ws) {
                console.log(('sending to server' + data))
                ws.send(data)
            }
        }
        let idSent = false

        ws.onmessage = (webSocketMessage) => {
            const msg = JSON.parse(webSocketMessage.data)
            if (Object.keys(msg)[0] === 'roomId' && !idSent) {
                idSent = true
            } else {
                console.log(webSocketMessage.data)
                console.log('Data Displayed')
                onData(webSocketMessage.data)
            }
        }

        ws.onclose = (event) => {
            console.log(`WebSocket closed: code=${event.code} reason="${event.reason || 'none'}" wasClean=${event.wasClean} tabVisibility=${document.visibilityState} online=${navigator.onLine}`)
            errDisplay.set('Disconnected from the server. To reconnect, reload this page.')
            idSent = false
        }

        ws.onerror = (event) => {
            console.log('WebSocket error after connection was established:', event)
        }

        ws.onopen = () => {
            errDisplay.reset()
            idSent = false
        }

        this.stop = () => {
            if (ws != null) {
                ws.close()
                ws = null
            }
        }
    }
}
