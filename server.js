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
    world.addContactMaterial(new CANNON.ContactMaterial(slipperyMaterial, bouncyMaterial, { friction: 0.1, restitution: 0.6 })); 

    const groundBody = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane(), material: slipperyMaterial });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody);

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

    const goalZ = 51; 
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
        linearDamping: 0.3,  
        angularDamping: 0.1  
    });
    world.addBody(smallBall); 
    
    objects[`main_ball`] = { body: smallBall, shape: 'soccer_ball', possessor: null, cooldown: 0, curveTimer: 0, curveMaxTime: 45 };

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

    socket.on('attack', (attackData) => {
        const room = rooms[socket.roomId];
        if (!room || !room.players[socket.id]) return;

        const ballData = room.objects['main_ball'];
        const playerBody = room.players[socket.id];

        if (ballData.possessor === socket.id) {
            ballData.possessor = null;
            ballData.cooldown = 15; 
            ballData.curveTimer = ballData.curveMaxTime; 

            const ballBody = ballData.body;
            ballBody.collisionResponse = true; 
            ballBody.wakeUp(); 

            const yaw = attackData.yaw;
            const pitch = attackData.pitch;
            const power = attackData.power || 1;    
            const spinX = attackData.spinX || 0;    
            const spinY = attackData.spinY || 0;    

            // --- 1. Calcular VECTORES LOCALES basados en tu cámara ---
            // Vector Frontal
            const dirX = -Math.sin(yaw) * Math.cos(pitch);
            const dirY = Math.sin(pitch);
            const dirZ = -Math.cos(yaw) * Math.cos(pitch);
            const forwardVector = new CANNON.Vec3(dirX, dirY, dirZ);

            // Vector Derecho (Fijo en el horizonte relativo a ti)
            const rightX = Math.cos(yaw);
            const rightY = 0;
            const rightZ = -Math.sin(yaw);
            const rightVector = new CANNON.Vec3(rightX, rightY, rightZ);

            // Vector Arriba (Calculado dinámicamente haciendo Right x Forward)
            const upVector = new CANNON.Vec3();
            rightVector.cross(forwardVector, upVector);

            // --- 2. Aplicar la Fuerza de Tiro ---
            const baseKickForce = 26; 
            const totalForce = baseKickForce * power;
            const lift = (dirY * totalForce * 0.9) + (3 * power);
            
            ballBody.velocity.set(dirX * totalForce, lift, dirZ * totalForce);
            
            // --- 3. MATEMÁTICA PURA OMNIDIRECCIONAL ---
            // Definimos hacia dónde quieres que curve la pelota basándonos en tu puntero:
            // spinX > 0 (derecha) -> curva a la derecha (+rightVector)
            // spinY < 0 (arriba) -> curva hacia arriba (+upVector)
            const curveDir = new CANNON.Vec3(
                rightVector.x * spinX + upVector.x * (-spinY),
                rightVector.y * spinX + upVector.y * (-spinY),
                rightVector.z * spinX + upVector.z * (-spinY)
            );

            // Calculamos el Eje de Rotación exacto que generará esa curva con Producto Cruz
            const omegaDir = new CANNON.Vec3();
            forwardVector.cross(curveDir, omegaDir);

            // Aplicamos la rotación
            const spinFactor = 25 * power; 
            ballBody.angularVelocity.set(omegaDir.x * spinFactor, omegaDir.y * spinFactor, omegaDir.z * spinFactor);
        }
    });

    socket.on('disconnect', () => {
        const room = rooms[socket.roomId];
        if (room && room.players[socket.id]) {
            const ballData = room.objects['main_ball'];
            if (ballData.possessor === socket.id) {
                ballData.possessor = null;
                ballData.body.collisionResponse = true; 
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

        const ballData = room.objects['main_ball'];
        const ballBody = ballData.body;

        // Limitar excesos de física para evitar desincronizaciones de red
        const v = ballBody.velocity;
        const currentSpeed = Math.sqrt(v.x*v.x + v.y*v.y + v.z*v.z);
        const MAX_SPEED = 85; 
        
        if (currentSpeed > MAX_SPEED) {
            v.x = (v.x / currentSpeed) * MAX_SPEED;
            v.y = (v.y / currentSpeed) * MAX_SPEED;
            v.z = (v.z / currentSpeed) * MAX_SPEED;
        }

        const w = ballBody.angularVelocity;
        const currentSpin = Math.sqrt(w.x*w.x + w.y*w.y + w.z*w.z);
        const MAX_SPIN = 50; // Tolerancia alta para permitir giros espectaculares
        
        if (currentSpin > MAX_SPIN) {
            w.x = (w.x / currentSpin) * MAX_SPIN;
            w.y = (w.y / currentSpin) * MAX_SPIN;
            w.z = (w.z / currentSpin) * MAX_SPIN;
        }

        if (Math.abs(ballBody.position.x) > 100 || Math.abs(ballBody.position.z) > 150 || ballBody.position.y > 100 || ballBody.position.y < -5) {
            ballBody.position.set(0, 5, 0);
            ballBody.velocity.set(0, 0, 0);
            ballBody.angularVelocity.set(0, 0, 0);
            ballBody.collisionResponse = true;
            ballData.possessor = null;
        }

        // --- EFECTO MAGNUS AERODINÁMICO ---
        if (ballData.curveTimer > 0) {
            ballData.curveTimer--; 
            
            const powerRatio = ballData.curveTimer / ballData.curveMaxTime;
            const magnusConstant = 0.008 * powerRatio; 
            
            const magnusForce = new CANNON.Vec3(
                (w.y * v.z - w.z * v.y) * magnusConstant,
                (w.z * v.x - w.x * v.z) * magnusConstant,
                (w.x * v.y - w.y * v.x) * magnusConstant
            );
            ballBody.applyForce(magnusForce, ballBody.position);
        }

        if (ballData.cooldown > 0) ballData.cooldown--;

        if (!ballData.possessor && ballData.cooldown <= 0) {
            const grabRadius = 3.0; 
            for (const id in room.players) {
                const playerBody = room.players[id];
                const dx = ballBody.position.x - playerBody.position.x;
                const dz = ballBody.position.z - playerBody.position.z;
                
                if (Math.sqrt(dx*dx + dz*dz) <= grabRadius) {
                    ballData.possessor = id;
                    ballBody.collisionResponse = false; 
                    break; 
                }
            }
        }

        if (ballData.possessor) {
            const ownerBody = room.players[ballData.possessor];
            if (ownerBody) {
                const yaw = ownerBody.input.yaw;
                const targetX = ownerBody.position.x - Math.sin(yaw) * 1.5;
                const targetZ = ownerBody.position.z - Math.cos(yaw) * 1.5;
                
                ballBody.position.set(targetX, 0.4, targetZ);
                ballBody.velocity.set(0, 0, 0);
                ballBody.angularVelocity.set(0, 0, 0);
            } else {
                ballData.possessor = null;
                ballBody.collisionResponse = true;
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
                possessor: objData.possessor
            };
        }

        io.to(roomId).emit('gameState', state);
    }
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
