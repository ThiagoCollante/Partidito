const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const CANNON = require('cannon-es');

app.use(express.static('public'));

const rooms = {};

function createRoom(roomId) {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    
    // Material del suelo con un poco de fricción para los objetos sueltos
    const groundMat = new CANNON.Material();
    const groundBody = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Plane(),
        material: groundMat
    });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody);

    const objects = {};

    // 1. La Caja Original
    const box = new CANNON.Body({
        mass: 5,
        shape: new CANNON.Box(new CANNON.Vec3(1, 1, 1)),
        position: new CANNON.Vec3(0, 5, -5)
    });
    world.addBody(box);
    objects['box1'] = { body: box, shape: 'box' };

    // 2. La Esfera Nueva
    const sphere = new CANNON.Body({
        mass: 3,
        shape: new CANNON.Sphere(1.5),
        position: new CANNON.Vec3(5, 5, -5)
    });
    world.addBody(sphere);
    objects['sphere1'] = { body: sphere, shape: 'sphere' };

    // 3. La Pirámide Nueva (Cannon la simula como un Cilindro de 4 lados)
    // Orientación especial porque Cannon crea cilindros apuntando hacia Z por defecto
    const pyramidShape = new CANNON.Cylinder(0.01, 2, 3, 4); 
    const pyramid = new CANNON.Body({
        mass: 4,
        shape: pyramidShape,
        position: new CANNON.Vec3(-5, 5, -5)
    });
    // Rotar para que la punta mire hacia arriba (eje Y)
    pyramid.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    world.addBody(pyramid);
    objects['pyramid1'] = { body: pyramid, shape: 'pyramid' };

    rooms[roomId] = { world, players: {}, objects };
}

io.on('connection', (socket) => {
    socket.on('joinRoom', (roomId) => {
        if (!rooms[roomId]) createRoom(roomId);
        socket.join(roomId);
        socket.roomId = roomId;

        const playerBody = new CANNON.Body({
            mass: 2,
            shape: new CANNON.Sphere(1),
            position: new CANNON.Vec3(0, 2, 5),
            fixedRotation: true // CRÍTICO: Evita que el jugador ruede como pelota
        });
        playerBody.input = { keys: {}, yaw: 0 };
        
        rooms[roomId].world.addBody(playerBody);
        rooms[roomId].players[socket.id] = playerBody;
        socket.broadcast.to(roomId).emit('playerJoined', socket.id);
    });

    // En lugar de aplicar fuerza instantánea, guardamos el input y el ángulo de la cámara
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

// Bucle Físico del Servidor (30 FPS)
setInterval(() => {
    for (const roomId in rooms) {
        const room = rooms[roomId];

        // Procesar movimiento "Kinematic-like" de los jugadores (Sin fricción resbaladiza)
        for (const id in room.players) {
            const body = room.players[id];
            const input = body.input;
            const speed = 12; // Velocidad del jugador

            let vx = 0;
            let vz = 0;

            // Calcular dirección de movimiento en base hacia dónde mira la cámara (yaw)
            if (input.keys.w) { vx -= Math.sin(input.yaw); vz -= Math.cos(input.yaw); }
            if (input.keys.s) { vx += Math.sin(input.yaw); vz += Math.cos(input.yaw); }
            if (input.keys.a) { vx -= Math.cos(input.yaw); vz += Math.sin(input.yaw); }
            if (input.keys.d) { vx += Math.cos(input.yaw); vz -= Math.sin(input.yaw); }

            // Normalizar vectores diagonales para no correr más rápido en diagonal
            const length = Math.sqrt(vx * vx + vz * vz);
            if (length > 0) {
                vx = (vx / length) * speed;
                vz = (vz / length) * speed;
            }

            // Aplicar velocidad X y Z directamente. La Y la controla la gravedad.
            body.velocity.x = vx;
            body.velocity.z = vz;
        }

        room.world.step(1 / 30);

        const state = { players: {}, objects: {} };
        
        for (const id in room.players) {
            state.players[id] = { x: room.players[id].position.x, y: room.players[id].position.y, z: room.players[id].position.z };
        }
        
        for (const id in room.objects) {
            const obj = room.objects[id].body;
            state.objects[id] = {
                shape: room.objects[id].shape, // Le decimos al cliente qué dibujar
                x: obj.position.x, y: obj.position.y, z: obj.position.z,
                qx: obj.quaternion.x, qy: obj.quaternion.y, qz: obj.quaternion.z, qw: obj.quaternion.w
            };
        }

        io.to(roomId).emit('gameState', state);
    }
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
