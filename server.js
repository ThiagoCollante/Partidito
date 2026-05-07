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

    // Suelo
    const groundBody = new CANNON.Body({ 
        type: CANNON.Body.STATIC, 
        shape: new CANNON.Plane(),
        material: slipperyMaterial
    });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody);

    // --- NUEVO: PAREDES DE LA HABITACIÓN (50x50) ---
    const roomSize = 50;
    const wallThickness = 4; // Paredes gruesas para que la pelota no las atraviese a gran velocidad
    const wallHeight = 20;

    const wallShapeX = new CANNON.Box(new CANNON.Vec3(wallThickness/2, wallHeight/2, roomSize/2));
    const wallShapeZ = new CANNON.Box(new CANNON.Vec3(roomSize/2, wallHeight/2, wallThickness/2));

    // Norte y Sur
    const wallN = new CANNON.Body({ type: CANNON.Body.STATIC, shape: wallShapeZ, position: new CANNON.Vec3(0, wallHeight/2, roomSize/2), material: slipperyMaterial });
    const wallS = new CANNON.Body({ type: CANNON.Body.STATIC, shape: wallShapeZ, position: new CANNON.Vec3(0, wallHeight/2, -roomSize/2), material: slipperyMaterial });
    // Este y Oeste
    const wallE = new CANNON.Body({ type: CANNON.Body.STATIC, shape: wallShapeX, position: new CANNON.Vec3(roomSize/2, wallHeight/2, 0), material: slipperyMaterial });
    const wallW = new CANNON.Body({ type: CANNON.Body.STATIC, shape: wallShapeX, position: new CANNON.Vec3(-roomSize/2, wallHeight/2, 0), material: slipperyMaterial });

    world.addBody(wallN); world.addBody(wallS); world.addBody(wallE); world.addBody(wallW);

    const objects = {};

    // --- NUEVO: UNA SOLA PELOTA PEQUEÑA ---
    // Radio de 0.5 (la mitad que antes), masa 1
    const smallBall = new CANNON.Body({ 
        mass: 1, 
        shape: new CANNON.Sphere(0.5), 
        position: new CANNON.Vec3(0, 2, -5) 
    });
    // Le damos un poco de rebote a la pelota para que sea divertido contra las paredes
    const bouncyMaterial = new CANNON.Material();
    world.addContactMaterial(new CANNON.ContactMaterial(slipperyMaterial, bouncyMaterial, { friction: 0.2, restitution: 0.8 }));
    smallBall.material = bouncyMaterial;
    
    world.addBody(smallBall); 
    objects[`main_ball`] = { body: smallBall, shape: 'small_sphere' }; // Etiqueta nueva

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
            position: new CANNON.Vec3((Math.random() - 0.5) * 10, 2, (Math.random() - 0.5) * 10), // Spawn más controlado
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

    socket.on('attack', () => {
        const room = rooms[socket.roomId];
        if (!room || !room.players[socket.id]) return;

        const playerBody = room.players[socket.id];
        const hitboxRadius = 2.5; 

        for (const objId in room.objects) {
            const objBody = room.objects[objId].body;
            
            const dx = objBody.position.x - playerBody.position.x;
            const dy = objBody.position.y - playerBody.position.y;
            const dz = objBody.position.z - playerBody.position.z;
            
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

            if (dist <= hitboxRadius) {
                objBody.wakeUp();

                let normX = 0; let normY = 0; let normZ = 0;
                
                if (dist > 0) {
                    normX = dx / dist;
                    normY = dy / dist;
                    normZ = dz / dist;
                }

                // Fuerza ajustada para la pelota que ahora es más ligera
                const flingForce = 35; 
                
                objBody.velocity.x = normX * flingForce;
                objBody.velocity.y = normY * flingForce;
                objBody.velocity.z = normZ * flingForce;
                
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
