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

        const sphere = new CANNON.Body({ mass: 2, shape: new CANNON.Sphere(1), position: new CANNON.Vec3(x, 2, z) });
        world.addBody(sphere); 
        objects[`ball_${i}`] = { body: sphere, shape: 'sphere' };
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

    // --- NUEVO SISTEMA DE FLING 3D REALISTA ---
    socket.on('attack', () => {
        const room = rooms[socket.roomId];
        if (!room || !room.players[socket.id]) return;

        const playerBody = room.players[socket.id];
        const hitboxRadius = 2.5; 

        for (const objId in room.objects) {
            const objBody = room.objects[objId].body;
            
            // 1. Vector 3D exacto desde el jugador al objeto (incluyendo la Y)
            const dx = objBody.position.x - playerBody.position.x;
            const dy = objBody.position.y - playerBody.position.y;
            const dz = objBody.position.z - playerBody.position.z;
            
            // 2. Distancia tridimensional
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

            if (dist <= hitboxRadius) {
                objBody.wakeUp();

                // 3. Normalización 3D: Convertimos la distancia en una dirección pura (valores de -1 a 1 en todos los ejes)
                let normX = 0; let normY = 0; let normZ = 0;
                
                if (dist > 0) {
                    normX = dx / dist;
                    normY = dy / dist;
                    normZ = dz / dist;
                }

                // 4. Aplicar la fuerza usando la dirección exacta calculada
                const flingForce = 45; // Subí un poco la fuerza para compensar
                
                objBody.velocity.x = normX * flingForce;
                objBody.velocity.y = normY * flingForce;
                objBody.velocity.z = normZ * flingForce;
                
                // Rotación aleatoria al impacto
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

        const state = { players: {}, objects: {} };
        
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
