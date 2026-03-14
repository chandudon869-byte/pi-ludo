require('dotenv').config();

const apiKey = process.env.PI_SERVER_API_KEY;
const mongoUri = process.env.MONGODB_URI;

const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const socketIo = require('socket.io');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from current directory
app.use(express.static(__dirname));

const COIN_ENTRY_FEE = parseInt(process.env.COIN_ENTRY_FEE || '10', 10);
const COIN_HOUSE_FEE_PERCENT = parseInt(process.env.COIN_HOUSE_FEE_PERCENT || '10', 10);
const COIN_STARTING_BALANCE = parseInt(process.env.COIN_STARTING_BALANCE || '500', 10);
const COIN_DAILY_REWARD = parseInt(process.env.COIN_DAILY_REWARD || '50', 10);
const COIN_ROOM_FEES = (process.env.COIN_ROOM_FEES || '10')
  .split(',')
  .map(v => parseInt(v.trim(), 10))
  .filter(v => Number.isFinite(v) && v > 0);

let mongoClient = null;
let mongoDb = null;
let playersCollection = null;
let purchasesCollection = null;

const COIN_PACKS = [
  { id: 'pi-1', piAmount: 1, coins: 50 },
  { id: 'pi-2', piAmount: 2, coins: 100 },
  { id: 'pi-5', piAmount: 5, coins: 300 },
  { id: 'pi-10', piAmount: 10, coins: 600 }
];

function getPackById(packId) {
  return COIN_PACKS.find(pack => pack.id === packId) || null;
}

