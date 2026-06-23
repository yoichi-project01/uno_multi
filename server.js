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
const { insertUser, getUserByUsername, getUserByPlayerId, updateUsername, updatePassword, updateAvatar, deleteUser } = require('./db');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const TURN_SECONDS = 15;
const BOT_NAMES = ['Bot Alice', 'Bot Bob', 'Bot Carol', 'Bot Dave', 'Bot Eve'];
const VALID_AVATARS = ['🎮','🎯','🃏','🎲','⭐','🔥','💎','🌟','👑','🐉','🦊','🐺'];

// Map<roomCode, roomState>
const rooms = new Map();
// Map<socketId, { roomCode, playerId }>
const socketMeta = new Map();
// Map<socketId, { playerId, username }>
const sessions = new Map();

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
    avatar: p.avatar || null,
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

  let playableUids = [];
  if (canAct && me) {
    if (room.drawStackCount > 0) {
      playableUids = me.hand.filter(c => c.type === 'draw2' || c.type === 'wild-draw4').map(c => c.uid);
    } else {
      playableUids = getPlayableUids(me.hand, room.topCard, room.currentColor);
    }
  }

  return {
    players: playerList(room),
    topCard: room.topCard,
    currentColor: room.currentColor,
    currentPlayerIndex: room.currentPlayerIndex,
    direction: room.direction,
    deckCount: room.deck.length,
    myHand: me ? me.hand : [],
    playableUids,
    drawnCardUid: (isMyTurn && room.hasDrawnThisTurn) ? room.drawnCardUid : null,
    unoState: room.unoState,
    waitingForColor: room.waitingForColor ? room.waitingForColor.playerId : null,
    hasDrawnThisTurn: isMyTurn ? room.hasDrawnThisTurn : false,
    isMyTurn,
    status: room.status,
    drawStackCount: room.drawStackCount || 0
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
  closeStaleUnoWindow(room, player.playerId);

  let playableUids;
  if (room.drawStackCount > 0) {
    playableUids = player.hand.filter(c => c.type === 'draw2' || c.type === 'wild-draw4').map(c => c.uid);
  } else {
    playableUids = getPlayableUids(player.hand, room.topCard, room.currentColor);
  }

  if (playableUids.length === 0) {
    if (room.drawStackCount > 0) {
      const count = room.drawStackCount;
      const drawn = drawFromDeck(room, count);
      player.hand.push(...drawn);
      io.to(room.code).emit('playerDrewCards', { playerId: player.playerId, count });
      room.drawStackCount = 0;
    } else {
      const drawn = drawFromDeck(room, 1);
      if (drawn.length > 0) {
        player.hand.push(...drawn);
        io.to(room.code).emit('playerDrewCards', { playerId: player.playerId, count: 1 });
      }
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

  if (room.rules?.drawStack && (card.type === 'draw2' || card.type === 'wild-draw4')) {
    const addCount = card.type === 'draw2' ? 2 : 4;
    room.drawStackCount += addCount;
    if (card.color !== 'wild') room.currentColor = card.color;
    const stackNext = mod(pIdx + room.direction, room.players.length);
    if (requiresColorChoice) {
      const color = chooseBotColor(player.hand);
      room.currentColor = color;
      io.to(room.code).emit('colorChosen', { color, playerId: player.playerId });
    }
    advanceTurn(room, stackNext);
    broadcastGameState(room);
    return;
  }

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

  const turnSeconds = room.rules?.timerSeconds ?? TURN_SECONDS;
  room.timerSeconds = turnSeconds;
  io.to(room.code).emit('turnStart', { playerId: player.playerId, seconds: turnSeconds });

  if (turnSeconds > 0) {
    room.timerInterval = setInterval(() => {
      room.timerSeconds--;
      io.to(room.code).emit('timerTick', { seconds: room.timerSeconds });

      if (room.timerSeconds <= 0) {
        stopTimer(room);
        const p = room.players[room.currentPlayerIndex];
        if (!p) return;

        if (room.drawStackCount > 0) {
          const count = room.drawStackCount;
          const drawn = drawFromDeck(room, count);
          p.hand.push(...drawn);
          io.to(room.code).emit('playerDrewCards', { playerId: p.playerId, count });
          room.drawStackCount = 0;
        } else if (!room.hasDrawnThisTurn) {
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
  }

  // Bot auto-play（タイマー有無に関わらず必ず実行する）
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
  room.currentPlayerIndex = toIndex;
  room.lastActivity = Date.now();
  startTurn(room);
}

// 次のプレイヤーがアクション(playCard/drawCard)を起こした時点で、
// 他人の宣言忘れ告発ウィンドウを閉じる（本人の宣言/告発はそれより前に届いていれば有効）
function closeStaleUnoWindow(room, actingPlayerId) {
  if (room.unoState && !room.unoState.declared && room.unoState.playerId !== actingPlayerId) {
    room.unoState = null;
  }
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

  if (winner.score >= (room.rules?.scoreLimit ?? 500)) {
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
  room.drawStackCount = 0;

  const handSize = room.rules?.handSize ?? 7;
  for (const p of room.players) {
    p.hand = [];
    for (let i = 0; i < handSize; i++) {
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
  socket.on('createRoom', ({ nickname, avatar, rules = {} } = {}) => {
    if (!nickname?.trim()) return socket.emit('error', { message: 'ニックネームを入力してください' });
    const code = genCode();
    const playerId = uuidv4();
    const playerAvatar = VALID_AVATARS.includes(avatar) ? avatar : null;
    const player = { socketId: socket.id, playerId, nickname: nickname.trim(), avatar: playerAvatar, hand: [], score: 0, connected: true };
    const roomRules = {
      handSize: [5, 7].includes(rules.handSize) ? rules.handSize : 7,
      timerSeconds: [0, 15, 30].includes(rules.timerSeconds) ? rules.timerSeconds : 15,
      drawStack: rules.drawStack === true,
      scoreLimit: [300, 500].includes(rules.scoreLimit) ? rules.scoreLimit : 500,
      maxPlayers: [2, 3, 4, 5, 6].includes(rules.maxPlayers) ? rules.maxPlayers : 4,
    };
    rooms.set(code, {
      code, hostPlayerId: playerId, players: [player], status: 'waiting',
      deck: [], discardPile: [], topCard: null, currentColor: null,
      currentPlayerIndex: 0, direction: 1,
      unoState: null, waitingForColor: null,
      hasDrawnThisTurn: false, drawnCardUid: null,
      timerInterval: null, timerSeconds: 0,
      rules: roomRules, drawStackCount: 0,
      lastActivity: Date.now()
    });
    socketMeta.set(socket.id, { roomCode: code, playerId });
    socket.join(code);
    socket.emit('roomCreated', { roomCode: code, playerId, players: [{ playerId, nickname: player.nickname, avatar: playerAvatar, isHost: true, connected: true }], rules: roomRules });
  });

  // ── joinRoom ──
  socket.on('joinRoom', ({ roomCode, nickname, avatar, playerId: existingId }) => {
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
    const cap = room.rules?.maxPlayers ?? 4;
    if (room.players.length >= cap) return socket.emit('error', { message: `部屋が満員です (最大${cap}人)` });
    if (!nickname?.trim()) return socket.emit('error', { message: 'ニックネームを入力してください' });

    const playerId = uuidv4();
    const playerAvatar = VALID_AVATARS.includes(avatar) ? avatar : null;
    const player = { socketId: socket.id, playerId, nickname: nickname.trim(), avatar: playerAvatar, hand: [], score: 0, connected: true };
    room.players.push(player);
    socketMeta.set(socket.id, { roomCode, playerId });
    socket.join(roomCode);
    room.lastActivity = Date.now();

    socket.emit('roomJoined', { roomCode, playerId, isHost: false, rules: room.rules });
    io.to(roomCode).emit('roomUpdate', { players: playerList(room), rules: room.rules });
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
      sessions.set(socket.id, { playerId, username });
      socket.emit('authSuccess', { playerId, nickname: username, avatar: null });
    } catch (err) {
      if (err.code === '23505') {
        socket.emit('authError', { message: 'このユーザー名は既に使われています' });
      } else {
        console.error('register error:', err);
        socket.emit('authError', { message: 'サーバーエラーが発生しました' });
      }
    }
  });

  // ── restoreSession ──
  socket.on('restoreSession', async ({ playerId } = {}) => {
    if (!playerId) return;
    try {
      const user = await getUserByPlayerId(playerId);
      if (!user) return;
      sessions.set(socket.id, { playerId: user.player_id, username: user.username });
      socket.emit('sessionRestored', { nickname: user.username, avatar: user.avatar || null });
    } catch (err) {
      console.error('restoreSession error:', err);
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
      sessions.set(socket.id, { playerId: user.player_id, username: user.username });
      socket.emit('authSuccess', { playerId: user.player_id, nickname: user.username, avatar: user.avatar });
    } catch (err) {
      console.error('login error:', err);
      socket.emit('authError', { message: 'サーバーエラーが発生しました' });
    }
  });

  // ── changeUsername ──
  socket.on('changeUsername', async ({ newUsername, password } = {}) => {
    const session = sessions.get(socket.id);
    if (!session) return socket.emit('settingsError', { field: 'username', message: 'ログインが必要です' });
    newUsername = newUsername?.trim();
    if (!newUsername || !password)
      return socket.emit('settingsError', { field: 'username', message: 'ユーザー名とパスワードを入力してください' });
    if (newUsername.length < 2 || newUsername.length > 16)
      return socket.emit('settingsError', { field: 'username', message: 'ユーザー名は2〜16文字で入力してください' });
    if (!/^[a-zA-Z0-9_぀-ヿ一-鿿]+$/.test(newUsername))
      return socket.emit('settingsError', { field: 'username', message: 'ユーザー名に使えない文字が含まれています' });
    try {
      const user = await getUserByPlayerId(session.playerId);
      if (!user || user.password_hash !== hashPassword(password))
        return socket.emit('settingsError', { field: 'username', message: 'パスワードが正しくありません' });
      await updateUsername(session.playerId, newUsername);
      sessions.set(socket.id, { ...session, username: newUsername });
      socket.emit('settingsSuccess', { field: 'username', value: newUsername });
    } catch (err) {
      if (err.code === '23505') {
        socket.emit('settingsError', { field: 'username', message: 'このユーザー名は既に使われています' });
      } else {
        console.error('changeUsername error:', err);
        socket.emit('settingsError', { field: 'username', message: 'サーバーエラーが発生しました' });
      }
    }
  });

  // ── changePassword ──
  socket.on('changePassword', async ({ currentPassword, newPassword } = {}) => {
    const session = sessions.get(socket.id);
    if (!session) return socket.emit('settingsError', { field: 'password', message: 'ログインが必要です' });
    if (!currentPassword || !newPassword)
      return socket.emit('settingsError', { field: 'password', message: 'パスワードを入力してください' });
    if (newPassword.length < 4)
      return socket.emit('settingsError', { field: 'password', message: '新しいパスワードは4文字以上で入力してください' });
    try {
      const user = await getUserByPlayerId(session.playerId);
      if (!user || user.password_hash !== hashPassword(currentPassword))
        return socket.emit('settingsError', { field: 'password', message: '現在のパスワードが正しくありません' });
      await updatePassword(session.playerId, hashPassword(newPassword));
      socket.emit('settingsSuccess', { field: 'password' });
    } catch (err) {
      console.error('changePassword error:', err);
      socket.emit('settingsError', { field: 'password', message: 'サーバーエラーが発生しました' });
    }
  });

  // ── setAvatar ──
  socket.on('setAvatar', async ({ avatar } = {}) => {
    const session = sessions.get(socket.id);
    if (!session) return socket.emit('settingsError', { field: 'avatar', message: 'ログインが必要です' });
    if (!VALID_AVATARS.includes(avatar))
      return socket.emit('settingsError', { field: 'avatar', message: '無効なアバターです' });
    try {
      await updateAvatar(session.playerId, avatar);
      socket.emit('settingsSuccess', { field: 'avatar', value: avatar });
    } catch (err) {
      console.error('setAvatar error:', err);
      socket.emit('settingsError', { field: 'avatar', message: 'サーバーエラーが発生しました' });
    }
  });

  // ── deleteAccount ──
  socket.on('deleteAccount', async ({ password } = {}) => {
    const session = sessions.get(socket.id);
    if (!session) return socket.emit('settingsError', { field: 'delete', message: 'ログインが必要です' });
    if (!password)
      return socket.emit('settingsError', { field: 'delete', message: 'パスワードを入力してください' });
    try {
      const user = await getUserByPlayerId(session.playerId);
      if (!user || user.password_hash !== hashPassword(password))
        return socket.emit('settingsError', { field: 'delete', message: 'パスワードが正しくありません' });
      await deleteUser(session.playerId);
      sessions.delete(socket.id);
      socket.emit('accountDeleted');
    } catch (err) {
      console.error('deleteAccount error:', err);
      socket.emit('settingsError', { field: 'delete', message: 'サーバーエラーが発生しました' });
    }
  });

  // ── startGame ──
  socket.on('startGame', () => {
    const room = getRoom(socket);
    const meta = getMeta(socket);
    if (!room || !meta) return;
    if (room.hostPlayerId !== meta.playerId) return socket.emit('error', { message: 'ホストのみ開始できます' });
    if (room.status !== 'waiting') return;

    // 参加人数（ルール設定）に達していない場合、不足分を自動でBOTが補充
    const targetPlayers = room.rules?.maxPlayers ?? 4;
    const toAdd = Math.max(0, targetPlayers - room.players.length);
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
    closeStaleUnoWindow(room, player.playerId);
    const cardIdx = player.hand.findIndex(c => c.uid === uid);
    if (cardIdx === -1) return socket.emit('error', { message: 'カードが手札にありません' });

    const card = player.hand[cardIdx];
    if (!canPlay(card, room.topCard, room.currentColor)) return socket.emit('error', { message: 'そのカードは出せません' });

    // ドロースタック中はドローカードのみ出せる
    if (room.drawStackCount > 0 && card.type !== 'draw2' && card.type !== 'wild-draw4') {
      return socket.emit('error', { message: `ドロースタック中です。ドローカードを出すか${room.drawStackCount}枚引いてください` });
    }

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

    // ドロースタックモード: 累積してターン移行（即時引き取らせない）
    if (room.rules?.drawStack && (card.type === 'draw2' || card.type === 'wild-draw4')) {
      const addCount = card.type === 'draw2' ? 2 : 4;
      room.drawStackCount += addCount;
      if (card.color !== 'wild') room.currentColor = card.color;
      const stackNext = mod(pIdx + room.direction, room.players.length);
      if (requiresColorChoice) {
        room.waitingForColor = { playerId: player.playerId, nextIndex: stackNext };
        room.currentColor = null;
        broadcastGameState(room);
        io.to(room.code).emit('waitingForColor', { playerId: player.playerId });
        return;
      }
      advanceTurn(room, stackNext);
      broadcastGameState(room);
      return;
    }

    // 通常: ドロー効果を即時適用
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
    closeStaleUnoWindow(room, player.playerId);

    // ドロースタック: 累積枚数を全部引いてターン終了
    if (room.drawStackCount > 0) {
      const count = room.drawStackCount;
      const drawn = drawFromDeck(room, count);
      player.hand.push(...drawn);
      room.drawStackCount = 0;
      room.lastActivity = Date.now();
      io.to(room.code).emit('playerDrewCards', { playerId: player.playerId, count });
      io.to(socket.id).emit('drewCard', { card: drawn[drawn.length - 1], canPlay: false });
      const next = mod(pIdx + room.direction, room.players.length);
      advanceTurn(room, next);
      broadcastGameState(room);
      return;
    }

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
  socket.on('disconnect', () => { sessions.delete(socket.id); handleLeave(socket, true); });
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
