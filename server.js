const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const CANNON = require('cannon-es');

app.use(express.static('public'));

// Almacenamos las salas y sus mundos físicos
const rooms = {};

function createRoom(roomId) {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    
    // Suelo
    const groundBody = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Plane()
    });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody);

    // Objeto físico de prueba (una caja interactuable)
    const boxBody = new CANNON.Body({
        mass: 5,
        shape: new CANNON.Box(new CANNON.Vec3(1, 1, 1)),
        position: new CANNON.Vec3(0, 5, 5)
    });
    world.addBody(boxBody);

    rooms[roomId] = {
        world,
        players: {},
        objects: { 'box1': boxBody }
    };
}

io.on('connection', (socket) => {
    socket.on('joinRoom', (roomId) => {
        if (!rooms[roomId]) createRoom(roomId);
        
        socket.join(roomId);
        socket.roomId = roomId;

        // Crear cuerpo físico para el jugador
        const playerBody = new CANNON.Body({
            mass: 1, // Masa 1 para que reaccione, o KINEMATIC si quieres control absoluto
            shape: new CANNON.Sphere(1),
            position: new CANNON.Vec3(Math.random() * 4 - 2, 2, 0),
            linearDamping: 0.9 // Fricción del aire para frenar
        });
        rooms[roomId].world.addBody(playerBody);
        rooms[roomId].players[socket.id] = playerBody;

        // Informar a los demás
        socket.broadcast.to(roomId).emit('playerJoined', socket.id);
    });

    socket.on('move', (input) => {
        const room = rooms[socket.roomId];
        if (!room || !room.players[socket.id]) return;

        const body = room.players[socket.id];
        const speed = 10;
        
        // Aplicar impulsos basados en el input del cliente
        if (input.up) body.applyForce(new CANNON.Vec3(0, 0, -speed), body.position);
        if (input.down) body.applyForce(new CANNON.Vec3(0, 0, speed), body.position);
        if (input.left) body.applyForce(new CANNON.Vec3(-speed, 0, 0), body.position);
        if (input.right) body.applyForce(new CANNON.Vec3(speed, 0, 0), body.position);
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

// Bucle de físicas del servidor (Tickrate: 30 FPS)
setInterval(() => {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        room.world.step(1 / 30); // Avanzar el mundo físico

        // Recopilar estado para enviar a los clientes
        const state = { players: {}, objects: {} };
        
        for (const id in room.players) {
            state.players[id] = {
                x: room.players[id].position.x,
                y: room.players[id].position.y,
                z: room.players[id].position.z
            };
        }
        
        for (const id in room.objects) {
            state.objects[id] = {
                x: room.objects[id].position.x,
                y: room.objects[id].position.y,
                z: room.objects[id].position.z,
                qx: room.objects[id].quaternion.x,
                qy: room.objects[id].quaternion.y,
                qz: room.objects[id].quaternion.z,
                qw: room.objects[id].quaternion.w,
            };
        }

        io.to(roomId).emit('gameState', state);
    }
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