function createOrderId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `order_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function initMongo() {
  if (mongoDb && playersCollection && purchasesCollection) return;
  if (!mongoUri) {
    console.warn('MONGODB_URI not set; coin system will be disabled.');
    return;
  }
  mongoClient = mongoClient || new MongoClient(mongoUri, { });
  await mongoClient.connect();
  mongoDb = mongoClient.db(process.env.MONGODB_DB || 'ludo');
  playersCollection = mongoDb.collection('players');
  purchasesCollection = mongoDb.collection('purchases');
  await playersCollection.createIndex({ updatedAt: 1 });
  await purchasesCollection.createIndex({ paymentId: 1 }, { unique: true, sparse: true });
  await purchasesCollection.createIndex({ txid: 1 }, { unique: true, sparse: true });
  await purchasesCollection.createIndex({ createdAt: 1 });
  console.log('Connected to MongoDB for coin system.');
}

async function ensurePlayerDoc(playerUid) {
  if (!playersCollection) return null;
  await playersCollection.updateOne(
    { _id: playerUid },
    {
      $setOnInsert: {
        balance: COIN_STARTING_BALANCE,
        createdAt: new Date(),
        lastDailyClaim: null
      },
      $set: { updatedAt: new Date() }
    },
    { upsert: true }
  );
  return playersCollection.findOne({ _id: playerUid });
}

async function updatePlayerProfile(playerUid, name) {
  if (!playersCollection || !playerUid) return;
  if (!name) return;
  await playersCollection.updateOne(
    { _id: playerUid },
    { $set: { name: String(name).slice(0, 24), updatedAt: new Date() } }
  );
}

function getAllowedEntryFee(requested) {
  const allowed = COIN_ROOM_FEES.length > 0 ? COIN_ROOM_FEES : [COIN_ENTRY_FEE];
  if (allowed.includes(requested)) return requested;
  if (allowed.includes(COIN_ENTRY_FEE)) return COIN_ENTRY_FEE;
  return allowed[0];
}

async function getBalance(playerUid) {
  if (!playersCollection) return null;
  const doc = await ensurePlayerDoc(playerUid);
  return doc?.balance ?? null;
}

async function debitBalance(playerUid, amount) {
  if (!playersCollection) return { ok: false, disabled: true, reason: 'Coin system unavailable' };
  await ensurePlayerDoc(playerUid);
  const res = await playersCollection.findOneAndUpdate(
    { _id: playerUid, balance: { $gte: amount } },
    { $inc: { balance: -amount }, $set: { updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!res?.value) return { ok: false };
  return { ok: true, balance: res.value.balance };
}

async function creditBalance(playerUid, amount) {
  if (!playersCollection) return { ok: false, balance: null, disabled: true };
  await ensurePlayerDoc(playerUid);
  const res = await playersCollection.findOneAndUpdate(
    { _id: playerUid },
    { $inc: { balance: amount }, $set: { updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  return { ok: true, balance: res?.value?.balance ?? null };
}

function getDailyInfo(doc) {
  const last = doc?.lastDailyClaim ? new Date(doc.lastDailyClaim).getTime() : 0;
  const now = Date.now();
  const next = last ? last + 24 * 60 * 60 * 1000 : 0;
  const canClaimDaily = !last || now >= next;
  return {
    canClaimDaily,
    nextDailyClaimAt: canClaimDaily ? null : new Date(next).toISOString()
  };
}

function initRoomCoins(room) {
  if (!room) return;
  if (!room.coin) {
    room.coin = {
      entryFee: COIN_ENTRY_FEE,
      houseFeePercent: COIN_HOUSE_FEE_PERCENT,
      pool: 0,
      participants: {}
    };
  }
}

async function chargeEntryFee(room, socket, playerUid) {
  initRoomCoins(room);
  if (!playerUid) return { ok: false, reason: 'Missing player identity' };
  if (room.coin.participants[playerUid]) {
    return { ok: true, balance: await getBalance(playerUid) };
  }
  const res = await debitBalance(playerUid, room.coin.entryFee);
  if (!res.ok) {
    return { ok: false, reason: res.reason || 'Insufficient coins' };
  }
  room.coin.participants[playerUid] = true;
  room.coin.pool += room.coin.entryFee;
  if (socket) {
    socket.emit('coins_updated', {
      balance: res.balance,
      entryFee: room.coin.entryFee,
      houseFeePercent: room.coin.houseFeePercent
    });
  }
  return { ok: true, balance: res.balance };
}

async function refundEntryFee(room, playerUid) {
  if (!room?.coin || !room.coin.participants?.[playerUid]) return;
  const amount = room.coin.entryFee;
  delete room.coin.participants[playerUid];
  room.coin.pool = Math.max(0, room.coin.pool - amount);
  await creditBalance(playerUid, amount);
}

async function payOutWinner(room, winnerUid) {
  if (!room?.coin || !winnerUid) return;
  const pool = room.coin.pool || 0;
  const feePct = room.coin.houseFeePercent || 0;
  const fee = Math.max(0, Math.round(pool * (feePct / 100)));
  const prize = Math.max(0, pool - fee);
  if (prize > 0) {
    await creditBalance(winnerUid, prize);
  }
  room.coin.pool = 0;
  return { prize, fee };
}

async function emitCoinsUpdate(socketId, playerUid, room = null) {
  if (!socketId || !playerUid) return;
  const balance = await getBalance(playerUid);
  io.to(socketId).emit('coins_updated', {
    balance: balance ?? 0,
    entryFee: room?.coin?.entryFee ?? COIN_ENTRY_FEE,
    houseFeePercent: room?.coin?.houseFeePercent ?? COIN_HOUSE_FEE_PERCENT
  });
}

app.get('/api/coins/balance', async (req, res) => {
  try {
    await initMongo();
    const playerUid = String(req.query.playerUid || '').trim();
    if (!playerUid) {
      res.status(400).json({ error: 'Missing playerUid' });
      return;
    }
    const doc = await ensurePlayerDoc(playerUid);
    const balance = doc?.balance ?? 0;
    const daily = getDailyInfo(doc);
    res.json({
      balance: balance ?? 0,
      entryFee: COIN_ENTRY_FEE,
      houseFeePercent: COIN_HOUSE_FEE_PERCENT,
      canClaimDaily: daily.canClaimDaily,
      nextDailyClaimAt: daily.nextDailyClaimAt
    });
  } catch (error) {
    console.error('Balance error:', error);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

app.post('/api/coins/claim-daily', async (req, res) => {
  try {
    await initMongo();
    const playerUid = String(req.body?.playerUid || '').trim();
    if (!playerUid) {
      res.status(400).json({ error: 'Missing playerUid' });
      return;
    }
    const doc = await ensurePlayerDoc(playerUid);
    const daily = getDailyInfo(doc);
    if (!daily.canClaimDaily) {
      res.json({
        balance: doc?.balance ?? 0,
        canClaimDaily: false,
        nextDailyClaimAt: daily.nextDailyClaimAt
      });
      return;
    }
    const now = new Date();
    const updated = await playersCollection.findOneAndUpdate(
      { _id: playerUid },
      {
        $inc: { balance: COIN_DAILY_REWARD },
        $set: { lastDailyClaim: now, updatedAt: now }
      },
      { returnDocument: 'after' }
    );
    const nextDaily = getDailyInfo(updated?.value);
    res.json({
      balance: updated?.value?.balance ?? 0,
      canClaimDaily: nextDaily.canClaimDaily,
      nextDailyClaimAt: nextDaily.nextDailyClaimAt
    });
  } catch (error) {
    console.error('Claim daily error:', error);
    res.status(500).json({ error: 'Failed to claim daily reward' });
  }
});

app.get('/api/coins/leaderboard', async (req, res) => {
  try {
    await initMongo();
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || '10', 10), 50));
    const rows = await playersCollection
      .find({}, { projection: { name: 1, balance: 1 } })
      .sort({ balance: -1 })
      .limit(limit)
      .toArray();
    res.json({
      rows: rows.map(r => ({
        name: r.name || 'Player',
        balance: r.balance || 0
      }))
    });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

app.post('/api/players/profile', async (req, res) => {
  try {
    await initMongo();
    const playerUid = String(req.body?.playerUid || '').trim();
    const name = String(req.body?.name || '').trim();
    if (!playerUid || !name) {
      res.status(400).json({ error: 'Missing playerUid or name' });
      return;
    }
    await updatePlayerProfile(playerUid, name);
    res.json({ ok: true });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

app.post('/api/coins/create-order', async (req, res) => {
  try {
    await initMongo();
    if (!purchasesCollection) {
      res.status(503).json({ error: 'Coin system unavailable' });
      return;
    }
    const playerUid = String(req.body?.playerUid || '').trim();
    const packId = String(req.body?.packId || '').trim();
    if (!playerUid || !packId) {
      res.status(400).json({ error: 'Missing playerUid or packId' });
      return;
    }
    const pack = getPackById(packId);
    if (!pack) {
      res.status(400).json({ error: 'Invalid packId' });
      return;
    }
    await ensurePlayerDoc(playerUid);
    const orderId = createOrderId();
    const now = new Date();
    await purchasesCollection.insertOne({
      _id: orderId,
      playerUid,
      packId: pack.id,
      coins: pack.coins,
      piAmount: pack.piAmount,
      status: 'created',
      createdAt: now,
      updatedAt: now
    });
    res.json({
      orderId,
      packId: pack.id,
      coins: pack.coins,
      piAmount: pack.piAmount,
      memo: `Ludo Coins +${pack.coins}`,
      metadata: {
        orderId,
        packId: pack.id,
        coins: pack.coins,
        playerUid
      }
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

function piApiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!apiKey) {
      reject(new Error('PI_SERVER_API_KEY not set'));
      return;
    }

    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.minepi.com',
        path: `/v2${path}`,
        method,
        headers: {
          Authorization: `Key ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': payload ? Buffer.byteLength(payload) : 0
        }
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (error) {
            parsed = raw || null;
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
            return;
          }

          const err = new Error(`Pi API ${res.statusCode}`);
          err.statusCode = res.statusCode;
          err.body = parsed;
          reject(err);
        });
      }
    );

    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function extractPaymentField(payment, key) {
  if (!payment || typeof payment !== 'object') return undefined;
  if (payment[key] !== undefined) return payment[key];
  if (payment.payment && payment.payment[key] !== undefined) return payment.payment[key];
  if (payment.data && payment.data[key] !== undefined) return payment.data[key];
  return undefined;
}

