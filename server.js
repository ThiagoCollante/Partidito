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
    const bouncyMaterial = new CANNON.Material('bouncy');
    
    world.addContactMaterial(new CANNON.ContactMaterial(slipperyMaterial, slipperyMaterial, { friction: 0.0, restitution: 0.0 }));
    world.addContactMaterial(new CANNON.ContactMaterial(slipperyMaterial, bouncyMaterial, { friction: 0.1, restitution: 0.8 }));

    const groundBody = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane(), material: slipperyMaterial });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody);

    // ESTADIO GIGANTE (150x150)
    const roomSize = 150;
    const wallThickness = 4; 
    const wallHeight = 40;

    const wallShapeX = new CANNON.Box(new CANNON.Vec3(wallThickness/2, wallHeight/2, roomSize/2));
    const wallShapeZ = new CANNON.Box(new CANNON.Vec3(roomSize/2, wallHeight/2, wallThickness/2));
    const roofShape  = new CANNON.Box(new CANNON.Vec3(roomSize/2, wallThickness/2, roomSize/2));

    const wallN = new CANNON.Body({ type: CANNON.Body.STATIC, shape: wallShapeZ, position: new CANNON.Vec3(0, wallHeight/2, roomSize/2), material: slipperyMaterial });
    const wallS = new CANNON.Body({ type: CANNON.Body.STATIC, shape: wallShapeZ, position: new CANNON.Vec3(0, wallHeight/2, -roomSize/2), material: slipperyMaterial });
    const wallE = new CANNON.Body({ type: CANNON.Body.STATIC, shape: wallShapeX, position: new CANNON.Vec3(roomSize/2, wallHeight/2, 0), material: slipperyMaterial });
    const wallW = new CANNON.Body({ type: CANNON.Body.STATIC, shape: wallShapeX, position: new CANNON.Vec3(-roomSize/2, wallHeight/2, 0), material: slipperyMaterial });
    const roof  = new CANNON.Body({ type: CANNON.Body.STATIC, shape: roofShape, position: new CANNON.Vec3(0, wallHeight, 0), material: slipperyMaterial });

    world.addBody(wallN); world.addBody(wallS); world.addBody(wallE); world.addBody(wallW); world.addBody(roof);

    const objects = {};

    // LA PELOTA (Añadimos la propiedad possessor para saber quién la tiene)
    const smallBall = new CANNON.Body({ 
        mass: 0.5,
        shape: new CANNON.Sphere(0.3), 
        position: new CANNON.Vec3(0, 5, -5),
        material: bouncyMaterial
    });
    world.addBody(smallBall); 
    objects[`main_ball`] = { body: smallBall, shape: 'tiny_sphere', possessor: null };

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
            position: new CANNON.Vec3((Math.random() - 0.5) * 10, 2, (Math.random() - 0.5) * 10),
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

    // --- SISTEMA DE PATEO (KICK) ---
    socket.on('attack', () => {
        const room = rooms[socket.roomId];
        if (!room || !room.players[socket.id]) return;

        const ballData = room.objects['main_ball'];
        const playerBody = room.players[socket.id];

        // Solo puedes patear si TÚ tienes la pelota
        if (ballData.possessor === socket.id) {
            // 1. Soltar la pelota
            ballData.possessor = null;

            // 2. Calcular la dirección hacia donde miras
            const yaw = playerBody.input.yaw;
            const normX = -Math.sin(yaw);
            const normZ = -Math.cos(yaw);

            // 3. Aplicar la fuerza del chute
            const kickForce = 45; // Fuerza hacia adelante
            const kickLift = 15;  // Fuerza hacia arriba (para que haga una parábola)

            const ballBody = ballData.body;
            ballBody.velocity.x = normX * kickForce;
            ballBody.velocity.y = kickLift; 
            ballBody.velocity.z = normZ * kickForce;

            // Efecto de giro para que se vea realista al volar
            ballBody.angularVelocity.set(
                (Math.random() - 0.5) * 20,
                (Math.random() - 0.5) * 20,
                (Math.random() - 0.5) * 20
            );
        }
    });

    socket.on('disconnect', () => {
        const room = rooms[socket.roomId];
        if (room && room.players[socket.id]) {
            // Si el jugador se desconecta y tenía la pelota, la soltamos
            const ballData = room.objects['main_ball'];
            if (ballData.possessor === socket.id) {
                ballData.possessor = null;
            }

            room.world.removeBody(room.players[socket.id]);
            delete room.players[socket.id];
            io.to(socket.roomId).emit('playerLeft', socket.id);
        }
    });
});

setInterval(() => {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        const delta = 1 / 30; 

        // --- 1. LÓGICA DE POSESIÓN DE PELOTA ---
        const ballData = room.objects['main_ball'];
        const ballBody = ballData.body;

        // Si la pelota NO tiene dueño, comprobar si alguien la toca
        if (!ballData.possessor) {
            const grabRadius = 2.0; // Distancia de la hitbox para robar/agarrar la pelota

            for (const id in room.players) {
                const playerBody = room.players[id];
                const dx = ballBody.position.x - playerBody.position.x;
                const dy = ballBody.position.y - playerBody.position.y;
                const dz = ballBody.position.z - playerBody.position.z;
                const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

                // Si un jugador entra en contacto con la pelota, se la queda
                if (dist <= grabRadius) {
                    ballData.possessor = id;
                    break; // Solo el primero en la lista la agarra en este tick
                }
            }
        }

        // Si la pelota SÍ tiene dueño, anclarla a sus pies
        if (ballData.possessor) {
            const ownerBody = room.players[ballData.possessor];
            if (ownerBody) {
                const yaw = ownerBody.input.yaw;
                const offsetFront = 1.0; // Distancia hacia el frente (en la punta de los pies)

                // Calcular posición exacta frente al jugador
                const targetX = ownerBody.position.x - Math.sin(yaw) * offsetFront;
                const targetZ = ownerBody.position.z - Math.cos(yaw) * offsetFront;
                const targetY = 0.3; // Altura exacta de la pelota descansando en el suelo (Radio 0.3)

                // Forzamos la posición y matamos su inercia para que no se escape
                ballBody.position.set(targetX, targetY, targetZ);
                ballBody.velocity.set(0, 0, 0);
                ballBody.angularVelocity.set(0, 0, 0);
            } else {
                // Prevención de errores si el dueño ya no existe
                ballData.possessor = null;
            }
        }

        // --- 2. LÓGICA DE MOVIMIENTO DE JUGADORES ---
        for (const id in room.players) {
            const body = room.players[id];
            const input = body.input;
            
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

        room.world.step(delta);

        // --- 3. RECOPILAR ESTADO Y ENVIAR AL CLIENTE ---
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
