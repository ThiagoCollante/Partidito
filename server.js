const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const CANNON = require('cannon-es');

app.use(express.static('public'));
const rooms = {};

function createRoom(roomId) {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -15, 0) });
    
    const groundBody = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane() });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody);

    const objects = {};

    // Cajas de obstáculos esparcidas (Físicas del servidor)
    for (let i = 0; i < 15; i++) {
        const x = (Math.random() - 0.5) * 40;
        const z = (Math.random() - 0.5) * 40;
        if (Math.abs(x) < 5 && Math.abs(z) < 5) continue; // Despejar el centro

        const box = new CANNON.Body({ mass: 2, shape: new CANNON.Box(new CANNON.Vec3(1, 1, 1)), position: new CANNON.Vec3(x, 2, z) });
        world.addBody(box); 
        objects[`box_${i}`] = { body: box, shape: 'box' };
    }

    rooms[roomId] = { world, players: {}, objects };
}

io.on('connection', (socket) => {
    socket.on('joinRoom', (roomId) => {
        if (!rooms[roomId]) createRoom(roomId);
        socket.join(roomId);
        socket.roomId = roomId;

        // El jugador es una cápsula/esfera física de radio 0.5 (coincide con tu cilindro)
        const playerBody = new CANNON.Body({
            mass: 2,
            shape: new CANNON.Sphere(0.5),
            position: new CANNON.Vec3((Math.random() - 0.5) * 4, 2, (Math.random() - 0.5) * 4),
            fixedRotation: true,
            linearDamping: 0.9 // Fricción suave
        });
        playerBody.input = { keys: {}, yaw: 0 };
        
        rooms[roomId].world.addBody(playerBody);
        rooms[roomId].players[socket.id] = playerBody;
        socket.broadcast.to(roomId).emit('playerJoined', socket.id);
    });

    socket.on('input', (data) => {
        const room = rooms[socket.roomId];
        if (room && room.players[socket.id]) {
            room.players[socket.id].input = data;
        }
    });

    socket.on('disconnect', () => {
        const room = rooms[socket.roomId];
        if (room && room.players[socket.id]) {
            room.world.removeBody(room.players[socket.id]);
            delete room.players[socket.id];
            io.to(socket.roomId).emit('playerLeft', socket.id);
        }
    });
});

setInterval(() => {
    for (const roomId in rooms) {
        const room = rooms[roomId];

        // Lógica de movimiento con aceleración transferida desde tu código cliente
        for (const id in room.players) {
            const body = room.players[id];
            const input = body.input;
            
            const speedMultiplayer = 30.0;
            const delta = 1 / 30; // Tickrate
            let moveX = 0; let moveZ = 0;

            if (input.keys.w) { moveZ -= 1; }
            if (input.keys.s) { moveZ += 1; }
            if (input.keys.a) { moveX -= 1; }
            if (input.keys.d) { moveX += 1; }

            // Normalizar diagonales
            const length = Math.sqrt(moveX * moveX + moveZ * moveZ);
            if (length > 0) { moveX /= length; moveZ /= length; }

            // Aplicar rotación de cámara (yaw) al vector de movimiento
            const rotMoveX = moveX * Math.cos(input.yaw) + moveZ * Math.sin(input.yaw);
            const rotMoveZ = -moveX * Math.sin(input.yaw) + moveZ * Math.cos(input.yaw);

            body.velocity.x += rotMoveX * speedMultiplayer * delta;
            body.velocity.z += rotMoveZ * speedMultiplayer * delta;

            // Salto
            if (input.keys.space && Math.abs(body.velocity.y) < 0.1) {
                body.velocity.y = 8;
            }
        }

        room.world.step(1 / 30);

        const state = { players: {}, objects: {} };
        
        for (const id in room.players) {
            const body = room.players[id];
            state.players[id] = { 
                x: body.position.x, 
                y: body.position.y - 0.5, // Restamos 0.5 para que los pies de tu cilindro toquen el suelo
                z: body.position.z,
                yaw: body.input.yaw // Enviamos a dónde mira a los demás
            };
        }
        
        for (const id in room.objects) {
            const obj = room.objects[id].body;
            state.objects[id] = {
                shape: room.objects[id].shape,
                x: obj.position.x, y: obj.position.y, z: obj.position.z,
                qx: obj.quaternion.x, qy: obj.quaternion.y, qz: obj.quaternion.z, qw: obj.quaternion.w
            };
        }

        io.to(roomId).emit('gameState', state);
    }
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
