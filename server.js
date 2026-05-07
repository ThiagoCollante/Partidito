const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const CANNON = require('cannon-es');

app.use(express.static('public'));
const rooms = {};

function createRoom(roomId) {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -15, 0) });
    
    const slipperyMaterial = new CANNON.Material('slippery');
    const slipperyContact = new CANNON.ContactMaterial(slipperyMaterial, slipperyMaterial, {
        friction: 0.0,  
        restitution: 0.0 
    });
    world.addContactMaterial(slipperyContact);

    const groundBody = new CANNON.Body({ 
        type: CANNON.Body.STATIC, 
        shape: new CANNON.Plane(),
        material: slipperyMaterial
    });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody);

    const objects = {};

    for (let i = 0; i < 15; i++) {
        const x = (Math.random() - 0.5) * 40;
        const z = (Math.random() - 0.5) * 40;
        if (Math.abs(x) < 5 && Math.abs(z) < 5) continue; 

        // Las cajas pesan "2". Con la fuerza que aplicaremos, saldrán volando.
        const box = new CANNON.Body({ mass: 2, shape: new CANNON.Box(new CANNON.Vec3(1, 1, 1)), position: new CANNON.Vec3(x, 2, z) });
        world.addBody(box); 
        objects[`box_${i}`] = { body: box, shape: 'box' };
    }

    rooms[roomId] = { world, players: {}, objects, slipperyMaterial };
}

io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        const roomId = data.roomId;
        if (!rooms[roomId]) createRoom(roomId);
        socket.join(roomId);
        socket.roomId = roomId;

        const room = rooms[roomId];

        const playerBody = new CANNON.Body({
            mass: 2,
            shape: new CANNON.Sphere(0.5),
            position: new CANNON.Vec3((Math.random() - 0.5) * 4, 2, (Math.random() - 0.5) * 4),
            fixedRotation: true,
            linearDamping: 0.0,
            material: room.slipperyMaterial 
        });
        
        playerBody.input = { keys: {}, yaw: 0 };
        playerBody.nickname = data.nickname; 
        
        room.world.addBody(playerBody);
        room.players[socket.id] = playerBody;
        socket.broadcast.to(roomId).emit('playerJoined', socket.id);
    });

    socket.on('input', (data) => {
        const room = rooms[socket.roomId];
        if (room && room.players[socket.id]) {
            room.players[socket.id].input = data;
        }
    });

    // --- NUEVO: SISTEMA DE ATAQUE / FLING ---
    socket.on('attack', () => {
        const room = rooms[socket.roomId];
        if (!room || !room.players[socket.id]) return;

        const playerBody = room.players[socket.id];
        const yaw = playerBody.input.yaw;

        // 1. Calcular el centro de la hitbox en el mundo (2.5 unidades al frente del jugador)
        const offset = 2.5; 
        const hitboxX = playerBody.position.x - Math.sin(yaw) * offset;
        const hitboxZ = playerBody.position.z - Math.cos(yaw) * offset;
        const hitboxRadius = 2.5; // Tamaño del área de efecto para agarrar las cajas

        // 2. Revisar qué objetos están dentro del área
        for (const objId in room.objects) {
            const objBody = room.objects[objId].body;
            
            const dx = objBody.position.x - hitboxX;
            const dy = objBody.position.y - playerBody.position.y;
            const dz = objBody.position.z - hitboxZ;
            
            // Distancia del objeto al centro de la hitbox
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

            if (dist <= hitboxRadius) {
                // Despertar el objeto físico por si el motor lo puso a "dormir" por inactividad
                objBody.wakeUp();

                // Calcular dirección del impulso (desde el jugador hacia el objeto para que salgan hacia afuera)
                const pushX = objBody.position.x - playerBody.position.x;
                const pushZ = objBody.position.z - playerBody.position.z;
                const pushDist = Math.sqrt(pushX*pushX + pushZ*pushZ);
                
                const normX = pushDist > 0 ? pushX / pushDist : 0;
                const normZ = pushDist > 0 ? pushZ / pushDist : 0;

                // APLICAR FUERZA BRUTAL (Fling)
                objBody.velocity.x = normX * 30; // Empuje horizontal X
                objBody.velocity.y = 15;         // Empuje vertical (hacia arriba)
                objBody.velocity.z = normZ * 30; // Empuje horizontal Z
                
                // Darles rotación aleatoria para que se vea más caótico
                objBody.angularVelocity.set(
                    (Math.random() - 0.5) * 20,
                    (Math.random() - 0.5) * 20,
                    (Math.random() - 0.5) * 20
                );
            }
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

        for (const id in room.players) {
            const body = room.players[id];
            const input = body.input;
            
            const delta = 1 / 30; 
            const friction = 10.0; 
            const speedMultiplier = 80.0; 

            body.velocity.x -= body.velocity.x * friction * delta;
            body.velocity.z -= body.velocity.z * friction * delta;

            let moveX = 0; let moveZ = 0;
            if (input.keys.w) { moveZ -= 1; }
            if (input.keys.s) { moveZ += 1; }
            if (input.keys.a) { moveX -= 1; }
            if (input.keys.d) { moveX += 1; }

            const length = Math.sqrt(moveX * moveX + moveZ * moveZ);
            if (length > 0) { moveX /= length; moveZ /= length; }

            const rotMoveX = moveX * Math.cos(input.yaw) + moveZ * Math.sin(input.yaw);
            const rotMoveZ = -moveX * Math.sin(input.yaw) + moveZ * Math.cos(input.yaw);

            body.velocity.x += rotMoveX * speedMultiplier * delta;
            body.velocity.z += rotMoveZ * speedMultiplier * delta;

            if (input.keys.space && Math.abs(body.velocity.y) < 0.1) {
                body.velocity.y = 8;
            }
        }

        room.world.step(1 / 30);

        const state = { players: {}, objects: {}, attacks: [] };
        
        for (const id in room.players) {
            const body = room.players[id];
            state.players[id] = { 
                x: body.position.x, 
                y: body.position.y - 0.5, 
                z: body.position.z,
                yaw: body.input.yaw,
                nickname: body.nickname 
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
