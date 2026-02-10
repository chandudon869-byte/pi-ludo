const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from current directory
app.use(express.static(__dirname));

// Route for testing
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

console.log('Ludo Server starting...');

// Game state storage
const rooms = {};
const MAX_PLAYERS = 4;
const DEFAULT_MAX_PLAYERS = 4;
const TURN_TIME_MS = 10000;
const quickPlayQueue = [];

function removeFromQuickPlayQueue(socketId) {
  const idx = quickPlayQueue.indexOf(socketId);
  if (idx !== -1) {
    quickPlayQueue.splice(idx, 1);
  }
}

function emitQuickPlayQueueUpdate() {
  const payload = { count: quickPlayQueue.length, maxPlayers: DEFAULT_MAX_PLAYERS };
  quickPlayQueue.forEach(id => {
    const s = io.sockets.sockets.get(id);
    if (s) {
      s.emit('quick_play_queue_update', payload);
    }
  });
}

function createQuickPlayRoom() {
  const playersToMatch = [];
  while (playersToMatch.length < DEFAULT_MAX_PLAYERS && quickPlayQueue.length > 0) {
    const id = quickPlayQueue.shift();
    const s = io.sockets.sockets.get(id);
    if (s) {
      playersToMatch.push(s);
    }
  }

  if (playersToMatch.length < DEFAULT_MAX_PLAYERS) {
    // Not enough valid sockets, put them back and update queue
    playersToMatch.forEach(s => quickPlayQueue.unshift(s.id));
    emitQuickPlayQueueUpdate();
    return;
  }

  const roomId = generateRoomCode();
  rooms[roomId] = {
    players: {},
    playerCount: 0,
    maxPlayers: DEFAULT_MAX_PLAYERS,
    isPublic: false,
    gameState: {
      players: {},
      playerColors: {},
      currentPlayer: null,
      diceValue: 0,
      gameStarted: false,
      settings: {},
      tokens: {
        r: [-1, -1, -1, -1],
        g: [-1, -1, -1, -1],
        y: [-1, -1, -1, -1],
        b: [-1, -1, -1, -1]
      }
    },
    createdAt: new Date().toISOString()
  };

  playersToMatch.forEach((s, idx) => {
    const isHost = idx === 0;
    const name = s.data?.playerName || `Player${Object.keys(rooms[roomId].players).length + 1}`;
    rooms[roomId].players[s.id] = {
      id: s.id,
      name,
      isHost,
      ready: true,
      color: null,
      joinedAt: new Date().toISOString()
    };
    rooms[roomId].playerCount++;
    rooms[roomId].gameState.players[s.id] = { name, ready: true };
    s.join(roomId);
  });

  const payload = {
    roomId,
    players: rooms[roomId].players,
    playerCount: rooms[roomId].playerCount,
    maxPlayers: rooms[roomId].maxPlayers,
    isPublic: rooms[roomId].isPublic
  };

  playersToMatch.forEach((s, idx) => {
    if (idx === 0) {
      s.emit('room_created', { ...payload, isHost: true });
    } else {
      s.emit('room_joined', { ...payload, isHost: false });
    }
  });

  emitQuickPlayQueueUpdate();
}

function clearTurnTimer(room) {
  if (room && room.gameState && room.gameState.turnTimer) {
    clearTimeout(room.gameState.turnTimer);
    room.gameState.turnTimer = null;
  }
}

