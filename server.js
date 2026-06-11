'use strict';

require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { createDeck, shuffle, calculateHandPoints } = require('./game/cardDeck');
const { mod, canPlay, getPlayableUids, resolveCardEffect } = require('./game/gameEngine');
const { insertUser, getUserByUsername } = require('./db');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const TURN_SECONDS = 15;
const BOT_NAMES = ['Bot Alice', 'Bot Bob', 'Bot Carol'];

// Map<roomCode, roomState>
const rooms = new Map();
// Map<socketId, { roomCode, playerId }>
const socketMeta = new Map();

function hashPassword(pw) {
  return crypto.createHash('sha256').update('uno-salt:' + pw).digest('hex');
}


// ── Express ───────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
// Direct room URL — serve SPA, client handles routing
app.get('/room/:code', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Helpers ───────────────────────────────────────────────────────────────────

function genCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); }
  while (rooms.has(code));
  return code;
}

function drawFromDeck(room, count) {
  const drawn = [];
  for (let i = 0; i < count; i++) {
    if (room.deck.length === 0) {
      if (room.discardPile.length <= 1) break;
      const top = room.discardPile.pop();
      room.deck = shuffle(room.discardPile);
      room.discardPile = [top];
      io.to(room.code).emit('deckReshuffled');
    }
    if (room.deck.length > 0) drawn.push(room.deck.pop());
  }
  return drawn;
}

function playerList(room) {
  return room.players.map(p => ({
    playerId: p.playerId,
    nickname: p.nickname,
    cardCount: p.hand.length,
    score: p.score,
    connected: p.connected,
    isHost: p.playerId === room.hostPlayerId
  }));
}

function buildGameState(room, forPlayerId) {
  const me = room.players.find(p => p.playerId === forPlayerId);
  const cur = room.players[room.currentPlayerIndex];
  const isMyTurn = !!(cur && cur.playerId === forPlayerId && room.status === 'playing');
  const canAct = isMyTurn && !room.waitingForColor;

  return {
    players: playerList(room),
    topCard: room.topCard,
    currentColor: room.currentColor,
    currentPlayerIndex: room.currentPlayerIndex,
    direction: room.direction,
    deckCount: room.deck.length,
    myHand: me ? me.hand : [],
    playableUids: (canAct && me)
      ? getPlayableUids(me.hand, room.topCard, room.currentColor) : [],
    drawnCardUid: (isMyTurn && room.hasDrawnThisTurn) ? room.drawnCardUid : null,
    unoState: room.unoState,
    waitingForColor: room.waitingForColor ? room.waitingForColor.playerId : null,
    hasDrawnThisTurn: isMyTurn ? room.hasDrawnThisTurn : false,
    isMyTurn,
    status: room.status
  };
}

function broadcastGameState(room) {
  for (const p of room.players) {
    if (p.connected && p.socketId) {
      io.to(p.socketId).emit('gameState', buildGameState(room, p.playerId));
    }
  }
}

// ── Bot logic ─────────────────────────────────────────────────────────────────

function chooseBotColor(hand) {
  const counts = { red: 0, blue: 0, green: 0, yellow: 0 };
  for (const c of hand) { if (c.color in counts) counts[c.color]++; }
  return Object.keys(counts).reduce((a, b) => counts[a] >= counts[b] ? a : b);
}

