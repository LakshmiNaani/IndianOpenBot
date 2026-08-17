const WebSocket = require('ws');

// Render (and most hosts) assign the port via the environment; 8080 is the
// local/LAN default the client falls back to.
const PORT = process.env.PORT || 8080;

const wss = new WebSocket.Server({ port: PORT }, () => {
    console.log(`Signaling server is now listening on port ${PORT}`);
});
let rooms = new Map();
wss.on('connection', (ws) => {
    console.log(`Client connected. Total connected clients: ${wss.clients.size}`);
    askIdOfClient(ws);
    ws.on("message", function message(data, isBinary) {

        const message = isBinary ? data : data.toString();
        // console.log(JSON.parse(message));
        let msg = JSON.parse(message);

        if (Object.keys(msg)[0] === 'roomId') {
            createOrJoinRoom(msg.roomId, ws);
            ws.id = msg.roomId;
            return;
        }
        else if (Object.keys(msg)[0] === 'leave') {
            // Sent when a client signs out. Without this the only way out of a
            // room is disconnecting, so a signed-out controller keeps receiving
            // everything the robot broadcasts.
            leaveRoom(ws);
            return;
        }
        else if (Object.keys(msg)[0] === 'driveCmd') {
            let driveCmd = msg.driveCmd;
            console.log(driveCmd);
        }
        else if ('command') {
            // You may add additional checks for different message types.
        }

        // The robot never sends a bare {roomId} join message; it only tags its
        // status messages with the room. Register it the first time we see a
        // roomId from it, otherwise it is not a room member and anything routed
        // by room - such as the controller's answer - never reaches it.
        if (msg.roomId !== undefined && ws.id === undefined) {
            createOrJoinRoom(msg.roomId, ws);
            ws.id = msg.roomId;
        }

        if (msg.roomId === undefined) {
            // Messages that carry no roomId - the controller's webrtc_event
            // answers and candidates - go to the sender's own room. This used to
            // broadcast to every connected client, so one controller's signaling
            // reached every robot on the server.
            sendToRoom(ws.id, message, ws);
            return;
        }

        // Broadcast the message to clients within the same room based on the roomId.
        sendToRoom(msg.roomId, message);
    });


    const sendToRoom = (roomId, message, exclude) => {
        console.log("roomId: ", roomId);
        let room = rooms.get(roomId);

        if (room) {
            // Broadcast the message to all non-null clients in the room.
            broadcastToRoom(room, message, exclude);
        } else {
            console.log("Room not found for roomId:", roomId);
        }
    }


    ws.onclose = (socket) => {
        console.log(`Client disconnected. Total connected clients: ${wss.clients.size}`);
        // Remove only this client. Deleting the whole room here used to orphan
        // the other peer, which then kept broadcasting into a room that no
        // longer existed.
        leaveRoom(ws);
    };

});

// Function to ask for client's roomId
const askIdOfClient = (ws) => {
    let request = {
        roomId: "request-roomId"
    };
    ws.send(JSON.stringify(request));
};

const createOrJoinRoom = (roomId, ws) => {
    let room = rooms.get(roomId);

    // Room does not exist yet
    if (room === undefined) {
        rooms.set(roomId, {clients: [ws, null]});
        return;
    }

    // Already in the room, e.g. the client re-sent its roomId
    if (room.clients.includes(ws)) {
        return;
    }

    // Free any slots held by sockets that have since closed, so a reconnecting
    // client is not locked out by its own stale entry.
    room.clients = room.clients.map(
        (client) => (client && client.readyState === WebSocket.OPEN ? client : null)
    );

    const freeSlot = room.clients.indexOf(null);
    if (freeSlot === -1) {
        // Previously the room was replaced outright here, which silently evicted
        // both existing peers - a reconnecting controller would kick the robot out.
        console.log("Room is full, refusing to join:", roomId);
        return;
    }

    console.log("joining to the room", roomId);
    room.clients[freeSlot] = ws;
    rooms.set(roomId, room);
};

/**
 * Removes a single client from its room, deleting the room once it is empty.
 * Safe to call for a client that never joined.
 */
const leaveRoom = (ws) => {
    const roomId = ws.id;
    ws.id = undefined;

    if (roomId === undefined) {
        return;
    }

    let room = rooms.get(roomId);
    if (room === undefined) {
        return;
    }

    room.clients = room.clients.map((client) => (client === ws ? null : client));

    if (room.clients.every((client) => client === null)) {
        rooms.delete(roomId);
        console.log("Room now empty, removed:", roomId);
    } else {
        rooms.set(roomId, room);
        console.log("Client left room:", roomId);
    }
};

// Broadcast to all clients in a specific room, optionally skipping the sender.
const broadcastToRoom = (room, message, exclude) => {
    room.clients.forEach((client) => {
        if (client && client !== exclude && client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
};