function startTurnTimer(roomId) {
  const room = rooms[roomId];
  if (!room || !room.gameState?.gameStarted) return;
  clearTurnTimer(room);
  io.to(roomId).emit('turn_timer_start', {
    duration: TURN_TIME_MS,
    playerColor: room.gameState.currentPlayer
  });
  room.gameState.turnTimer = setTimeout(() => {
    // Auto-roll if player hasn't rolled yet
    if (!room || !room.gameState?.gameStarted) return;
    if (room.gameState.diceValue !== 0) return;
    const currentColor = room.gameState.currentPlayer;
    const currentPlayerId = room.gameState.playerColors[currentColor];
    if (!currentPlayerId) return;

    const diceValue = Math.floor(Math.random() * 6) + 1;
    room.gameState.diceValue = diceValue;
    io.to(roomId).emit('dice_rolled', {
      playerId: currentPlayerId,
      playerColor: currentColor,
      playerName: room.players[currentPlayerId]?.name || 'Player',
      value: diceValue,
      auto: true
    });
    console.log(`Auto-rolled ${diceValue} for ${currentColor} in room ${roomId}`);

    // Auto-move after auto-roll (random valid move)
    const validMoves = getValidMoves(room, currentColor, diceValue);
    if (validMoves.length === 0) {
      passTurn(roomId, currentColor);
      return;
    }
    const tokenIndex = validMoves[Math.floor(Math.random() * validMoves.length)];
    applyMove(roomId, currentColor, tokenIndex, diceValue, currentPlayerId);
  }, TURN_TIME_MS);
}

function getValidMoves(room, color, diceValue) {
  if (!room || !room.gameState) return [];
  const tokens = room.gameState.tokens[color] || [];
  const moves = [];
  tokens.forEach((step, idx) => {
    if (step === -1 && diceValue === 6) {
      moves.push(idx);
    } else if (step !== -1 && step + diceValue <= 56) {
      if (requiresCutToHome(room) && step <= 50 && step + diceValue > 50) {
        if (!room.gameState.cutStatus || !room.gameState.cutStatus[color]) return;
      }
      moves.push(idx);
    }
  });
  return moves;
}

function requiresCutToHome(room) {
  return room?.gameState?.settings?.cutToHome === true;
}

function passTurn(roomId, playerColor) {
  const room = rooms[roomId];
  if (!room || !room.gameState) return;
  room.gameState.diceValue = 0;
  const activeColors = Object.keys(room.gameState.playerColors);
  const currentIndex = activeColors.indexOf(playerColor);
  const nextIndex = (currentIndex + 1) % activeColors.length;
  room.gameState.currentPlayer = activeColors[nextIndex];

  io.to(roomId).emit('no_move_confirmed', {
    success: true,
    playerColor: playerColor,
    nextPlayer: room.gameState.currentPlayer
  });

  const nextPlayerId = room.gameState.playerColors[room.gameState.currentPlayer];
  io.to(roomId).emit('player_turn', {
    color: room.gameState.currentPlayer,
    playerId: nextPlayerId,
    playerName: room.players?.[nextPlayerId]?.name || 'Player'
  });
  startTurnTimer(roomId);
}