function executeBotTurn(room, pIdx) {
  if (room.status !== 'playing') return;
  const player = room.players[pIdx];
  if (!player?.isBot || pIdx !== room.currentPlayerIndex) return;
  if (room.waitingForColor) return;

  const playableUids = getPlayableUids(player.hand, room.topCard, room.currentColor);

  if (playableUids.length === 0) {
    // Draw and auto-pass
    const drawn = drawFromDeck(room, 1);
    if (drawn.length > 0) {
      player.hand.push(...drawn);
      io.to(room.code).emit('playerDrewCards', { playerId: player.playerId, count: 1 });
    }
    const next = mod(pIdx + room.direction, room.players.length);
    advanceTurn(room, next);
    broadcastGameState(room);
    return;
  }

  // Play a random valid card (prefer non-wild to preserve wilds)
  const nonWild = playableUids.filter(uid => {
    const c = player.hand.find(h => h.uid === uid);
    return c && c.color !== 'wild';
  });
  const uid = (nonWild.length > 0 ? nonWild : playableUids)[Math.floor(Math.random() * (nonWild.length || playableUids.length))];

  const cardIdx = player.hand.findIndex(c => c.uid === uid);
  const card = player.hand[cardIdx];
  const isLastCard = player.hand.length === 1;

  player.hand.splice(cardIdx, 1);
  room.discardPile.push(card);
  room.topCard = card;
  stopTimer(room);
  room.lastActivity = Date.now();

  io.to(room.code).emit('cardPlayed', { playerId: player.playerId, imageId: card.imageId });

  if (room.unoState?.playerId === player.playerId) room.unoState = null;
  if (player.hand.length === 1) {
    room.unoState = { playerId: player.playerId, declared: false };
    io.to(room.code).emit('unoWindow', { playerId: player.playerId });
    // Bot auto-declares after short delay (gives humans a brief challenge window)
    setTimeout(() => {
      if (room.unoState?.playerId === player.playerId && !room.unoState.declared) {
        room.unoState.declared = true;
        io.to(room.code).emit('unoDeclared', { playerId: player.playerId });
      }
    }, 800);
  }

  if (isLastCard) {
    if (card.type === 'draw2' || card.type === 'wild-draw4') {
      const drawCount = card.type === 'draw2' ? 2 : 4;
      const nextIdx = mod(pIdx + room.direction, room.players.length);
      const drawn = drawFromDeck(room, drawCount);
      room.players[nextIdx].hand.push(...drawn);
      io.to(room.code).emit('playerDrewCards', { playerId: room.players[nextIdx].playerId, count: drawn.length });
    }
    broadcastGameState(room);
    endRound(room, player.playerId);
    return;
  }

  const { nextIndex, newDirection, requiresColorChoice, effects } = resolveCardEffect(
    card, pIdx, room.direction, room.players.length
  );
  room.direction = newDirection;

  for (const eff of effects) {
    const target = room.players[eff.playerIndex];
    const drawn = drawFromDeck(room, eff.drawCount);
    target.hand.push(...drawn);
    io.to(room.code).emit('playerDrewCards', { playerId: target.playerId, count: eff.drawCount });
  }

  if (card.color !== 'wild') room.currentColor = card.color;

  if (requiresColorChoice) {
    const color = chooseBotColor(player.hand);
    room.currentColor = color;
    io.to(room.code).emit('colorChosen', { color, playerId: player.playerId });
    advanceTurn(room, nextIndex);
    broadcastGameState(room);
    return;
  }

  advanceTurn(room, nextIndex);
  broadcastGameState(room);
}

// ── Timer ─────────────────────────────────────────────────────────────────────

function stopTimer(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
}

function startTurn(room) {
  stopTimer(room);
  room.hasDrawnThisTurn = false;
  room.drawnCardUid = null;

  const player = room.players[room.currentPlayerIndex];
  if (!player) return;

  room.timerSeconds = TURN_SECONDS;
  io.to(room.code).emit('turnStart', { playerId: player.playerId, seconds: TURN_SECONDS });

  room.timerInterval = setInterval(() => {
    room.timerSeconds--;
    io.to(room.code).emit('timerTick', { seconds: room.timerSeconds });

    if (room.timerSeconds <= 0) {
      stopTimer(room);
      const p = room.players[room.currentPlayerIndex];
      if (!p) return;

      if (!room.hasDrawnThisTurn) {
        const drawn = drawFromDeck(room, 1);
        if (drawn.length > 0) {
          p.hand.push(...drawn);
          io.to(room.code).emit('playerDrewCards', { playerId: p.playerId, count: 1 });
        }
      }
      const next = mod(room.currentPlayerIndex + room.direction, room.players.length);
      advanceTurn(room, next);
      broadcastGameState(room);
    }
  }, 1000);

  // Bot auto-play
  if (player.isBot) {
    const botId = player.playerId;
    const delay = 1200 + Math.random() * 800;
    setTimeout(() => {
      if (room.players[room.currentPlayerIndex]?.playerId === botId) {
        executeBotTurn(room, room.currentPlayerIndex);
      }
    }, delay);
  }
}

function advanceTurn(room, toIndex) {
  if (room.unoState && !room.unoState.declared) room.unoState = null;
  room.currentPlayerIndex = toIndex;
  room.lastActivity = Date.now();
  startTurn(room);
}

// ── Round / Game lifecycle ────────────────────────────────────────────────────

