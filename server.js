const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the frontend game files from the "public" folder
app.use(express.static('public'));

const rooms = {};

io.on('connection', (socket) => {
    // 1. Handle Room Creation
    socket.on('create-room', (data) => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = { 
            host: socket.id, 
            players: {}, 
            ball: { x: 5, y: 0.4, z: 2, vx: 0, vy: 0, vz: 0, possessor: null } 
        };
        socket.join(roomCode);
        rooms[roomCode].players[socket.id] = { nickname: data.nickname, x: -20, y: 0, z: 0, rotX: 0, rotY: 0, timestamp: Date.now() };
        
        socket.emit('room-created', { roomCode, isHost: true, id: socket.id });
    });

    // 2. Handle Joining Rooms
    socket.on('join-room', (data) => {
        if (rooms[data.roomCode]) {
            socket.join(data.roomCode);
            rooms[data.roomCode].players[socket.id] = { nickname: data.nickname, x: 20, y: 0, z: 0, rotX: 0, rotY: 0, timestamp: Date.now() };
            socket.emit('room-joined', { roomCode: data.roomCode, isHost: false, id: socket.id });
        } else {
            socket.emit('error', 'Room not found.');
        }
    });

    // 3. Receive Player Updates
    socket.on('player-update', (data) => {
        const room = rooms[data.roomCode];
        if (room && room.players[socket.id]) {
            room.players[socket.id].x = data.x;
            room.players[socket.id].y = data.y;
            room.players[socket.id].z = data.z;
            room.players[socket.id].rotX = data.rotX;
            room.players[socket.id].rotY = data.rotY;
            room.players[socket.id].timestamp = Date.now();
        }
    });

    // 4. Receive Ball Updates
    socket.on('ball-update', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            room.ball.x = data.x; room.ball.y = data.y; room.ball.z = data.z;
            room.ball.vx = data.vx; room.ball.vy = data.vy; room.ball.vz = data.vz;
            room.ball.possessor = data.possessor;
        }
    });

    // Handle Disconnects
    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            if (rooms[roomCode].players[socket.id]) {
                delete rooms[roomCode].players[socket.id];
            }
        }
    });
});

// Broadcast Loop: Send state to all players 20 times per second
setInterval(() => {
    for (const roomCode in rooms) {
        io.to(roomCode).emit('sync-state', {
            players: rooms[roomCode].players,
            ball: rooms[roomCode].ball
        });
    }
}, 50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game Server running on port ${PORT}`));