function applyMove(roomId, color, tokenIndex, diceValue, actorId) {
  const room = rooms[roomId];
  if (!room || !room.gameState?.gameStarted) return;

  const currentStep = room.gameState.tokens[color][tokenIndex];
  let newStep = currentStep;
  let extraTurn = false;
  let killOccurred = false;

  if (currentStep === -1 && diceValue === 6) {
    newStep = 0;
  } else if (currentStep !== -1 && currentStep + diceValue <= 56) {
    newStep = currentStep + diceValue;
    if (requiresCutToHome(room) && currentStep <= 50 && newStep > 50) {
      if (!room.gameState.cutStatus || !room.gameState.cutStatus[color]) {
        return;
      }
    }
    if (newStep <= 50) {
      const targetIdx = (START_INDEX[color] + newStep) % 52;
      if (!SAFE_ZONES.includes(targetIdx)) {
        Object.keys(room.gameState.tokens).forEach(otherColor => {
          if (otherColor !== color && room.gameState.playerColors[otherColor]) {
            room.gameState.tokens[otherColor].forEach((step, idx) => {
              if (step >= 0 && step <= 50) {
                const enemyIdx = (START_INDEX[otherColor] + step) % 52;
                if (enemyIdx === targetIdx && !isSafePosition(otherColor, step)) {
                  room.gameState.tokens[otherColor][idx] = -1;
                  killOccurred = true;
                  extraTurn = true;
                }
              }
            });
          }
        });
      }
    }
  } else {
    return;
  }

  if (killOccurred) {
    if (!room.gameState.cutStatus) {
      room.gameState.cutStatus = { r: false, g: false, y: false, b: false };
    }
    room.gameState.cutStatus[color] = true;
  }

  room.gameState.tokens[color][tokenIndex] = newStep;

  let winner = null;
  if (room.gameState.tokens[color].every(s => s === 56)) {
    winner = color;
  }

  io.to(roomId).emit('token_moved', {
    playerId: actorId,
    color: color,
    tokenIndex: tokenIndex,
    newStep: newStep,
    diceValue: diceValue,
    tokens: room.gameState.tokens,
    killOccurred: killOccurred
  });

  extraTurn = extraTurn || diceValue === 6;
  if (!extraTurn || winner) {
    const colors = Object.keys(room.gameState.playerColors);
    const currentIndex = colors.indexOf(color);
    const nextIndex = (currentIndex + 1) % colors.length;
    room.gameState.currentPlayer = colors[nextIndex];
    room.gameState.diceValue = 0;
    const nextPlayerId = room.gameState.playerColors[room.gameState.currentPlayer];
    io.to(roomId).emit('player_turn', {
      color: room.gameState.currentPlayer,
      playerId: nextPlayerId,
      playerName: room.players[nextPlayerId]?.name || 'Player'
    });
    startTurnTimer(roomId);
  } else {
    room.gameState.diceValue = 0;
    io.to(roomId).emit('player_turn', {
      color: color,
      playerId: actorId,
      playerName: room.players[actorId]?.name || 'Player'
    });
    startTurnTimer(roomId);
  }

  if (winner) {
    clearTurnTimer(room);
    setTimeout(() => {
      io.to(roomId).emit('game_over', {
        winner: winner,
        winnerName: room.players[actorId]?.name || 'Player',
        winnerColor: winner
      });
      console.log(`Game over in room ${roomId}. Winner: ${winner}`);
    }, 1000);
  }
}

function buildPublicRoomsList() {
  return Object.entries(rooms)
    .filter(([_, room]) => room && room.isPublic && !room.gameState?.gameStarted)
    .map(([roomId, room]) => {
      const host = Object.values(room.players || {}).find(p => p.isHost);
      return {
        id: roomId,
        hostName: host?.name || 'Host',
        playerCount: room.playerCount || 0,
        maxPlayers: room.maxPlayers || MAX_PLAYERS,
        gameStarted: !!room.gameState?.gameStarted
      };
    });
}

// Helper function to generate room code
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Game logic constants (same as frontend)
const START_INDEX = { r: 0, g: 13, y: 26, b: 39 };
const SAFE_ZONES = [0, 8, 13, 21, 26, 34, 39, 47];

function isSafePosition(color, step) {
  if (step > 50) return true; // home-stretch lanes are safe
  if (step < 0) return true;
  const idx = (START_INDEX[color] + step) % 52;
  return SAFE_ZONES.includes(idx);
}