function endRound(room, winnerPlayerId) {
  stopTimer(room);
  room.status = 'roundEnd';
  room.unoState = null;
  room.waitingForColor = null;

  const winner = room.players.find(p => p.playerId === winnerPlayerId);
  const roundScores = {};
  let totalPoints = 0;
  for (const p of room.players) {
    const pts = calculateHandPoints(p.hand);
    roundScores[p.playerId] = pts;
    totalPoints += pts;
  }
  winner.score += totalPoints;

  const totalScores = Object.fromEntries(room.players.map(p => [p.playerId, p.score]));
  const hands = Object.fromEntries(room.players.map(p => [p.playerId, p.hand]));

  io.to(room.code).emit('roundResult', { winnerId: winnerPlayerId, roundScores, totalScores, hands });

  if (winner.score >= 500) {
    room.status = 'gameEnd';
    setTimeout(() => io.to(room.code).emit('gameResult', { winnerId: winnerPlayerId, totalScores }), 3000);
  } else {
    setTimeout(() => { if (room.status === 'roundEnd') startRound(room); }, 6000);
  }
}

function startRound(room) {
  room.deck = shuffle(createDeck());
  room.discardPile = [];
  room.direction = 1;
  room.unoState = null;
  room.waitingForColor = null;
  room.hasDrawnThisTurn = false;
  room.drawnCardUid = null;
  room.currentPlayerIndex = 0;

  for (const p of room.players) {
    p.hand = [];
    for (let i = 0; i < 7; i++) {
      if (room.deck.length > 0) p.hand.push(room.deck.pop());
    }
  }

  // First card must not be wild
  let first;
  do {
    first = room.deck.pop();
    if (first.color === 'wild') { room.deck.unshift(first); first = null; }
  } while (!first);

  room.discardPile.push(first);
  room.topCard = first;
  room.currentColor = first.color;

  // Apply first card effect
  if (first.type === 'skip') {
    room.currentPlayerIndex = mod(room.direction, room.players.length);
  } else if (first.type === 'reverse') {
    room.direction = -1;
    room.currentPlayerIndex = mod(-1, room.players.length);
  } else if (first.type === 'draw2') {
    const drawn = drawFromDeck(room, 2);
    room.players[0].hand.push(...drawn);
    room.currentPlayerIndex = mod(room.direction, room.players.length);
  }

  room.status = 'playing';
  room.lastActivity = Date.now();
  io.to(room.code).emit('roundStarted');
  broadcastGameState(room);
  setTimeout(() => startTurn(room), 1500);
}

// ── Room cleanup ──────────────────────────────────────────────────────────────

setInterval(() => {
  const threshold = Date.now() - 30 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.lastActivity < threshold || room.players.every(p => !p.connected)) {
      stopTimer(room);
      rooms.delete(code);
    }
  }
}, 60 * 1000);

// ── Socket handlers ───────────────────────────────────────────────────────────

function getRoom(socket) {
  const meta = socketMeta.get(socket.id);
  if (!meta) return null;
  return rooms.get(meta.roomCode) || null;
}

function getMeta(socket) {
  return socketMeta.get(socket.id) || null;
}

