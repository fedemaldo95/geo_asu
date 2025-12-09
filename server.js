const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// CONFIGURACIÓN DEL JUEGO
// ============================================
const CONFIG = {
    ROUNDS_PER_GAME: 5,
    MAX_POINTS_PER_ROUND: 5000,
    TIME_PER_ROUND: 120,
    MIN_PLAYERS: 2
};

// Áreas de las ciudades para generar ubicaciones aleatorias
const CITY_AREAS = {
    "Asunción": { minLat: -25.32, maxLat: -25.24, minLng: -57.67, maxLng: -57.54 },
    "San Lorenzo": { minLat: -25.36, maxLat: -25.32, minLng: -57.54, maxLng: -57.48 },
    "Fernando de la Mora": { minLat: -25.34, maxLat: -25.30, minLng: -57.58, maxLng: -57.53 },
    "Lambaré": { minLat: -25.36, maxLat: -25.32, minLng: -57.67, maxLng: -57.62 }
};

const CITIES = Object.keys(CITY_AREAS);

// ============================================
// ALMACENAMIENTO DE SALAS
// ============================================
const rooms = new Map(); // roomCode -> Room
const players = new Map(); // odigo WebSocket -> Player

class Room {
    constructor(code, hostName) {
        this.code = code;
        this.players = [];
        this.state = 'waiting'; // waiting, playing, finished
        this.currentRound = 0;
        this.roundLocations = [];
        this.roundResults = new Map(); // roundIndex -> Map(playerId -> result)
        this.hostId = null;
        this.createdAt = Date.now();
    }

    addPlayer(player) {
        if (this.state !== 'waiting') return false;

        this.players.push(player);
        if (this.players.length === 1) {
            this.hostId = player.id;
        }
        return true;
    }

    removePlayer(playerId) {
        this.players = this.players.filter(p => p.id !== playerId);
        if (this.hostId === playerId && this.players.length > 0) {
            this.hostId = this.players[0].id;
        }
    }

    generateLocations() {
        this.roundLocations = [];
        let cityPool = shuffleArray([...CITIES]);

        for (let i = 0; i < CONFIG.ROUNDS_PER_GAME; i++) {
            if (cityPool.length === 0) {
                cityPool = shuffleArray([...CITIES]);
            }

            const city = cityPool.pop();
            const area = CITY_AREAS[city];
            this.roundLocations.push({
                city: city,
                lat: randomInRange(area.minLat, area.maxLat),
                lng: randomInRange(area.minLng, area.maxLng)
            });
        }
    }

    getCurrentLocation() {
        return this.roundLocations[this.currentRound];
    }

    submitGuess(playerId, guess) {
        if (!this.roundResults.has(this.currentRound)) {
            this.roundResults.set(this.currentRound, new Map());
        }
        
        const roundMap = this.roundResults.get(this.currentRound);
        if (roundMap.has(playerId)) return false; // Ya adivinó
        
        const location = this.getCurrentLocation();
        const distance = this.calculateDistance(
            guess.lat, guess.lng,
            location.lat, location.lng
        );
        const points = this.calculatePoints(distance);
        
        roundMap.set(playerId, {
            guess: guess,
            distance: distance,
            points: points,
            timestamp: Date.now()
        });

        // Actualizar score del jugador
        const player = this.players.find(p => p.id === playerId);
        if (player) {
            player.score += points;
        }

        return { distance, points };
    }

    allPlayersGuessed() {
        const roundMap = this.roundResults.get(this.currentRound);
        if (!roundMap) return false;
        return roundMap.size >= this.players.length;
    }