function parseMetadata(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// Health route for backend-only deployments (e.g., frontend hosted on Netlify)
app.get('/', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'ludo-server',
    socketPath: '/socket.io'
  });
});

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true });
});

async function handlePaymentApprove(req, res) {
  const { paymentId, orderId } = req.body || {};
  if (!paymentId || !orderId) {
    res.status(400).json({ success: false, error: 'Missing paymentId or orderId' });
    return;
  }
  try {
    await initMongo();
    if (!purchasesCollection) {
      res.status(503).json({ success: false, error: 'Coin system unavailable' });
      return;
    }
    const order = await purchasesCollection.findOne({ _id: orderId });
    if (!order) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }
    await piApiRequest('POST', `/payments/${paymentId}/approve`, null);
    await purchasesCollection.updateOne(
      { _id: orderId },
      { $set: { paymentId, status: 'approved', updatedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Pi approve error:', error?.body || error?.message || error);
    res.status(502).json({
      success: false,
      error: 'Pi approve failed',
      details: error?.body || error?.message || 'Unknown error'
    });
  }
}

async function handlePaymentComplete(req, res) {
  const { paymentId, txid } = req.body || {};
  if (!paymentId || !txid) {
    res.status(400).json({ success: false, error: 'Missing paymentId or txid' });
    return;
  }

  try {
    await initMongo();
    if (!purchasesCollection) {
      res.status(503).json({ success: false, error: 'Coin system unavailable' });
      return;
    }
    const order = await purchasesCollection.findOne({ paymentId });
    if (!order) {
      res.status(404).json({ success: false, error: 'Order not found for payment' });
      return;
    }
    if (order.status === 'completed') {
      const balance = await getBalance(order.playerUid);
      res.json({ success: true, balance });
      return;
    }

    await piApiRequest('POST', `/payments/${paymentId}/complete`, { txid });

    let paymentInfo = null;
    try {
      paymentInfo = await piApiRequest('GET', `/payments/${paymentId}`, null);
    } catch (error) {
      paymentInfo = null;
    }

    const paymentAmount = Number(extractPaymentField(paymentInfo, 'amount'));
    const paymentMetadata = parseMetadata(extractPaymentField(paymentInfo, 'metadata'));
    const metadataOk = paymentMetadata
      && paymentMetadata.orderId === order._id
      && paymentMetadata.packId === order.packId
      && paymentMetadata.playerUid === order.playerUid
      && Number(paymentMetadata.coins) === Number(order.coins);

    if (!metadataOk || (Number.isFinite(paymentAmount) && paymentAmount !== Number(order.piAmount))) {
      await purchasesCollection.updateOne(
        { _id: order._id },
        { $set: { status: 'mismatch', txid, updatedAt: new Date(), paymentInfo } }
      );
      res.status(400).json({ success: false, error: 'Payment metadata mismatch' });
      return;
    }

    const credit = await creditBalance(order.playerUid, order.coins);
    await purchasesCollection.updateOne(
      { _id: order._id },
      {
        $set: {
          status: 'completed',
          txid,
          updatedAt: new Date(),
          paymentInfo
        }
      }
    );
    res.json({ success: true, balance: credit.balance });
  } catch (error) {
    console.error('Pi complete error:', error?.body || error?.message || error);
    res.status(502).json({
      success: false,
      error: 'Pi complete failed',
      details: error?.body || error?.message || 'Unknown error'
    });
  }
}

app.post('/approve', handlePaymentApprove);
app.post('/complete', handlePaymentComplete);
app.post('/api/payments/approve', handlePaymentApprove);
app.post('/api/payments/complete', handlePaymentComplete);

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
const RECONNECT_GRACE_MS = 60000;
const quickPlayQueues = {};
const socketToPlayerUid = {};

function replacePlayerIdInRoom(room, oldId, newId) {
  if (!room || !room.players || !room.players[oldId]) return null;
  const existing = room.players[oldId];
  room.players[newId] = {
    ...existing,
    id: newId,
    connected: true,
    disconnectedAt: null,
    lastReconnectAt: new Date().toISOString()
  };
  delete room.players[oldId];

  if (room.gameState?.players?.[oldId]) {
    room.gameState.players[newId] = room.gameState.players[oldId];
    delete room.gameState.players[oldId];
  }

  if (room.gameState?.playerColors) {
    Object.keys(room.gameState.playerColors).forEach(color => {
      if (room.gameState.playerColors[color] === oldId) {
        room.gameState.playerColors[color] = newId;
      }
    });
  }

  return room.players[newId];
}

function removePlayerFromRoom(roomId, playerId, reason = "left") {
  const room = rooms[roomId];
  if (!room || !room.players[playerId]) return;

  const leavingPlayer = room.players[playerId];
  const playerName = leavingPlayer?.name || "Player";
  const leavingWasHost = !!leavingPlayer?.isHost;
  const playerUid = leavingPlayer?.playerUid || null;

  delete room.players[playerId];
  room.playerCount--;

  if (room.gameState?.players?.[playerId]) {
    delete room.gameState.players[playerId];
  }

  if (room.gameState?.playerColors) {
    Object.keys(room.gameState.playerColors).forEach(color => {
      if (room.gameState.playerColors[color] === playerId) {
        delete room.gameState.playerColors[color];
      }
    });
  }

  if (leavingWasHost && room.playerCount > 0) {
    Object.values(room.players).forEach(p => {
      p.isHost = false;
    });
    const connectedHost = Object.keys(room.players).find(id => room.players[id]?.connected !== false);
    const newHostId = connectedHost || Object.keys(room.players)[0];
    if (newHostId) {
      room.players[newHostId].isHost = true;
    }
  }

  if (room.playerCount === 0) {
    delete rooms[roomId];
    console.log(`Room ${roomId} deleted (empty)`);
  } else {
    io.to(roomId).emit("player_left", {
      leftPlayerId: playerId,
      leftPlayerName: playerName,
      players: room.players,
      playerCount: room.playerCount,
      playerColors: room.gameState?.playerColors || {},
      maxPlayers: room.maxPlayers || MAX_PLAYERS,
      newHost: (Object.values(room.players).find(p => p?.isHost) || {}).id,
      reason
    });
    console.log(`${playerName} removed from room ${roomId} (${room.playerCount} players remaining)`);
  }

  if (!room?.gameState?.gameStarted && playerUid) {
    refundEntryFee(room, playerUid).catch((err) => {
      console.error('Refund error:', err);
    });
  }
}

function removeFromQuickPlayQueue(socketId) {
  Object.keys(quickPlayQueues).forEach(key => {
    const queue = quickPlayQueues[key];
    if (!Array.isArray(queue)) return;
    const idx = queue.indexOf(socketId);
    if (idx !== -1) {
      queue.splice(idx, 1);
    }
  });
}

function getSocketPlayerUid(socket, data = {}) {
  return (
    data.playerUid ||
    socket?.handshake?.auth?.playerUid ||
    socket?.data?.playerUid ||
    null
  );
}

function findRoomPlayerByUid(playerUid, preferredRoomId = null) {
  if (!playerUid) return null;
  const roomIds = preferredRoomId ? [preferredRoomId] : Object.keys(rooms);
  for (const roomId of roomIds) {
    const room = rooms[roomId];
    if (!room?.players) continue;
    for (const [sid, p] of Object.entries(room.players)) {
      if (p?.playerUid === playerUid) {
        return { roomId, socketId: sid, player: p, room };
      }
    }
  }
  return null;
}

function emitQuickPlayQueueUpdate(queueSize, entryFee) {
  const key = `${queueSize}_${entryFee}`;
  const queue = quickPlayQueues[key] || [];
  const payload = { count: queue.length, maxPlayers: queueSize, entryFee };
  console.log(`[QP] Queue ${queueSize} fee ${entryFee}: ${queue.length} waiting`);
  queue.forEach(id => {
    const s = io.sockets.sockets.get(id);
    if (s) {
      s.emit('quick_play_queue_update', payload);
    }
  });
}

async function createQuickPlayRoom(queueSize, entryFee) {
  const size = [2, 4].includes(queueSize) ? queueSize : DEFAULT_MAX_PLAYERS;
  const fee = getAllowedEntryFee(entryFee);
  const key = `${size}_${fee}`;
  const queue = quickPlayQueues[key] || [];
  console.log(`[QP] Attempting match for ${size} fee ${fee}. Queue size: ${queue.length}`);
  const playersToMatch = [];
  while (playersToMatch.length < size && queue.length > 0) {
    const id = queue.shift();
    const s = io.sockets.sockets.get(id);
    if (s) {
      playersToMatch.push(s);
    }
  }

  if (playersToMatch.length < size) {
    // Not enough valid sockets, put them back and update queue
    playersToMatch.forEach(s => queue.unshift(s.id));
    emitQuickPlayQueueUpdate(size, fee);
    return;
  }

  await initMongo();
  const paidSockets = [];
  for (const s of playersToMatch) {
    const playerUid = getSocketPlayerUid(s, s.data || {});
    if (!playerUid) {
      s.emit('error', { message: 'Missing player identity for coins.' });
      continue;
    }
    const debit = await debitBalance(playerUid, fee);
    if (!debit.ok) {
      const message = debit.disabled
        ? 'Coin system unavailable. Try again later.'
        : `Not enough coins. Entry fee is ${fee}.`;
      s.emit('error', { message });
      continue;
    }
    s.emit('coins_updated', {
      balance: debit.balance,
      entryFee: fee,
      houseFeePercent: COIN_HOUSE_FEE_PERCENT
    });
    paidSockets.push({ socket: s, playerUid });
  }

  if (paidSockets.length < size) {
    for (const paid of paidSockets) {
      await creditBalance(paid.playerUid, fee);
      paid.socket.emit('coins_updated', {
        balance: await getBalance(paid.playerUid),
        entryFee: fee,
        houseFeePercent: COIN_HOUSE_FEE_PERCENT
      });
      queue.unshift(paid.socket.id);
    }
    emitQuickPlayQueueUpdate(size, fee);
    return;
  }

  const roomId = generateRoomCode();
  console.log(`[QP] Creating room ${roomId} for ${playersToMatch.length} players (target ${size})`);
  rooms[roomId] = {
    players: {},
    playerCount: 0,
    maxPlayers: size,
    isPublic: false,
    coin: {
      entryFee: fee,
      houseFeePercent: COIN_HOUSE_FEE_PERCENT,
      pool: fee * paidSockets.length,
      participants: {}
    },
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

  paidSockets.forEach((entry, idx) => {
    const s = entry.socket;
    const isHost = idx === 0;
    const name = s.data?.playerName || `Player${Object.keys(rooms[roomId].players).length + 1}`;
    const avatar = s.data?.playerAvatar || null;
    rooms[roomId].coin.participants[entry.playerUid] = true;
    rooms[roomId].players[s.id] = {
      id: s.id,
      playerUid: entry.playerUid || s.data?.playerUid || socketToPlayerUid[s.id] || null,
      name,
      avatar,
      isHost,
      ready: true,
      color: null,
      connected: true,
      disconnectedAt: null,
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

  paidSockets.forEach((entry, idx) => {
    const s = entry.socket;
    if (idx === 0) {
      s.emit('room_created', { ...payload, isHost: true });
    } else {
      s.emit('room_joined', { ...payload, isHost: false });
    }
  });

  emitQuickPlayQueueUpdate(size, fee);
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

async function applyMove(roomId, color, tokenIndex, diceValue, actorId) {
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
    const winnerPlayerId = room.gameState.playerColors[winner];
    const winnerUid = room.players[winnerPlayerId]?.playerUid || null;
    const payout = await payOutWinner(room, winnerUid);
    if (winnerPlayerId && winnerUid) {
      await emitCoinsUpdate(winnerPlayerId, winnerUid, room);
    }
    setTimeout(() => {
      io.to(roomId).emit('game_over', {
        winner: winner,
        winnerName: room.players[actorId]?.name || 'Player',
        winnerColor: winner,
        prize: payout?.prize ?? 0,
        fee: payout?.fee ?? 0
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
        gameStarted: !!room.gameState?.gameStarted,
        entryFee: room.coin?.entryFee || COIN_ENTRY_FEE
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
  const authPlayerUid = getSocketPlayerUid(socket);
  if (authPlayerUid) {
    socket.data = socket.data || {};
    socket.data.playerUid = authPlayerUid;
    socketToPlayerUid[socket.id] = authPlayerUid;
  }

  socket.on('reconnect_player', async (data = {}) => {
    try {
      const playerUid = getSocketPlayerUid(socket, data);
      const roomId = (data.roomId || '').toUpperCase();
      if (!playerUid || !roomId) {
        socket.emit('reconnect_failed', { message: 'Missing reconnect identity' });
        return;
      }

      await initMongo();

      const found = findRoomPlayerByUid(playerUid, roomId);
      if (!found) {
        socket.emit('reconnect_failed', { message: 'No reconnect session found' });
        return;
      }

      const room = found.room;
      const oldSocketId = found.socketId;
      const player = found.player;
      const disconnectedAt = player?.disconnectedAt ? new Date(player.disconnectedAt).getTime() : null;
      const now = Date.now();
      if (disconnectedAt && now - disconnectedAt > RECONNECT_GRACE_MS) {
        socket.emit('reconnect_failed', { message: 'Reconnect window expired' });
        return;
      }

      // Replace socket id everywhere in room state
      if (oldSocketId !== socket.id) {
        replacePlayerIdInRoom(room, oldSocketId, socket.id);
      } else if (room.players[socket.id]) {
        room.players[socket.id].connected = true;
        room.players[socket.id].disconnectedAt = null;
      }

      socket.data = socket.data || {};
      socket.data.playerUid = playerUid;
      socket.data.playerName = room.players[socket.id]?.name || socket.data.playerName;
      socket.data.playerAvatar = room.players[socket.id]?.avatar || socket.data.playerAvatar;
      socketToPlayerUid[socket.id] = playerUid;

      removeFromQuickPlayQueue(oldSocketId);
      removeFromQuickPlayQueue(socket.id);
      socket.join(roomId);

      socket.emit('reconnect_success', {
        roomId,
        playerId: socket.id,
        players: room.players,
        playerCount: room.playerCount,
        playerColors: room.gameState?.playerColors || {},
        maxPlayers: room.maxPlayers || MAX_PLAYERS,
        isPublic: !!room.isPublic,
        isHost: !!room.players[socket.id]?.isHost,
        gameState: {
          gameStarted: !!room.gameState?.gameStarted,
          currentPlayer: room.gameState?.currentPlayer || null,
          diceValue: room.gameState?.diceValue || 0,
          settings: room.gameState?.settings || {},
          cutStatus: room.gameState?.cutStatus || { r: false, g: false, y: false, b: false },
          tokens: room.gameState?.tokens || {
            r: [-1, -1, -1, -1],
            g: [-1, -1, -1, -1],
            y: [-1, -1, -1, -1],
            b: [-1, -1, -1, -1]
          }
        }
      });

      emitCoinsUpdate(socket.id, playerUid, room).catch((err) => {
        console.error('Coins update error:', err);
      });

      socket.to(roomId).emit('player_reconnected', {
        playerId: socket.id,
        players: room.players,
        playerCount: room.playerCount,
        playerColors: room.gameState?.playerColors || {}
      });

      console.log(`Player ${room.players[socket.id]?.name || playerUid} reconnected in room ${roomId}`);
    } catch (error) {
      console.error('Error reconnecting player:', error);
      socket.emit('reconnect_failed', { message: 'Failed to reconnect player' });
    }
  });

  socket.on('quick_play_join', async (data = {}) => {
    const playerName = data.playerName || `Player${Math.floor(Math.random() * 1000)}`;
    const maxPlayers = [2, 4].includes(parseInt(data.maxPlayers, 10)) ? parseInt(data.maxPlayers, 10) : DEFAULT_MAX_PLAYERS;
    const avatar = data.avatar || null;
    const playerUid = getSocketPlayerUid(socket, data);
    const requestedFee = parseInt(data.entryFee, 10);
    const entryFee = getAllowedEntryFee(Number.isFinite(requestedFee) ? requestedFee : COIN_ENTRY_FEE);
    socket.data = socket.data || {};
    socket.data.playerName = playerName;
    socket.data.playerAvatar = avatar;
    if (playerUid) {
      socket.data.playerUid = playerUid;
      socketToPlayerUid[socket.id] = playerUid;
    }

    removeFromQuickPlayQueue(socket.id);
    await initMongo();
    await updatePlayerProfile(playerUid, playerName);

    const key = `${maxPlayers}_${entryFee}`;
    const queue = quickPlayQueues[key] || (quickPlayQueues[key] = []);
    if (!queue.includes(socket.id)) {
      queue.push(socket.id);
    }

    console.log(`[QP] ${playerName} (${socket.id}) joined queue ${maxPlayers} fee ${entryFee}. Now ${queue?.length || 0}`);
    emitQuickPlayQueueUpdate(maxPlayers, entryFee);
    if (queue.length >= maxPlayers) {
      createQuickPlayRoom(maxPlayers, entryFee);
    }
  });

  socket.on('quick_play_cancel', () => {
    removeFromQuickPlayQueue(socket.id);
    COIN_ROOM_FEES.forEach(fee => {
      emitQuickPlayQueueUpdate(2, fee);
      emitQuickPlayQueueUpdate(4, fee);
    });
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
  socket.on('create_room', async (data) => {
    try {
      const { playerName, isPublic, avatar } = data;
      const playerUid = getSocketPlayerUid(socket, data);
      if (playerUid) {
        socket.data = socket.data || {};
        socket.data.playerUid = playerUid;
        socketToPlayerUid[socket.id] = playerUid;
      }
      await initMongo();
      await updatePlayerProfile(playerUid, playerName);
      if (!playerUid) {
        socket.emit('error', { message: 'Missing player identity for coins.' });
        return;
      }

      const requestedFee = parseInt(data.entryFee, 10);
      const entryFee = getAllowedEntryFee(Number.isFinite(requestedFee) ? requestedFee : COIN_ENTRY_FEE);
      const debit = await debitBalance(playerUid, entryFee);
      if (!debit.ok) {
        const message = debit.disabled
          ? 'Coin system unavailable. Try again later.'
          : `Not enough coins. Entry fee is ${entryFee}.`;
        socket.emit('error', { message });
        return;
      }
      socket.emit('coins_updated', {
        balance: debit.balance,
        entryFee: entryFee,
        houseFeePercent: COIN_HOUSE_FEE_PERCENT
      });
      const roomId = generateRoomCode();
      
      rooms[roomId] = {
        players: {
          [socket.id]: {
            id: socket.id,
            playerUid: playerUid || null,
            name: playerName || `Player${Object.keys(rooms).length + 1}`,
            avatar: avatar || null,
            isHost: true,
            ready: true,
            color: null,
            connected: true,
            disconnectedAt: null,
            joinedAt: new Date().toISOString()
          }
        },
        playerCount: 1,
        maxPlayers: DEFAULT_MAX_PLAYERS,
        isPublic: !!isPublic,
        coin: {
          entryFee: entryFee,
          houseFeePercent: COIN_HOUSE_FEE_PERCENT,
          pool: entryFee,
          participants: {
            [playerUid]: true
          }
        },
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
  socket.on('join_room', async (data) => {
    try {
      const { roomId, playerName, avatar } = data;
      const playerUid = getSocketPlayerUid(socket, data);
      if (playerUid) {
        socket.data = socket.data || {};
        socket.data.playerUid = playerUid;
        socketToPlayerUid[socket.id] = playerUid;
      }
      const roomCode = roomId.toUpperCase();
      
      console.log(`Join request for room: ${roomCode} by ${playerName}`);
      
      if (!rooms[roomCode]) {
        socket.emit('error', { message: 'Room not found. Check the code!' });
        return;
      }

      await initMongo();
      await updatePlayerProfile(playerUid, playerName);
      if (!playerUid) {
        socket.emit('error', { message: 'Missing player identity for coins.' });
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

      const debit = await chargeEntryFee(rooms[roomCode], socket, playerUid);
      if (!debit.ok) {
        socket.emit('error', { message: debit.reason || `Not enough coins. Entry fee is ${COIN_ENTRY_FEE}.` });
        return;
      }
      
      // Add player to room
      rooms[roomCode].players[socket.id] = {
        id: socket.id,
        playerUid: playerUid || null,
        name: playerName || `Player${rooms[roomCode].playerCount + 1}`,
        avatar: avatar || null,
        isHost: false,
        ready: true,
        color: null,
        connected: true,
        disconnectedAt: null,
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
  socket.on('move_token', async (data) => {
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
      
      await applyMove(roomId, color, tokenIndex, diceValue, socket.id);
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
      removePlayerFromRoom(roomId, socket.id, "left");
      
      socket.leave(roomId);
    } catch (error) {
      console.error('Error leaving room:', error);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    removeFromQuickPlayQueue(socket.id);
    COIN_ROOM_FEES.forEach(fee => {
      emitQuickPlayQueueUpdate(2, fee);
      emitQuickPlayQueueUpdate(4, fee);
    });

    // Mark disconnected; keep room spot for grace period.
    Object.keys(rooms).forEach(roomId => {
      const room = rooms[roomId];
      const p = room?.players?.[socket.id];
      if (!p) return;
      p.connected = false;
      p.disconnectedAt = new Date().toISOString();
      io.to(roomId).emit('player_disconnected', {
        playerId: socket.id,
        playerName: p.name || 'Player',
        players: room.players,
        playerCount: room.playerCount,
        playerColors: room.gameState?.playerColors || {},
        maxPlayers: room.maxPlayers || MAX_PLAYERS
      });
      console.log(`${p.name || 'Player'} disconnected from room ${roomId}; waiting ${RECONNECT_GRACE_MS}ms for reconnect`);
    });

    delete socketToPlayerUid[socket.id];
  });

  // Ping to keep connection alive
  socket.on('ping', () => {
    socket.emit('pong');
  });
});

// Start server
const PORT = process.env.PORT || 3000;
initMongo().catch((err) => {
  console.error('Mongo init failed:', err);
});
server.listen(PORT, () => {
  console.log(`✅ Ludo Server running on port ${PORT}`);
  console.log(`📱 Access at: http://localhost:${PORT}`);
  console.log(`🎮 Waiting for players to connect...`);
});

// Clean up empty rooms every hour
setInterval(() => {
  const now = new Date();
  // Expire disconnected players that didn't reconnect in time.
  Object.keys(rooms).forEach(roomId => {
    const room = rooms[roomId];
    if (!room?.players) return;
    Object.keys(room.players).forEach(socketId => {
      const p = room.players[socketId];
      if (!p?.connected && p?.disconnectedAt) {
        const elapsed = now.getTime() - new Date(p.disconnectedAt).getTime();
        if (elapsed > RECONNECT_GRACE_MS) {
          removePlayerFromRoom(roomId, socketId, "disconnect_timeout");
        }
      }
    });
  });

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