io.on('connection', (socket) => {

  // ── createRoom ──
  socket.on('createRoom', ({ nickname }) => {
    if (!nickname?.trim()) return socket.emit('error', { message: 'ニックネームを入力してください' });
    const code = genCode();
    const playerId = uuidv4();
    const player = { socketId: socket.id, playerId, nickname: nickname.trim(), hand: [], score: 0, connected: true };
    rooms.set(code, {
      code, hostPlayerId: playerId, players: [player], status: 'waiting',
      deck: [], discardPile: [], topCard: null, currentColor: null,
      currentPlayerIndex: 0, direction: 1,
      unoState: null, waitingForColor: null,
      hasDrawnThisTurn: false, drawnCardUid: null,
      timerInterval: null, timerSeconds: 0,
      lastActivity: Date.now()
    });
    socketMeta.set(socket.id, { roomCode: code, playerId });
    socket.join(code);
    socket.emit('roomCreated', { roomCode: code, playerId, players: [{ playerId, nickname: player.nickname, isHost: true, connected: true }] });
  });

  // ── joinRoom ──
  socket.on('joinRoom', ({ roomCode, nickname, playerId: existingId }) => {
    const room = rooms.get(roomCode);
    if (!room) return socket.emit('error', { message: '部屋が見つかりません (コード: ' + roomCode + ')' });

    // Reconnection
    if (existingId) {
      const existing = room.players.find(p => p.playerId === existingId);
      if (existing) {
        if (existing.socketId) socketMeta.delete(existing.socketId);
        existing.socketId = socket.id;
        existing.connected = true;
        socketMeta.set(socket.id, { roomCode, playerId: existingId });
        socket.join(roomCode);
        room.lastActivity = Date.now();
        socket.emit('roomJoined', { roomCode, playerId: existingId, isHost: existingId === room.hostPlayerId });
        io.to(roomCode).emit('playerReconnected', { playerId: existingId, players: playerList(room) });
        if (room.status !== 'waiting') {
          socket.emit('gameState', buildGameState(room, existingId));
          if (room.status === 'playing') {
            socket.emit('turnStart', { playerId: room.players[room.currentPlayerIndex]?.playerId, seconds: room.timerSeconds });
          }
        } else {
          io.to(roomCode).emit('roomUpdate', { players: playerList(room) });
        }
        return;
      }
    }

    if (room.status !== 'waiting') return socket.emit('error', { message: 'ゲームはすでに始まっています' });
    if (room.players.length >= 4) return socket.emit('error', { message: '部屋が満員です (最大4人)' });
    if (!nickname?.trim()) return socket.emit('error', { message: 'ニックネームを入力してください' });

    const playerId = uuidv4();
    const player = { socketId: socket.id, playerId, nickname: nickname.trim(), hand: [], score: 0, connected: true };
    room.players.push(player);
    socketMeta.set(socket.id, { roomCode, playerId });
    socket.join(roomCode);
    room.lastActivity = Date.now();

    socket.emit('roomJoined', { roomCode, playerId, isHost: false });
    io.to(roomCode).emit('roomUpdate', { players: playerList(room) });
  });

  // ── register ──
  socket.on('register', async ({ username, password } = {}) => {
    if (!username || !password)
      return socket.emit('authError', { message: 'ユーザー名とパスワードを入力してください' });
    if (username.length < 2 || username.length > 16)
      return socket.emit('authError', { message: 'ユーザー名は2〜16文字で入力してください' });
    if (!/^[a-zA-Z0-9_぀-ヿ一-鿿]+$/.test(username))
      return socket.emit('authError', { message: 'ユーザー名に使えない文字が含まれています' });
    if (password.length < 4)
      return socket.emit('authError', { message: 'パスワードは4文字以上で入力してください' });

    const playerId = uuidv4();
    try {
      await insertUser(username, hashPassword(password), playerId);
      socket.emit('authSuccess', { playerId, nickname: username });
    } catch (err) {
      if (err.code === '23505') {
        socket.emit('authError', { message: 'このユーザー名は既に使われています' });
      } else {
        console.error('register error:', err);
        socket.emit('authError', { message: 'サーバーエラーが発生しました' });
      }
    }
  });

  // ── login ──
  socket.on('login', async ({ username, password } = {}) => {
    if (!username || !password)
      return socket.emit('authError', { message: 'ユーザー名とパスワードを入力してください' });

    try {
      const user = await getUserByUsername(username);
      if (!user || user.password_hash !== hashPassword(password))
        return socket.emit('authError', { message: 'ユーザー名またはパスワードが正しくありません' });
      socket.emit('authSuccess', { playerId: user.player_id, nickname: user.username });
    } catch (err) {
      console.error('login error:', err);
      socket.emit('authError', { message: 'サーバーエラーが発生しました' });
    }
  });

  // ── startGame ──
  socket.on('startGame', ({ botCount = 0 } = {}) => {
    const room = getRoom(socket);
    const meta = getMeta(socket);
    if (!room || !meta) return;
    if (room.hostPlayerId !== meta.playerId) return socket.emit('error', { message: 'ホストのみ開始できます' });
    if (room.status !== 'waiting') return;

    // 指定数のボットを追加（最大4人まで）
    const toAdd = Math.min(botCount, 4 - room.players.length);
    if (toAdd > 0) {
      let botIdx = 0;
      for (let i = 0; i < toAdd; i++) {
        room.players.push({
          socketId: null, playerId: `bot-${uuidv4().slice(0, 8)}`,
          nickname: BOT_NAMES[botIdx++] || `Bot ${botIdx}`,
          hand: [], score: 0, connected: true, isBot: true
        });
      }
      io.to(room.code).emit('roomUpdate', { players: playerList(room) });
    }

    if (room.players.length < 2) {
      return socket.emit('error', { message: '最低2人（BOT含む）必要です' });
    }

    io.to(room.code).emit('gameStarting');
    setTimeout(() => startRound(room), 1000);
  });

  // ── playCard ──
  socket.on('playCard', ({ uid }) => {
    const room = getRoom(socket);
    const meta = getMeta(socket);
    if (!room || !meta || room.status !== 'playing') return;

    const pIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (pIdx !== room.currentPlayerIndex) return socket.emit('error', { message: '今はあなたのターンではありません' });
    if (room.waitingForColor) return socket.emit('error', { message: '色の選択を待っています' });

    const player = room.players[pIdx];
    const cardIdx = player.hand.findIndex(c => c.uid === uid);
    if (cardIdx === -1) return socket.emit('error', { message: 'カードが手札にありません' });

    const card = player.hand[cardIdx];
    if (!canPlay(card, room.topCard, room.currentColor)) return socket.emit('error', { message: 'そのカードは出せません' });

    const isLastCard = player.hand.length === 1;
    player.hand.splice(cardIdx, 1);
    room.discardPile.push(card);
    room.topCard = card;
    stopTimer(room);
    room.lastActivity = Date.now();

    io.to(room.code).emit('cardPlayed', { playerId: player.playerId, imageId: card.imageId });

    // Clear/set UNO state
    if (room.unoState?.playerId === player.playerId) room.unoState = null;
    if (player.hand.length === 1) {
      room.unoState = { playerId: player.playerId, declared: false };
      io.to(room.code).emit('unoWindow', { playerId: player.playerId });
    }

    // Player went out
    if (isLastCard) {
      if (card.type === 'draw2' || card.type === 'wild-draw4') {
        const drawCount = card.type === 'draw2' ? 2 : 4;
        const nextIdx = mod(pIdx + room.direction, room.players.length);
        const drawn = drawFromDeck(room, drawCount);
        room.players[nextIdx].hand.push(...drawn);
        io.to(room.code).emit('playerDrewCards', { playerId: room.players[nextIdx].playerId, count: drawn.length });
      }
      broadcastGameState(room);
      endRound(room, player.playerId);
      return;
    }

    const { nextIndex, newDirection, requiresColorChoice, effects } = resolveCardEffect(
      card, pIdx, room.direction, room.players.length
    );
    room.direction = newDirection;

    // Apply draw effects (draw2, wild-draw4)
    for (const eff of effects) {
      const target = room.players[eff.playerIndex];
      const drawn = drawFromDeck(room, eff.drawCount);
      target.hand.push(...drawn);
      io.to(room.code).emit('playerDrewCards', { playerId: target.playerId, count: eff.drawCount });
    }

    if (card.color !== 'wild') room.currentColor = card.color;

    if (requiresColorChoice) {
      room.waitingForColor = { playerId: player.playerId, nextIndex };
      room.currentColor = null;
      broadcastGameState(room);
      io.to(room.code).emit('waitingForColor', { playerId: player.playerId });
      return;
    }

    advanceTurn(room, nextIndex);
    broadcastGameState(room);
  });

  // ── chooseColor ──
  socket.on('chooseColor', ({ color }) => {
    const room = getRoom(socket);
    const meta = getMeta(socket);
    if (!room || !meta || !room.waitingForColor) return;
    if (room.waitingForColor.playerId !== meta.playerId) return socket.emit('error', { message: '色を選ぶのはあなたではありません' });
    if (!['red', 'blue', 'green', 'yellow'].includes(color)) return socket.emit('error', { message: '無効な色です' });

    const { nextIndex } = room.waitingForColor;
    room.currentColor = color;
    room.waitingForColor = null;
    room.lastActivity = Date.now();

    io.to(room.code).emit('colorChosen', { color, playerId: meta.playerId });
    advanceTurn(room, nextIndex);
    broadcastGameState(room);
  });

  // ── drawCard ──
  socket.on('drawCard', () => {
    const room = getRoom(socket);
    const meta = getMeta(socket);
    if (!room || !meta || room.status !== 'playing') return;

    const pIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (pIdx !== room.currentPlayerIndex) return socket.emit('error', { message: '今はあなたのターンではありません' });
    if (room.hasDrawnThisTurn) return socket.emit('error', { message: '既にカードを引いています' });
    if (room.waitingForColor) return;

    const player = room.players[pIdx];
    const drawn = drawFromDeck(room, 1);
    if (drawn.length === 0) return;

    const card = drawn[0];
    player.hand.push(card);
    room.hasDrawnThisTurn = true;
    room.drawnCardUid = card.uid;
    room.lastActivity = Date.now();

    const isPlayable = canPlay(card, room.topCard, room.currentColor);
    io.to(room.code).emit('playerDrewCards', { playerId: player.playerId, count: 1 });

    if (!isPlayable) {
      // Auto-pass: no card to play
      const next = mod(pIdx + room.direction, room.players.length);
      advanceTurn(room, next);
      broadcastGameState(room);
    } else {
      // Player can choose to play or pass
      broadcastGameState(room);
    }
  });

  // ── passTurn ──
  socket.on('passTurn', () => {
    const room = getRoom(socket);
    if (!room || room.status !== 'playing') return;
    const pIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (pIdx !== room.currentPlayerIndex) return;
    if (!room.hasDrawnThisTurn) return socket.emit('error', { message: 'カードを引いてからパスしてください' });

    const next = mod(pIdx + room.direction, room.players.length);
    advanceTurn(room, next);
    broadcastGameState(room);
  });

  // ── declareUno ──
  socket.on('declareUno', () => {
    const room = getRoom(socket);
    const meta = getMeta(socket);
    if (!room || !meta || !room.unoState || room.unoState.playerId !== meta.playerId) return;
    room.unoState.declared = true;
    io.to(room.code).emit('unoDeclared', { playerId: meta.playerId });
  });

  // ── challengeUno ──
  socket.on('challengeUno', ({ targetPlayerId }) => {
    const room = getRoom(socket);
    const meta = getMeta(socket);
    if (!room || !meta || !room.unoState || room.unoState.playerId !== targetPlayerId) return;
    if (meta.playerId === targetPlayerId) return;

    if (!room.unoState.declared) {
      const target = room.players.find(p => p.playerId === targetPlayerId);
      if (target) {
        const drawn = drawFromDeck(room, 2);
        target.hand.push(...drawn);
        room.unoState = null;
        io.to(room.code).emit('unoChallenge', { challengerId: meta.playerId, targetId: targetPlayerId, success: true });
        io.to(room.code).emit('playerDrewCards', { playerId: targetPlayerId, count: drawn.length });
        broadcastGameState(room);
      }
    } else {
      io.to(room.code).emit('unoChallenge', { challengerId: meta.playerId, targetId: targetPlayerId, success: false });
    }
  });

  // ── sendEmote ──
  socket.on('sendEmote', ({ emoteId }) => {
    const room = getRoom(socket);
    const meta = getMeta(socket);
    if (!room || !meta) return;
    io.to(room.code).emit('emote', { playerId: meta.playerId, emoteId });
  });

  // ── leaveRoom ──
  socket.on('leaveRoom', () => handleLeave(socket, false));
  socket.on('disconnect', () => handleLeave(socket, true));
});

