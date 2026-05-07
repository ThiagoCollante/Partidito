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
    
    // Cero fricción en el piso para calcular nosotros el agarre de las llantas
    world.addContactMaterial(new CANNON.ContactMaterial(slipperyMaterial, slipperyMaterial, { friction: 0.0, restitution: 0.0 }));
    world.addContactMaterial(new CANNON.ContactMaterial(slipperyMaterial, bouncyMaterial, { friction: 0.1, restitution: 0.6 })); // La pelota rebota

    const groundBody = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane(), material: slipperyMaterial });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody);

    // --- EL GRAN ESTADIO (150x150) CON TECHO ---
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

    // La pelota (Radio 1.5 para que el auto la pueda golpear bien)
    const mainBall = new CANNON.Body({ 
        mass: 1, // Liviana para salir volando
        shape: new CANNON.Sphere(1.5), 
        position: new CANNON.Vec3(0, 5, 0),
        material: bouncyMaterial
    });
    world.addBody(mainBall); 
    objects[`main_ball`] = { body: mainBall, shape: 'main_ball' };

    rooms[roomId] = { world, players: {}, objects, slipperyMaterial };
}

io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        const roomId = data.roomId;
        if (!rooms[roomId]) createRoom(roomId);
        socket.join(roomId);
        socket.roomId = roomId;

        const room = rooms[roomId];

        // --- FÍSICAS DEL COCHE (Caja Rectangular) ---
        // Half-extents en Cannon: 1 de ancho (total 2), 0.5 de alto (total 1), 2 de largo (total 4)
        const playerBody = new CANNON.Body({
            mass: 15, // Coche pesado para empujar la bola con fuerza
            shape: new CANNON.Box(new CANNON.Vec3(1, 0.5, 2)),
            position: new CANNON.Vec3((Math.random() - 0.5) * 20, 1, (Math.random() - 0.5) * 20),
            fixedRotation: true, // Bloqueamos la rotación física para hacer un manejo arcade seguro
            material: room.slipperyMaterial 
        });
        
        playerBody.input = { keys: {} };
        playerBody.carYaw = 0; // Ángulo propio del coche
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
        const delta = 1 / 30; 

        for (const id in room.players) {
            const body = room.players[id];
            const input = body.input;
            
            // 1. DIRECCIÓN DEL COCHE (A y D giran el volante)
            if (input.keys.a) body.carYaw += 3.5 * delta;
            if (input.keys.d) body.carYaw -= 3.5 * delta;
            
            // Actualizar la rotación real en el motor
            body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), body.carYaw);

            // Vectores de Frente y Lado del coche
            const forwardX = -Math.sin(body.carYaw);
            const forwardZ = -Math.cos(body.carYaw);
            const rightX = Math.cos(body.carYaw);
            const rightZ = -Math.sin(body.carYaw);

            // 2. ACELERACIÓN Y NITRO (W y S)
            let driveDir = 0;
            if (input.keys.w) driveDir = 1;
            if (input.keys.s) driveDir = -1;

            // SISTEMA DE NITRO (Shift)
            const engineForce = input.keys.shift ? 250.0 : 80.0; 

            body.velocity.x += forwardX * driveDir * engineForce * delta;
            body.velocity.z += forwardZ * driveDir * engineForce * delta;

            // 3. FRICCIÓN Y AGARRE DE LLANTAS (Arcade)
            // Fricción frontal (frena poco a poco si sueltas el acelerador)
            body.velocity.x -= body.velocity.x * 1.5 * delta;
            body.velocity.z -= body.velocity.z * 1.5 * delta;

            // Fricción lateral extrema (Mata el derrape para que doble bien)
            const dotRight = body.velocity.x * rightX + body.velocity.z * rightZ;
            body.velocity.x -= rightX * dotRight * 12.0 * delta;
            body.velocity.z -= rightZ * dotRight * 12.0 * delta;

            // 4. SALTO
            if (input.keys.space && Math.abs(body.velocity.y) < 0.1) {
                body.velocity.y = 10;
            }
        }

        room.world.step(delta);

        const state = { players: {}, objects: {} };
        
        for (const id in room.players) {
            const body = room.players[id];
            state.players[id] = { 
                x: body.position.x, y: body.position.y, z: body.position.z,
                qx: body.quaternion.x, qy: body.quaternion.y, qz: body.quaternion.z, qw: body.quaternion.w,
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
