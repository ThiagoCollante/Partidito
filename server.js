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
    world.addContactMaterial(new CANNON.ContactMaterial(slipperyMaterial, bouncyMaterial, { friction: 0.2, restitution: 0.6 })); 

    const groundBody = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane(), material: slipperyMaterial });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody);

    // --- NUEVAS DIMENSIONES: CANCHA DE 70 x 105 ---
    const fieldWidth = 70;
    const fieldLength = 105;
    const wallThickness = 4; 
    const wallHeight = 20;

    const wallShapeX = new CANNON.Box(new CANNON.Vec3(wallThickness/2, wallHeight/2, fieldLength/2));
    const wallShapeZ = new CANNON.Box(new CANNON.Vec3(fieldWidth/2, wallHeight/2, wallThickness/2));
    const roofShape  = new CANNON.Box(new CANNON.Vec3(fieldWidth/2, wallThickness/2, fieldLength/2));

    const wallN = new CANNON.Body({ type: CANNON.Body.STATIC, shape: wallShapeZ, position: new CANNON.Vec3(0, wallHeight/2, fieldLength/2), material: slipperyMaterial });
    const wallS = new CANNON.Body({ type: CANNON.Body.STATIC, shape: wallShapeZ, position: new CANNON.Vec3(0, wallHeight/2, -fieldLength/2), material: slipperyMaterial });
    const wallE = new CANNON.Body({ type: CANNON.Body.STATIC, shape: wallShapeX, position: new CANNON.Vec3(fieldWidth/2, wallHeight/2, 0), material: slipperyMaterial });
    const wallW = new CANNON.Body({ type: CANNON.Body.STATIC, shape: wallShapeX, position: new CANNON.Vec3(-fieldWidth/2, wallHeight/2, 0), material: slipperyMaterial });
    const roof  = new CANNON.Body({ type: CANNON.Body.STATIC, shape: roofShape, position: new CANNON.Vec3(0, wallHeight, 0), material: slipperyMaterial });

    world.addBody(wallN); world.addBody(wallS); world.addBody(wallE); world.addBody(wallW); world.addBody(roof);

    // Físicas de los Arcos adaptadas a la nueva distancia
    const goalZ = 51; // Acomodado al borde de la cancha (-52.5)
    const goalSideShape = new CANNON.Box(new CANNON.Vec3(0.2, 1.5, 1.5));
    world.addBody(new CANNON.Body({ type: CANNON.Body.STATIC, shape: goalSideShape, position: new CANNON.Vec3(-5.2, 1.5, -goalZ), material: bouncyMaterial }));
    world.addBody(new CANNON.Body({ type: CANNON.Body.STATIC, shape: goalSideShape, position: new CANNON.Vec3(5.2, 1.5, -goalZ), material: bouncyMaterial }));
    world.addBody(new CANNON.Body({ type: CANNON.Body.STATIC, shape: goalSideShape, position: new CANNON.Vec3(-5.2, 1.5, goalZ), material: bouncyMaterial }));
    world.addBody(new CANNON.Body({ type: CANNON.Body.STATIC, shape: goalSideShape, position: new CANNON.Vec3(5.2, 1.5, goalZ), material: bouncyMaterial }));

    const objects = {};

    const smallBall = new CANNON.Body({ 
        mass: 0.5,
        shape: new CANNON.Sphere(0.3), 
        position: new CANNON.Vec3(0, 5, 0), 
        material: bouncyMaterial,
        linearDamping: 0.4,  
        angularDamping: 0.4  
    });
    world.addBody(smallBall); 
    objects[`main_ball`] = { body: smallBall, shape: 'soccer_ball', possessor: null, cooldown: 0 };

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
        
        playerBody.input = { keys: {}, yaw: 0, pitch: 0 };
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

    // --- NUEVO SISTEMA DE TIRO CON CARGA Y EFECTO (SPIN) ---
    socket.on('attack', (attackData) => {
        const room = rooms[socket.roomId];
        if (!room || !room.players[socket.id]) return;

        const ballData = room.objects['main_ball'];
        const playerBody = room.players[socket.id];

        if (ballData.possessor === socket.id) {
            ballData.possessor = null;
            ballData.cooldown = 15; 

            // Datos que envía el cliente
            const yaw = attackData.yaw;
            const pitch = attackData.pitch;
            const power = attackData.power || 1;    // De 0.5 (tiro rápido) a 2.0 (cargado al máximo)
            const spinX = attackData.spinX || 0;    // De -1 a 1 (Efecto izquierda/derecha)
            const spinY = attackData.spinY || 0;    // De -1 a 1 (Topspin/Backspin)

            const dirX = -Math.sin(yaw) * Math.cos(pitch);
            const dirY = Math.sin(pitch);
            const dirZ = -Math.cos(yaw) * Math.cos(pitch);

            const baseKickForce = 50; 
            const totalForce = baseKickForce * power;
            
            const lift = (dirY * totalForce) + (5 * power);

            const ballBody = ballData.body;
            ballBody.wakeUp(); 
            
            ballBody.velocity.set(dirX * totalForce, lift, dirZ * totalForce);
            
            // Aplicar la rotación para el Efecto Magnus en el aire
            // El spinX negativo (punto a la izq) aplica rotación en Y para curvar a la izquierda.
            const spinFactor = 35 * power;
            ballBody.angularVelocity.set(spinY * spinFactor, -spinX * spinFactor, 0);
        }
    });

    socket.on('disconnect', () => {
        const room = rooms[socket.roomId];
        if (room && room.players[socket.id]) {
            const ballData = room.objects['main_ball'];
            if (ballData.possessor === socket.id) ballData.possessor = null;

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

        const ballData = room.objects['main_ball'];
        const ballBody = ballData.body;

        // --- EFECTO MAGNUS (CURVA EN EL AIRE) ---
        // Calcula la fuerza perpendicular a la velocidad y la rotación para curvar la bola.
        const v = ballBody.velocity;
        const w = ballBody.angularVelocity;
        const magnusConstant = 0.025; // Intensidad del efecto en el aire
        const magnusForce = new CANNON.Vec3(
            (w.y * v.z - w.z * v.y) * magnusConstant,
            (w.z * v.x - w.x * v.z) * magnusConstant,
            (w.x * v.y - w.y * v.x) * magnusConstant
        );
        ballBody.applyForce(magnusForce, ballBody.position);


        if (ballData.cooldown > 0) ballData.cooldown--;

        if (!ballData.possessor && ballData.cooldown <= 0) {
            const grabRadius = 2.0; 
            for (const id in room.players) {
                const playerBody = room.players[id];
                const dx = ballBody.position.x - playerBody.position.x;
                const dy = ballBody.position.y - playerBody.position.y;
                const dz = ballBody.position.z - playerBody.position.z;
                
                if (Math.sqrt(dx*dx + dy*dy + dz*dz) <= grabRadius) {
                    ballData.possessor = id;
                    break; 
                }
            }
        }

        if (ballData.possessor) {
            const ownerBody = room.players[ballData.possessor];
            if (ownerBody) {
                const yaw = ownerBody.input.yaw;
                const targetX = ownerBody.position.x - Math.sin(yaw) * 1.0;
                const targetZ = ownerBody.position.z - Math.cos(yaw) * 1.0;
                
                ballBody.position.set(targetX, 0.3, targetZ);
                ballBody.velocity.set(0, 0, 0);
                ballBody.angularVelocity.set(0, 0, 0);
            } else {
                ballData.possessor = null;
            }
        }

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

        const state = { players: {}, objects: {} };
        
        for (const id in room.players) {
            const body = room.players[id];
            state.players[id] = { 
                x: body.position.x, y: body.position.y - 0.5, z: body.position.z,
                yaw: body.input.yaw, nickname: body.nickname 
            };
        }
        
        for (const id in room.objects) {
            const objData = room.objects[id];
            const objBody = objData.body;
            state.objects[id] = {
                shape: objData.shape,
                x: objBody.position.x, y: objBody.position.y, z: objBody.position.z,
                qx: objBody.quaternion.x, qy: objBody.quaternion.y, qz: objBody.quaternion.z, qw: objBody.quaternion.w,
                possessor: objData.possessor // IMPORTANTÍSIMO: Avisarle a los clientes quién tiene el balón
            };
        }

        io.to(roomId).emit('gameState', state);
    }
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