function handleLeave(socket, isDisconnect) {
  const meta = socketMeta.get(socket.id);
  if (!meta) return;
  const { roomCode, playerId } = meta;
  socketMeta.delete(socket.id);
  socket.leave(roomCode);

  const room = rooms.get(roomCode);
  if (!room) return;

  const player = room.players.find(p => p.playerId === playerId);
  if (!player) return;

  room.lastActivity = Date.now();

  if (isDisconnect) {
    player.connected = false;
    player.socketId = null;
    io.to(roomCode).emit('playerDisconnected', { playerId, players: playerList(room) });
    if (room.status === 'playing') broadcastGameState(room);
    if (room.status === 'waiting') io.to(roomCode).emit('roomUpdate', { players: playerList(room) });
  } else {
    room.players = room.players.filter(p => p.playerId !== playerId);
    if (room.players.length === 0) { stopTimer(room); rooms.delete(roomCode); return; }

    if (room.hostPlayerId === playerId) room.hostPlayerId = room.players[0].playerId;

    if (room.status === 'waiting') {
      io.to(roomCode).emit('roomUpdate', { players: playerList(room) });
    } else if (room.status === 'playing') {
      if (room.currentPlayerIndex >= room.players.length) {
        room.currentPlayerIndex = 0;
        stopTimer(room);
        startTurn(room);
      }
      if (room.players.length < 2) {
        stopTimer(room);
        room.status = 'waiting';
        io.to(roomCode).emit('gameCancelled', { reason: 'プレイヤーが退出したためゲームを終了します' });
      } else {
        io.to(roomCode).emit('playerLeft', { playerId, players: playerList(room) });
        broadcastGameState(room);
      }
    }
  }
}

httpServer.listen(PORT, () => console.log(`UNO server → http://localhost:${PORT}`));