    calculateDistance(lat1, lng1, lat2, lng2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    calculatePoints(distance) {
        if (distance === Infinity || isNaN(distance)) return 0;

        const distancePenalty = Math.exp(-0.35 * distance);
        const points = CONFIG.MAX_POINTS_PER_ROUND * distancePenalty;
        return Math.round(Math.max(0, Math.min(CONFIG.MAX_POINTS_PER_ROUND, points)));
    }

    getRoundResults() {
        const roundMap = this.roundResults.get(this.currentRound);
        if (!roundMap) return [];
        
        return this.players.map(p => ({
            id: p.id,
            name: p.name,
            result: roundMap.get(p.id) || { distance: Infinity, points: 0 }
        }));
    }

    getFinalResults() {
        const aggregated = this.aggregatePlayerStats();

        return this.players
            .map(p => ({
                id: p.id,
                name: p.name,
                score: p.score,
                totalDistance: aggregated.get(p.id)?.totalDistance ?? Infinity,
                fastestGuess: aggregated.get(p.id)?.fastestGuess ?? Infinity
            }))
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                if (a.totalDistance !== b.totalDistance) return a.totalDistance - b.totalDistance;
                if (a.fastestGuess !== b.fastestGuess) return a.fastestGuess - b.fastestGuess;
                return a.name.localeCompare(b.name);
            });
    }

    aggregatePlayerStats() {
        const totals = new Map();

        this.roundResults.forEach(roundMap => {
            roundMap.forEach((result, playerId) => {
                const current = totals.get(playerId) || { totalDistance: 0, fastestGuess: Infinity };
                current.totalDistance += Number.isFinite(result.distance) ? result.distance : 0;
                if (result.timestamp && result.timestamp < current.fastestGuess) {
                    current.fastestGuess = result.timestamp;
                }
                totals.set(playerId, current);
            });
        });

        return totals;
    }

    toJSON() {
        return {
            code: this.code,
            state: this.state,
            players: this.players.map(p => ({
                id: p.id,
                name: p.name,
                score: p.score,
                isHost: p.id === this.hostId
            })),
            currentRound: this.currentRound,
            totalRounds: CONFIG.ROUNDS_PER_GAME,
            hostId: this.hostId
        };
    }
}

// ============================================
// GENERAR CÓDIGO DE SALA
// ============================================
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';

    do {
        code = '';
        for (let i = 0; i < 6; i++) {
            const idx = crypto.randomInt(0, chars.length);
            code += chars.charAt(idx);
        }
    } while (rooms.has(code));

    return code;
}

function randomInRange(min, max) {
    const fraction = crypto.randomBytes(4).readUInt32BE(0) / 0xFFFFFFFF;
    return min + fraction * (max - min);
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// ============================================
// BROADCAST A SALA
// ============================================
function broadcastToRoom(room, message, excludeId = null) {
    room.players.forEach(player => {
        if (player.id !== excludeId && player.ws && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    });
}

function sendToPlayer(player, message) {
    if (player.ws && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify(message));
    }
}

// ============================================
// MANEJO DE WEBSOCKET
// ============================================
wss.on('connection', (ws) => {
    const playerId = uuidv4();
    console.log(`Jugador conectado: ${playerId}`);

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleMessage(ws, playerId, message);
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });

    ws.on('close', () => {
        handleDisconnect(playerId);
    });

    // Enviar ID al jugador
    ws.send(JSON.stringify({ type: 'connected', playerId }));
});

function handleMessage(ws, playerId, message) {
    console.log(`Mensaje de ${playerId}:`, message.type);

    switch (message.type) {
        case 'createRoom':
            handleCreateRoom(ws, playerId, message);
            break;
        case 'joinRoom':
            handleJoinRoom(ws, playerId, message);
            break;
        case 'startGame':
            handleStartGame(playerId);
            break;
        case 'submitGuess':
            handleSubmitGuess(playerId, message);
            break;
        case 'timeOut':
            handleTimeOut(playerId);
            break;
        case 'requestNextRound':
            handleNextRound(playerId);
            break;
        case 'locationFound':
            handleLocationFound(playerId, message);
            break;
    }
}

function handleCreateRoom(ws, playerId, message) {
    const code = generateRoomCode();
    const room = new Room(code);
    
    const player = {
        id: playerId,
        name: message.playerName || 'Jugador',
        score: 0,
        ws: ws,
        roomCode: code
    };

    room.addPlayer(player);
    rooms.set(code, room);
    players.set(playerId, player);

    console.log(`Sala creada: ${code} por ${player.name}`);

    sendToPlayer(player, {
        type: 'roomCreated',
        room: room.toJSON()
    });
}