function getPairedColor(color) {
  const pairs = { r: 'y', y: 'r', g: 'b', b: 'g' };
  return pairs[color];
}

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('quick_play_join', (data = {}) => {
    const playerName = data.playerName || `Player${Math.floor(Math.random() * 1000)}`;
    socket.data = socket.data || {};
    socket.data.playerName = playerName;

    if (!quickPlayQueue.includes(socket.id)) {
      quickPlayQueue.push(socket.id);
    }

    emitQuickPlayQueueUpdate();
    if (quickPlayQueue.length >= DEFAULT_MAX_PLAYERS) {
      createQuickPlayRoom();
    }
  });

  socket.on('quick_play_cancel', () => {
    removeFromQuickPlayQueue(socket.id);
    emitQuickPlayQueueUpdate();
  });

  socket.on('no_move_possible', (data) => {
    const { roomId, playerColor } = data;

    console.log(`[SERVER] Player ${playerColor} has no moves in room ${roomId}`);

    const room = rooms[roomId];
    if (!room || !room.gameState) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    if (!room.gameState.gameStarted) {
      socket.emit('error', { message: 'Game not started' });
      return;
    }

    // Verify it's this player's turn
    if (room.gameState.currentPlayer !== playerColor) {
      socket.emit('error', { message: 'Not your turn' });
      return;
    }

    console.log(`[SERVER] Turn passed from ${playerColor}`);
    passTurn(roomId, playerColor);
  });
  // Create a new room
  socket.on('create_room', (data) => {
    try {
      const { playerName, isPublic } = data;
      const roomId = generateRoomCode();
      
      rooms[roomId] = {
        players: {
          [socket.id]: {
            id: socket.id,
            name: playerName || `Player${Object.keys(rooms).length + 1}`,
            isHost: true,
            ready: true,
            color: null,
            joinedAt: new Date().toISOString()
          }
        },
        playerCount: 1,
        maxPlayers: DEFAULT_MAX_PLAYERS,
        isPublic: !!isPublic,
        gameState: {
          players: {},
          playerColors: {},
          currentPlayer: null,
          diceValue: 0,
          gameStarted: false,
          settings: {},
          tokens: {
            r: [-1, -1, -1, -1],
            g: [-1, -1, -1, -1],
            y: [-1, -1, -1, -1],
            b: [-1, -1, -1, -1]
          }
        },
        createdAt: new Date().toISOString()
      };
      
      rooms[roomId].gameState.players[socket.id] = { 
        name: playerName,
        ready: true 
      };
      
      socket.join(roomId);
      
      socket.emit('room_created', {
        roomId,
        players: rooms[roomId].players,
        playerCount: 1,
        maxPlayers: rooms[roomId].maxPlayers,
        isPublic: rooms[roomId].isPublic,
        isHost: true
      });

      if (rooms[roomId].isPublic) {
        io.emit('public_rooms_list', { rooms: buildPublicRoomsList() });
      }
      
      console.log(`Room created: ${roomId} by ${playerName}`);
    } catch (error) {
      console.error('Error creating room:', error);
      socket.emit('error', { message: 'Failed to create room' });
    }
  });

  // Join an existing room
  socket.on('join_room', (data) => {
    try {
      const { roomId, playerName } = data;
      const roomCode = roomId.toUpperCase();
      
      console.log(`Join request for room: ${roomCode} by ${playerName}`);
      
      if (!rooms[roomCode]) {
        socket.emit('error', { message: 'Room not found. Check the code!' });
        return;
      }
      
      const roomMax = rooms[roomCode].maxPlayers || MAX_PLAYERS;
      if (rooms[roomCode].playerCount >= roomMax) {
        socket.emit('error', { message: `Room is full (${roomMax}/${roomMax} players)` });
        return;
      }
      
      // Check if player already in room
      if (rooms[roomCode].players[socket.id]) {
        socket.emit('error', { message: 'You are already in this room' });
        return;
      }
      
      // Add player to room
      rooms[roomCode].players[socket.id] = {
        id: socket.id,
        name: playerName || `Player${rooms[roomCode].playerCount + 1}`,
        isHost: false,
        ready: true,
        color: null,
        joinedAt: new Date().toISOString()
      };
      
      rooms[roomCode].playerCount++;
      rooms[roomCode].gameState.players[socket.id] = { 
        name: playerName,
        ready: true 
      };
      
      socket.join(roomCode);
      
      // Notify the joining player
      socket.emit('room_joined', {
        roomId: roomCode,
        players: rooms[roomCode].players,
        playerCount: rooms[roomCode].playerCount,
        playerColors: rooms[roomCode].gameState.playerColors || {},
        maxPlayers: rooms[roomCode].maxPlayers || MAX_PLAYERS,
        isPublic: rooms[roomCode].isPublic,
        isHost: false
      });
      
      // Notify other players in the room
      socket.to(roomCode).emit('player_joined', {
        newPlayerId: socket.id,
        players: rooms[roomCode].players,
        playerCount: rooms[roomCode].playerCount,
        playerColors: rooms[roomCode].gameState.playerColors || {},
        maxPlayers: rooms[roomCode].maxPlayers || MAX_PLAYERS
      });
      
      console.log(`${playerName} joined room ${roomCode} (${rooms[roomCode].playerCount}/${rooms[roomCode].maxPlayers || MAX_PLAYERS} players)`);
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // Select color
  socket.on('select_color', (data) => {
    try {
      const { roomId, color } = data;
      const room = rooms[roomId];
      
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      
      if (room.gameStarted) {
        socket.emit('error', { message: 'Game already started' });
        return;
      }

      if ((room.maxPlayers || MAX_PLAYERS) === 2) {
        const selectedColors = Object.keys(room.gameState.playerColors || {});
        if (selectedColors.length === 1) {
          const required = getPairedColor(selectedColors[0]);
          if (color !== required) {
            socket.emit('error', { message: `Only ${required.toUpperCase()} is available in 2-player mode` });
            return;
          }
        }
      }
      
      // Check if color is already taken
      if (room.gameState.playerColors[color] && room.gameState.playerColors[color] !== socket.id) {
        socket.emit('error', { message: `${color.toUpperCase()} is already taken!` });
        return;
      }
      
      // Remove player from previous color if any
      Object.keys(room.gameState.playerColors).forEach(c => {
        if (room.gameState.playerColors[c] === socket.id) {
          delete room.gameState.playerColors[c];
        }
      });
      
      // Assign new color
      room.gameState.playerColors[color] = socket.id;
      room.players[socket.id].color = color;
      
      // Broadcast to all in room
      io.to(roomId).emit('color_selected', {
        playerId: socket.id,
        color: color,
        players: room.players,
        playerColors: room.gameState.playerColors
      });
      
      console.log(`${room.players[socket.id].name} selected ${color} in room ${roomId}`);
    } catch (error) {
      console.error('Error selecting color:', error);
      socket.emit('error', { message: 'Failed to select color' });
    }
  });

  // Make room public
  socket.on('make_public', (data) => {
    try {
      const { roomId } = data;
      const room = rooms[roomId];

      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      const host = Object.values(room.players).find(p => p.isHost);
      if (!host || host.id !== socket.id) {
        socket.emit('error', { message: 'Only host can make room public' });
        return;
      }

      room.isPublic = true;
      socket.emit('room_public', { roomId });
      io.emit('public_rooms_list', { rooms: buildPublicRoomsList() });
    } catch (error) {
      console.error('Error making room public:', error);
      socket.emit('error', { message: 'Failed to make room public' });
    }
  });

  // Toggle public/private (host only)
  socket.on('set_public', (data) => {
    try {
      const { roomId, isPublic } = data;
      const room = rooms[roomId];

      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      const host = Object.values(room.players).find(p => p.isHost);
      if (!host || host.id !== socket.id) {
        socket.emit('error', { message: 'Only host can change room visibility' });
        return;
      }

      if (room.gameState?.gameStarted) {
        socket.emit('error', { message: 'Game already started' });
        return;
      }

      room.isPublic = !!isPublic;
      io.to(roomId).emit('room_updated', {
        roomId,
        playerCount: room.playerCount,
        maxPlayers: room.maxPlayers || MAX_PLAYERS,
        isPublic: room.isPublic
      });

      io.emit('public_rooms_list', { rooms: buildPublicRoomsList() });
    } catch (error) {
      console.error('Error setting room public:', error);
      socket.emit('error', { message: 'Failed to update room visibility' });
    }
  });

  // Set max players (host only)
  socket.on('set_max_players', (data) => {
    try {
      const { roomId, maxPlayers } = data;
      const room = rooms[roomId];

      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      const host = Object.values(room.players).find(p => p.isHost);
      if (!host || host.id !== socket.id) {
        socket.emit('error', { message: 'Only host can change max players' });
        return;
      }

      if (room.gameState?.gameStarted) {
        socket.emit('error', { message: 'Game already started' });
        return;
      }

      const nextMax = parseInt(maxPlayers, 10);
      if (![2, 4].includes(nextMax)) {
        socket.emit('error', { message: 'Invalid max players' });
        return;
      }

      if (room.playerCount > nextMax) {
        socket.emit('error', { message: `Too many players for ${nextMax}-player room` });
        return;
      }

      room.maxPlayers = nextMax;
      io.to(roomId).emit('room_updated', {
        roomId,
        playerCount: room.playerCount,
        maxPlayers: room.maxPlayers
      });

      if (room.isPublic) {
        io.emit('public_rooms_list', { rooms: buildPublicRoomsList() });
      }
    } catch (error) {
      console.error('Error setting max players:', error);
      socket.emit('error', { message: 'Failed to set max players' });
    }
  });

  // Get public rooms
  socket.on('get_public_rooms', () => {
    try {
      socket.emit('public_rooms_list', { rooms: buildPublicRoomsList() });
    } catch (error) {
      console.error('Error getting public rooms:', error);
      socket.emit('error', { message: 'Failed to get public rooms' });
    }
  });

  // Start game
  socket.on('start_game', (data) => {
    try {
      const { roomId, settings } = data;
      const room = rooms[roomId];
      
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      
      // Check if host
      const host = Object.values(room.players).find(p => p.isHost);
      if (!host || host.id !== socket.id) {
        socket.emit('error', { message: 'Only host can start the game' });
        return;
      }
      
      // Ensure at least 2 players
      if (room.playerCount < 2) {
        socket.emit('error', { message: 'Need at least 2 players to start' });
        return;
      }

      // Auto-assign colors if some players haven't selected yet
      const colors = ['r', 'g', 'y', 'b'];
      const selectedColors = Object.keys(room.gameState.playerColors || {});
      const usedColors = new Set(selectedColors);
      const playersWithoutColors = Object.values(room.players).filter(p => !p.color);

      if (playersWithoutColors.length > 0) {
        for (const player of playersWithoutColors) {
          let freeColor = colors.find(c => !usedColors.has(c));

          if ((room.maxPlayers || MAX_PLAYERS) === 2 && usedColors.size === 1) {
            const existing = Array.from(usedColors)[0];
            const paired = getPairedColor(existing);
            if (paired && !usedColors.has(paired)) {
              freeColor = paired;
            }
          }

          if (!freeColor) {
            socket.emit('error', { message: 'No available colors to assign' });
            return;
          }
          usedColors.add(freeColor);
          player.color = freeColor;
          room.gameState.playerColors[freeColor] = player.id;
        }
      }

      const finalSelectedColors = Object.keys(room.gameState.playerColors);
      if (finalSelectedColors.length < 2) {
        socket.emit('error', { message: 'Need at least 2 players to start' });
        return;
      }
      
      // Set game state
      room.gameState.gameStarted = true;
      room.isPublic = false;
      room.gameState.settings = settings || {};
      room.gameState.cutStatus = { r: false, g: false, y: false, b: false };
      room.gameState.currentPlayer = finalSelectedColors[0];
      room.gameState.diceValue = 0;
      
      // Reset tokens for all playing colors
      finalSelectedColors.forEach(color => {
        room.gameState.tokens[color] = [-1, -1, -1, -1];
      });
      
      // Broadcast game start
      io.to(roomId).emit('game_started', {
        settings: room.gameState.settings,
        playerColors: room.gameState.playerColors,
        currentPlayer: room.gameState.currentPlayer,
        tokens: room.gameState.tokens
      });
      
      // Notify first player's turn
      const firstPlayerId = room.gameState.playerColors[room.gameState.currentPlayer];
      io.to(roomId).emit('player_turn', {
        color: room.gameState.currentPlayer,
        playerId: firstPlayerId,
        playerName: room.players[firstPlayerId]?.name || 'Player'
      });
      startTurnTimer(roomId);
      
      console.log(`Game started in room ${roomId} with ${finalSelectedColors.length} players`);
    } catch (error) {
      console.error('Error starting game:', error);
      socket.emit('error', { message: 'Failed to start game' });
    }
  });

  // Restart game (host only)
  socket.on('restart_game', (data) => {
    try {
      const { roomId } = data;
      const room = rooms[roomId];

      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      const host = Object.values(room.players).find(p => p.isHost);
      if (!host || host.id !== socket.id) {
        socket.emit('error', { message: 'Only host can restart the game' });
        return;
      }

      const selectedColors = Object.keys(room.gameState.playerColors);
      if (selectedColors.length < 2) {
        socket.emit('error', { message: 'Need at least 2 players to restart' });
        return;
      }

      // Reset tokens and state
      room.gameState.gameStarted = true;
      room.gameState.diceValue = 0;
      room.gameState.currentPlayer = selectedColors[0];
      room.gameState.cutStatus = { r: false, g: false, y: false, b: false };
      selectedColors.forEach(color => {
        room.gameState.tokens[color] = [-1, -1, -1, -1];
      });

      io.to(roomId).emit('game_started', {
        settings: room.gameState.settings || {},
        playerColors: room.gameState.playerColors,
        currentPlayer: room.gameState.currentPlayer,
        tokens: room.gameState.tokens
      });

      const firstPlayerId = room.gameState.playerColors[room.gameState.currentPlayer];
      io.to(roomId).emit('player_turn', {
        color: room.gameState.currentPlayer,
        playerId: firstPlayerId,
        playerName: room.players[firstPlayerId]?.name || 'Player'
      });
      startTurnTimer(roomId);
      console.log(`Game restarted in room ${roomId}`);
    } catch (error) {
      console.error('Error restarting game:', error);
      socket.emit('error', { message: 'Failed to restart game' });
    }
  });

  // Roll dice
  socket.on('roll_dice', (data) => {
    try {
      const { roomId } = data;
      const room = rooms[roomId];
      
      if (!room || !room.gameState.gameStarted) {
        socket.emit('error', { message: 'Game not started' });
        return;
      }
      
      // Check if it's this player's turn
      const currentColor = room.gameState.currentPlayer;
      const currentPlayerId = room.gameState.playerColors[currentColor];
      
      if (currentPlayerId !== socket.id) {
        socket.emit('error', { message: 'Not your turn!' });
        return;
      }
      if (room.gameState.diceValue !== 0) {
        socket.emit('error', { message: 'Dice already rolled this turn' });
        return;
      }
      
      // Roll dice (1-6)
      const diceValue = Math.floor(Math.random() * 6) + 1;
      room.gameState.diceValue = diceValue;
      clearTurnTimer(room);
      
      // Broadcast dice roll
      io.to(roomId).emit('dice_rolled', {
        playerId: socket.id,
        playerColor: currentColor,
        playerName: room.players[socket.id]?.name || 'Player',
        value: diceValue
      });
      
      console.log(`${room.players[socket.id]?.name} rolled ${diceValue} in room ${roomId}`);
    } catch (error) {
      console.error('Error rolling dice:', error);
      socket.emit('error', { message: 'Failed to roll dice' });
    }
  });

  // Move token
  socket.on('move_token', (data) => {
    try {
      const { roomId, color, tokenIndex, diceValue } = data;
      const room = rooms[roomId];
      
      if (!room || !room.gameState.gameStarted) {
        socket.emit('error', { message: 'Game not started' });
        return;
      }
      
      // Check if it's this player's turn
      if (room.gameState.currentPlayer !== color) {
        socket.emit('error', { message: 'Not your turn!' });
        return;
      }
      
      // Check if dice value matches
      if (room.gameState.diceValue !== diceValue) {
        socket.emit('error', { message: 'Invalid dice value' });
        return;
      }
      
      applyMove(roomId, color, tokenIndex, diceValue, socket.id);
      console.log(`${room.players[socket.id]?.name} moved ${color} token ${tokenIndex}`);
    } catch (error) {
      console.error('Error moving token:', error);
      socket.emit('error', { message: 'Failed to move token' });
    }
  });

  // Leave room
  socket.on('leave_room', (data) => {
    try {
      const { roomId } = data;
      const room = rooms[roomId];
      
      if (room) {
        const leavingPlayer = room.players[socket.id];
        const playerName = leavingPlayer?.name || 'Player';
        const leavingWasHost = !!leavingPlayer?.isHost;
        
        // Remove player from room
        delete room.players[socket.id];
        room.playerCount--;
        
        // Remove player's color selection
        if (room.gameState && room.gameState.playerColors) {
          Object.keys(room.gameState.playerColors).forEach(color => {
            if (room.gameState.playerColors[color] === socket.id) {
              delete room.gameState.playerColors[color];
            }
          });
        }
        
        // If host leaves, assign new host
        if (leavingWasHost && room.playerCount > 0) {
          Object.values(room.players).forEach(p => {
            p.isHost = false;
          });
          const newHostId = Object.keys(room.players)[0];
          if (newHostId) {
            room.players[newHostId].isHost = true;
          }
        }
        
        // If room becomes empty, delete it
        if (room.playerCount === 0) {
          delete rooms[roomId];
          console.log(`Room ${roomId} deleted (empty)`);
        } else {
          // Notify remaining players
          socket.to(roomId).emit('player_left', {
            leftPlayerId: socket.id,
            leftPlayerName: playerName,
            players: room.players,
            playerCount: room.playerCount,
            playerColors: room.gameState?.playerColors || {},
            maxPlayers: room.maxPlayers || MAX_PLAYERS,
            newHost: room.players[Object.keys(room.players)[0]]?.id
          });
          console.log(`${playerName} left room ${roomId} (${room.playerCount} players remaining)`);
        }
      }
      
      socket.leave(roomId);
    } catch (error) {
      console.error('Error leaving room:', error);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    removeFromQuickPlayQueue(socket.id);
    emitQuickPlayQueueUpdate();
    
    // Find and clean up rooms this player was in
    Object.keys(rooms).forEach(roomId => {
      const room = rooms[roomId];
      if (room && room.players[socket.id]) {
        const leavingPlayer = room.players[socket.id];
        const playerName = leavingPlayer?.name || 'Player';
        const leavingWasHost = !!leavingPlayer?.isHost;
        
        delete room.players[socket.id];
        room.playerCount--;
        
        // Remove player's color selection
        if (room.gameState && room.gameState.playerColors) {
          Object.keys(room.gameState.playerColors).forEach(color => {
            if (room.gameState.playerColors[color] === socket.id) {
              delete room.gameState.playerColors[color];
            }
          });
        }
        
        // If host leaves, assign new host
        if (leavingWasHost && room.playerCount > 0) {
          Object.values(room.players).forEach(p => {
            p.isHost = false;
          });
          const newHostId = Object.keys(room.players)[0];
          if (newHostId) {
            room.players[newHostId].isHost = true;
          }
        }
        
        // If room becomes empty, delete it
        if (room.playerCount === 0) {
          delete rooms[roomId];
          console.log(`Room ${roomId} deleted (empty after disconnect)`);
        } else {
          // Notify remaining players
          io.to(roomId).emit('player_left', {
            leftPlayerId: socket.id,
            leftPlayerName: playerName,
            players: room.players,
            playerCount: room.playerCount,
            playerColors: room.gameState?.playerColors || {},
            maxPlayers: room.maxPlayers || MAX_PLAYERS,
            newHost: room.players[Object.keys(room.players)[0]]?.id
          });
          console.log(`${playerName} disconnected from room ${roomId} (${room.playerCount} players remaining)`);
        }
      }
    });
  });

  // Ping to keep connection alive
  socket.on('ping', () => {
    socket.emit('pong');
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Ludo Server running on port ${PORT}`);
  console.log(`📱 Access at: http://localhost:${PORT}`);
  console.log(`🎮 Waiting for players to connect...`);
});

// Clean up empty rooms every hour
setInterval(() => {
  const now = new Date();
  Object.keys(rooms).forEach(roomId => {
    const room = rooms[roomId];
    if (room.playerCount === 0) {
      const roomAge = new Date(room.createdAt);
      const hoursOld = (now - roomAge) / (1000 * 60 * 60);
      if (hoursOld > 2) {
        delete rooms[roomId];
        console.log(`Cleaned up old room: ${roomId}`);
      }
    }
  });
}, 60 * 60 * 1000); // Every hour
