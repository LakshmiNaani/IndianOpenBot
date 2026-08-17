/*
 * End-to-end checks for the signaling server's room handling.
 *
 * Starts a real server on port 8080, drives it with real websocket clients, and
 * asserts on what each client receives. Run with:
 *
 *   npm test            (from controller/web-server/server)
 */

const WebSocket = require('ws');
const {spawn} = require('child_process');
const path = require('path');

const URL = 'ws://localhost:8080';
const ROOM_A = 'controller-a@example.com';
const ROOM_B = 'controller-b@example.com';

let failures = 0;

const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (got ${actual}, expected ${expected})`);
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

// Collects everything the client receives, ignoring the server's join prompt.
const connect = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.received = [];
    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.roomId === 'request-roomId') {
            return;
        }
        ws.received.push(msg);
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
});

const join = (ws, room) => ws.send(JSON.stringify({roomId: room}));
const leave = (ws, room) => ws.send(JSON.stringify({leave: room}));
const broadcast = (ws, room, value) => ws.send(JSON.stringify({status: {TEST: value}, roomId: room}));
// The controller's WebRTC answers and candidates carry no roomId
const sendWebRtcEvent = (ws, value) => ws.send(JSON.stringify({webrtc_event: value}));

const startServer = async () => {
    // Refuse to run against something already on the port. A stale server would
    // bind first, our own would exit on EADDRINUSE, and the whole suite would
    // silently assert against whatever code that other process is running.
    try {
        const stale = await connect();
        stale.close();
        throw new Error('port 8080 is already in use - stop the running server first');
    } catch (error) {
        if (error.message.includes('already in use')) {
            throw error;
        }
    }

    const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {stdio: 'ignore'});
    for (let attempt = 0; attempt < 40; attempt++) {
        try {
            const probe = await connect();
            probe.close();
            return server;
        } catch (error) {
            await settle();
        }
    }
    server.kill();
    throw new Error('server did not start');
};

const testLeaveAndRejoin = async () => {
    console.log('\n-- leave and rejoin --');
    const robot = await connect();
    const controller = await connect();

    join(robot, ROOM_A);
    join(controller, ROOM_A);
    await settle();

    broadcast(robot, ROOM_A, 'one');
    await settle();
    check('controller receives while joined', controller.received.length, 1);

    // signing out
    leave(controller, ROOM_A);
    await settle();

    broadcast(robot, ROOM_A, 'two');
    await settle();
    check('controller receives nothing after leaving', controller.received.length, 1);
    check('robot still in its room', robot.received.length, 2);

    // signing back in reuses the same socket, no reconnect
    join(controller, ROOM_A);
    await settle();

    broadcast(robot, ROOM_A, 'three');
    await settle();
    check('controller receives again after rejoining', controller.received.length, 2);

    // leaving twice must not throw or disturb the room
    leave(controller, ROOM_A);
    leave(controller, ROOM_A);
    await settle();
    broadcast(robot, ROOM_A, 'four');
    await settle();
    check('robot unaffected by repeated leaves', robot.received.length, 4);

    robot.close();
    controller.close();
    await settle();
};

const testRoomIsolation = async () => {
    console.log('\n-- room isolation --');
    const robotA = await connect();
    const controllerA = await connect();
    const robotB = await connect();
    const controllerB = await connect();

    join(robotA, ROOM_A);
    join(controllerA, ROOM_A);
    join(robotB, ROOM_B);
    join(controllerB, ROOM_B);
    await settle();

    // A message with a roomId stays in its room
    broadcast(robotA, ROOM_A, 'for-a');
    await settle();
    check('controller A receives room A traffic', controllerA.received.length, 1);
    check('controller B receives no room A traffic', controllerB.received.length, 0);
    check('robot B receives no room A traffic', robotB.received.length, 0);

    // A message with no roomId is routed by the sender's room, not globally
    sendWebRtcEvent(controllerA, 'answer-a');
    await settle();
    check('robot A receives the webrtc event', robotA.received.length, 2);
    check('robot B receives no webrtc event', robotB.received.length, 0);
    check('controller B receives no webrtc event', controllerB.received.length, 0);
    check('sender does not receive its own event', controllerA.received.length, 1);

    robotA.close();
    controllerA.close();
    robotB.close();
    controllerB.close();
    await settle();
};

const testDisconnectKeepsRoom = async () => {
    console.log('\n-- disconnect leaves the peer in place --');
    const robot = await connect();
    const controller = await connect();

    join(robot, ROOM_A);
    join(controller, ROOM_A);
    await settle();

    controller.close();
    await settle();

    // The room used to be deleted outright here, orphaning the robot
    const rejoined = await connect();
    join(rejoined, ROOM_A);
    await settle();

    broadcast(robot, ROOM_A, 'after-reconnect');
    await settle();
    check('reconnecting controller reaches the original robot', rejoined.received.length, 1);

    robot.close();
    rejoined.close();
    await settle();
};

// The robot never sends a bare {roomId} join - it only tags its status messages
// with the room. It must still receive the controller's answer, which carries no
// roomId at all.
const testRobotThatNeverJoins = async () => {
    console.log('\n-- robot that only tags messages with roomId --');
    const robot = await connect();
    const controller = await connect();

    join(controller, ROOM_A);
    await settle();
    broadcast(robot, ROOM_A, 'offer-ish');
    await settle();
    check('controller receives the robot traffic', controller.received.length, 1);

    const robotBefore = robot.received.length;
    sendWebRtcEvent(controller, 'answer');
    await settle();
    check('robot receives the answer', robot.received.length, robotBefore + 1);

    robot.close();
    controller.close();
    await settle();
};

(async () => {
    const server = await startServer();
    try {
        await testRobotThatNeverJoins();
        await testLeaveAndRejoin();
        await testRoomIsolation();
        await testDisconnectKeepsRoom();
    } finally {
        server.kill();
    }

    console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
})();