function handleJoinRoom(ws, playerId, message) {
    const code = message.roomCode?.toUpperCase();
    const room = rooms.get(code);

    if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Sala no encontrada' }));
        return;
    }

    if (room.state !== 'waiting') {
        ws.send(JSON.stringify({ type: 'error', message: 'La partida ya comenzó' }));
        return;
    }

    const player = {
        id: playerId,
        name: message.playerName || 'Jugador',
        score: 0,
        ws: ws,
        roomCode: code
    };

    room.addPlayer(player);
    players.set(playerId, player);

    console.log(`${player.name} se unió a sala ${code}`);

    // Notificar al nuevo jugador
    sendToPlayer(player, {
        type: 'roomJoined',
        room: room.toJSON()
    });

    // Notificar a los demás
    broadcastToRoom(room, {
        type: 'playerJoined',
        room: room.toJSON()
    }, playerId);
}

function handleStartGame(playerId) {
    const player = players.get(playerId);
    if (!player) return;

    const room = rooms.get(player.roomCode);
    if (!room) return;

    if (room.hostId !== playerId) {
        sendToPlayer(player, { type: 'error', message: 'Solo el host puede iniciar' });
        return;
    }

    if (room.players.length < CONFIG.MIN_PLAYERS) {
        sendToPlayer(player, { type: 'error', message: `Se necesitan al menos ${CONFIG.MIN_PLAYERS} jugadores` });
        return;
    }

    room.state = 'playing';
    room.currentRound = 0;
    room.generateLocations();

    // Resetear scores
    room.players.forEach(p => p.score = 0);

    console.log(`Juego iniciado en sala ${room.code}`);

    broadcastToRoom(room, {
        type: 'gameStarted',
        room: room.toJSON(),
        round: 1,
        totalRounds: CONFIG.ROUNDS_PER_GAME,
        location: room.getCurrentLocation()
    });
}

function handleLocationFound(playerId, message) {
    const player = players.get(playerId);
    if (!player) return;

    const room = rooms.get(player.roomCode);
    if (!room) return;

    // Actualizar la ubicación real del panorama encontrado
    if (room.roundLocations[room.currentRound]) {
        room.roundLocations[room.currentRound].actualLat = message.lat;
        room.roundLocations[room.currentRound].actualLng = message.lng;
        room.roundLocations[room.currentRound].panoId = message.panoId;
    }

    // Notificar a todos los jugadores la ubicación real
    broadcastToRoom(room, {
        type: 'locationConfirmed',
        panoId: message.panoId,
        lat: message.lat,
        lng: message.lng
    });
}

function handleSubmitGuess(playerId, message) {
    const player = players.get(playerId);
    if (!player) return;

    const room = rooms.get(player.roomCode);
    if (!room || room.state !== 'playing') return;

    const location = room.getCurrentLocation();
    const actualLat = location.actualLat || location.lat;
    const actualLng = location.actualLng || location.lng;

    // Calcular contra la ubicación real del panorama
    const distance = room.calculateDistance(
        message.lat, message.lng,
        actualLat, actualLng
    );
    const points = room.calculatePoints(distance);
    const timestamp = Date.now();

    // Registrar resultado
    if (!room.roundResults.has(room.currentRound)) {
        room.roundResults.set(room.currentRound, new Map());
    }
    room.roundResults.get(room.currentRound).set(playerId, {
        guess: { lat: message.lat, lng: message.lng },
        distance,
        points,
        timestamp
    });

    player.score += points;

    console.log(`${player.name} adivinó: ${distance.toFixed(2)}km, ${points}pts`);

    // Notificar al jugador su resultado
    sendToPlayer(player, {
        type: 'guessResult',
        distance,
        points,
        totalScore: player.score
    });

    // Notificar a todos que alguien adivinó
    broadcastToRoom(room, {
        type: 'playerGuessed',
        playerId,
        playerName: player.name
    });

    // Verificar si todos adivinaron
    checkRoundComplete(room);
}

function handleTimeOut(playerId) {
    const player = players.get(playerId);
    if (!player) return;

    const room = rooms.get(player.roomCode);
    if (!room || room.state !== 'playing') return;

    // Registrar 0 puntos
    if (!room.roundResults.has(room.currentRound)) {
        room.roundResults.set(room.currentRound, new Map());
    }
    
    if (!room.roundResults.get(room.currentRound).has(playerId)) {
        room.roundResults.get(room.currentRound).set(playerId, {
            guess: null,
            distance: Infinity,
            points: 0,
            timestamp: Date.now()
        });

        sendToPlayer(player, {
            type: 'guessResult',
            distance: Infinity,
            points: 0,
            totalScore: player.score,
            timedOut: true
        });

        broadcastToRoom(room, {
            type: 'playerGuessed',
            playerId,
            playerName: player.name,
            timedOut: true
        });

        checkRoundComplete(room);
    }
}

function checkRoundComplete(room) {
    const roundMap = room.roundResults.get(room.currentRound);
    if (!roundMap || roundMap.size < room.players.length) return;

    const location = room.getCurrentLocation();

    // Todos adivinaron - mostrar resultados de la ronda
    const roundResults = room.players.map(p => {
        const result = roundMap.get(p.id) || { distance: Infinity, points: 0, timestamp: Infinity };
        return {
            id: p.id,
            name: p.name,
            distance: result.distance,
            points: result.points,
            guess: result.guess,
            totalScore: p.score,
            timestamp: result.timestamp
        };
    }).sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (a.distance !== b.distance) return a.distance - b.distance;
        return a.timestamp - b.timestamp;
    }).map((result, index) => ({ ...result, rank: index + 1 }));

    broadcastToRoom(room, {
        type: 'roundComplete',
        round: room.currentRound + 1,
        results: roundResults,
        actualLocation: {
            lat: location.actualLat || location.lat,
            lng: location.actualLng || location.lng,
            city: location.city
        }
    });
}

function handleNextRound(playerId) {
    const player = players.get(playerId);
    if (!player) return;

    const room = rooms.get(player.roomCode);
    if (!room) return;

    // Solo el host puede avanzar
    if (room.hostId !== playerId) return;

    room.currentRound++;

    if (room.currentRound >= CONFIG.ROUNDS_PER_GAME) {
        // Juego terminado
        room.state = 'finished';
        
        broadcastToRoom(room, {
            type: 'gameFinished',
            results: room.getFinalResults()
        });
    } else {
        // Siguiente ronda
        broadcastToRoom(room, {
            type: 'nextRound',
            round: room.currentRound + 1,
            totalRounds: CONFIG.ROUNDS_PER_GAME,
            location: room.getCurrentLocation()
        });
    }
}

function handleDisconnect(playerId) {
    const player = players.get(playerId);
    if (!player) return;

    const room = rooms.get(player.roomCode);
    if (room) {
        const wasHost = room.hostId === playerId;
        room.removePlayer(playerId);

        if (room.players.length === 0) {
            rooms.delete(room.code);
            console.log(`Sala ${room.code} eliminada (vacía)`);
        } else {
            broadcastToRoom(room, {
                type: 'playerLeft',
                playerId,
                playerName: player.name,
                room: room.toJSON()
            });

            if (wasHost && room.hostId) {
                broadcastToRoom(room, {
                    type: 'hostChanged',
                    hostId: room.hostId
                });
            }

            if (room.state === 'playing') {
                checkRoundComplete(room);
            }
        }
    }

    players.delete(playerId);
    console.log(`Jugador desconectado: ${playerId}`);
}

// ============================================
// LIMPIEZA DE SALAS INACTIVAS
// ============================================
setInterval(() => {
    const now = Date.now();
    const timeout = 30 * 60 * 1000; // 30 minutos

    rooms.forEach((room, code) => {
        if (now - room.createdAt > timeout && room.state !== 'playing') {
            rooms.delete(code);
            console.log(`Sala ${code} eliminada por inactividad`);
        }
    });
}, 5 * 60 * 1000); // Cada 5 minutos

// ============================================
// INICIAR SERVIDOR
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 Servidor Asunción Metro Guessr corriendo en puerto ${PORT}`);
    console.log(`🌐 http://localhost:${PORT}`);
});
