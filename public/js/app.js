'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const TURN_SECONDS = 15;
const EMOTE_MAP = {
  laugh:    { emoji: '😂', label: 'LOL' },
  ugh:      { emoji: '😤', label: 'Ugh!' },
  nice:     { emoji: '🎉', label: 'Nice!' },
  shocked:  { emoji: '😱', label: 'Whoa!' },
  thinking: { emoji: '🤔', label: 'Hmm...' },
  gg:       { emoji: '👏', label: 'GG' }
};
const CARD_LABELS = { skip: 'SKIP', reverse: 'REV', draw2: '+2', wild: 'W', 'wild-draw4': 'W+4' };
const COLOR_NAMES = { red: '赤', blue: '青', green: '緑', yellow: '黄' };

// ── App State ─────────────────────────────────────────────────────────────────
let socket = null;
let myPlayerId = null;
let myRoomCode = null;
let myNickname = null;
let myAvatar = null;
let isHost = false;
let gameState = null;
let selectedUid = null;
let pendingColorCard = null;
let emoteOpen = false;
let countdownTimer = null;
let imageCache = {};
let pendingLandingEffect = false; // 相手カード着地アニメーション用フラグ

// ── DOM Refs ──────────────────────────────────────────────────────────────────
const screens = { top: $('screen-top'), login: $('screen-login'), lobby: $('screen-lobby'), join: $('screen-join'), waiting: $('screen-waiting'), game: $('screen-game'), roundResult: $('screen-round-result'), gameEnd: $('screen-game-end'), settings: $('screen-settings') };
const els = {
  guestSheet: $('guest-sheet'),
  btnGuestLink: $('btn-guest-link'),
  btnJoinLink: $('btn-join-link'),
  btnLoginLink: $('btn-login-link'),
  btnSheetClose: $('btn-sheet-close'),
  sheetBackdrop: document.querySelector('.guest-sheet-backdrop'),
  // Login screen
  btnLoginBack: $('btn-login-back'),
  formLogin: $('form-login'),
  formRegister: $('form-register'),
  loginUsername: $('login-username'),
  loginPassword: $('login-password'),
  loginError: $('login-error'),
  regUsername: $('reg-username'),
  regPassword: $('reg-password'),
  registerError: $('register-error'),
  nickname: $('input-nickname'),
  roomCode: $('input-room-code'),
  btnCreate: $('btn-create'),
  btnJoin: $('btn-join'),
  topError: $('top-error'),
  displayCode: $('display-room-code'),
  btnCopyUrl: $('btn-copy-url'),
  btnLeaveWaiting: $('btn-leave-waiting'),
  waitingPlayers: $('waiting-players'),
  btnStart: $('btn-start'),
  waitingForHost: $('waiting-for-host'),
  botSelector: $('bot-selector'),
  opponentsArea: $('opponents-area'),
  btnDraw: $('btn-draw-card'),
  deckCount: $('deck-count'),
  topCard: $('top-card'),
  colorIndicator: $('color-indicator'),
  directionBadge: $('direction-badge'),
  timerBar: $('timer-bar'),
  timerText: $('timer-text'),
  turnLabel: $('current-turn-label'),
  myHand: $('my-hand'),
  btnPass: $('btn-pass'),
  btnEmote: $('btn-emote'),
  btnUno: $('btn-uno'),
  btnChallenge: $('btn-challenge'),
  colorPicker: $('color-picker'),
  waitingColorOverlay: $('waiting-color-overlay'),
  waitingColorText: $('waiting-color-text'),
  emotePanel: $('emote-panel'),
  emoteFloat: $('emote-float'),
  gameToast: $('game-toast'),
  roundWinner: $('round-winner-name'),
  roundScores: $('round-scores-table'),
  roundHands: $('round-hands-table'),
  nextCountdown: $('next-round-countdown'),
  gameWinner: $('game-winner-name'),
  finalScores: $('final-scores-table'),
  btnBackLobby: $('btn-back-to-lobby'),
  // Lobby screen
  btnLobbyBack: $('btn-lobby-back'),
  lobbyUserCard: $('lobby-user-card'),
  lobbyAvatarDisplay: $('lobby-avatar-display'),
  lobbyUsernameText: $('lobby-username-text'),
  lobbyNicknameGroup: $('lobby-nickname-group'),
  lobbyNicknameInput: $('lobby-nickname-input'),
  lobbyError: $('lobby-error'),
  btnLobbyCreate: $('btn-lobby-create'),
  btnGotoJoin: $('btn-goto-join'),
  // Join screen
  btnJoinBack: $('btn-join-back'),
  joinRoomCodeInput: $('join-room-code-input'),
  joinError: $('join-error'),
  btnJoinSubmit: $('btn-join-submit'),
  // Top screen user chip
  userChip: $('user-chip'),
  chipAvatar: $('chip-avatar'),
  chipName: $('chip-name'),
  btnSettings: $('btn-settings'),
  // Settings screen
  btnSettingsBack: $('btn-settings-back'),
  btnLogout: $('btn-logout'),
  avatarGrid: $('avatar-grid'),
  avatarMsg: $('avatar-msg'),
  formChangeUsername: $('form-change-username'),
  newUsername: $('new-username'),
  confirmPwUsername: $('confirm-pw-username'),
  usernameChangeMsg: $('username-change-msg'),
  formChangePassword: $('form-change-password'),
  currentPw: $('current-pw'),
  newPw: $('new-pw'),
  passwordChangeMsg: $('password-change-msg'),
  formDeleteAccount: $('form-delete-account'),
  deletePw: $('delete-pw'),
  deleteMsg: $('delete-msg'),
};

function $(id) { return document.getElementById(id); }

// ── Screen Management ─────────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  if (screens[name]) screens[name].classList.add('active');
  if (name === 'top' && els.guestSheet) els.guestSheet.classList.add('hidden');
}

function openLobby() {
  if (myPlayerId && myNickname) {
    els.lobbyUserCard.classList.remove('hidden');
    els.lobbyNicknameGroup.classList.add('hidden');
    const avatar = myAvatar || myNickname[0].toUpperCase();
    els.lobbyAvatarDisplay.textContent = avatar;
    els.lobbyUsernameText.textContent = myNickname;
  } else {
    els.lobbyUserCard.classList.add('hidden');
    els.lobbyNicknameGroup.classList.remove('hidden');
    els.lobbyNicknameInput.value = myNickname || '';
  }
  els.lobbyError.classList.add('hidden');
  showScreen('lobby');
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Restore session
  myPlayerId = localStorage.getItem('uno_playerId');
  myRoomCode = localStorage.getItem('uno_roomCode');
  myNickname = localStorage.getItem('uno_nickname');
  myAvatar = localStorage.getItem('uno_avatar') || null;

  setupSocket();
  bindEvents();

  // ログイン済みならユーザーチップを表示
  if (myPlayerId && myNickname) updateUserChip(myNickname, myAvatar);

  // /room/:code URL で直接開いた場合
  const roomFromUrl = window.location.pathname.match(/^\/room\/(\d{4})$/);
  if (roomFromUrl) {
    els.joinRoomCodeInput.value = roomFromUrl[1];
    if (myPlayerId && myNickname) {
      showScreen('join');
    } else {
      openLobby();
    }
  } else {
    showScreen('top');
  }
});

// ── Socket Setup ──────────────────────────────────────────────────────────────
function setupSocket() {
  socket = io();

  socket.on('connect', () => {
    // Attempt rejoin if we have saved session data
    if (myPlayerId && myRoomCode) {
      socket.emit('joinRoom', { roomCode: myRoomCode, nickname: myNickname || '', playerId: myPlayerId });
    }
  });

  socket.on('error', ({ message }) => showError(message));

  socket.on('authSuccess', ({ playerId, nickname, avatar }) => {
    saveSession(null, playerId, nickname, avatar);
    myPlayerId = playerId;
    myAvatar = avatar || null;
    updateUserChip(nickname, myAvatar);
    openLobby();
  });

  socket.on('authError', ({ message }) => {
    // アクティブなフォームのエラー欄に表示
    const loginVisible = !els.formLogin.classList.contains('hidden');
    const errEl = loginVisible ? els.loginError : els.registerError;
    errEl.textContent = message;
    errEl.classList.remove('hidden');
    // submitボタンを再有効化
    const btn = (loginVisible ? els.formLogin : els.formRegister).querySelector('.auth-submit-btn');
    if (btn) { btn.disabled = false; btn.textContent = loginVisible ? 'ログイン' : 'アカウント作成'; }
    // 入力欄を再フォーカス
    if (loginVisible) els.loginUsername?.focus(); else els.regUsername?.focus();
  });

  socket.on('disconnect', () => {
    // 認証待ち中に切断された場合、ボタンを復元してエラーを表示
    const loginVisible = !els.formLogin?.classList.contains('hidden');
    const loginBtn = els.formLogin?.querySelector('.auth-submit-btn');
    const regBtn = els.formRegister?.querySelector('.auth-submit-btn');
    if (loginBtn?.disabled) {
      loginBtn.disabled = false;
      loginBtn.textContent = 'ログイン';
      els.loginError.textContent = 'サーバーに接続できません。再度お試しください。';
      els.loginError.classList.remove('hidden');
    }
    if (regBtn?.disabled) {
      regBtn.disabled = false;
      regBtn.textContent = 'アカウント作成';
      els.registerError.textContent = 'サーバーに接続できません。再度お試しください。';
      els.registerError.classList.remove('hidden');
    }
  });

  // ── Settings events ──
  socket.on('settingsSuccess', ({ field, value }) => {
    if (field === 'avatar') {
      myAvatar = value;
      updateUserChip(myNickname, myAvatar);
      document.querySelectorAll('.avatar-option').forEach(b => {
        b.classList.toggle('selected', b.dataset.avatar === value);
      });
      showSettingsMsg(els.avatarMsg, 'アイコンを変更しました', true);
    } else if (field === 'username') {
      myNickname = value;
      saveSession(myRoomCode, myPlayerId, value);
      updateUserChip(value, myAvatar);
      showSettingsMsg(els.usernameChangeMsg, 'ユーザー名を変更しました', true);
      els.newUsername.value = '';
      els.confirmPwUsername.value = '';
      const btn = els.formChangeUsername.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = false; btn.textContent = '変更する'; }
    } else if (field === 'password') {
      showSettingsMsg(els.passwordChangeMsg, 'パスワードを変更しました', true);
      els.currentPw.value = '';
      els.newPw.value = '';
      const btn = els.formChangePassword.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = false; btn.textContent = '変更する'; }
    }
  });

  socket.on('settingsError', ({ field, message }) => {
    if (field === 'avatar') {
      showSettingsMsg(els.avatarMsg, message, false);
    } else if (field === 'username') {
      showSettingsMsg(els.usernameChangeMsg, message, false);
      const btn = els.formChangeUsername.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = false; btn.textContent = '変更する'; }
    } else if (field === 'password') {
      showSettingsMsg(els.passwordChangeMsg, message, false);
      const btn = els.formChangePassword.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = false; btn.textContent = '変更する'; }
    } else if (field === 'delete') {
      showSettingsMsg(els.deleteMsg, message, false);
      const btn = els.formDeleteAccount.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = false; btn.textContent = 'アカウントを削除する'; }
    }
  });

  socket.on('accountDeleted', () => {
    clearSession();
    myAvatar = null;
    els.userChip.classList.add('hidden');
    showScreen('top');
  });

  socket.on('roomCreated', ({ roomCode, playerId, players }) => {
    saveSession(roomCode, playerId, myNickname);
    isHost = true;
    showWaitingRoom(roomCode, players, true);
  });

  socket.on('roomJoined', ({ roomCode, playerId, isHost: host }) => {
    saveSession(roomCode, playerId, myNickname);
    isHost = host;
    // roomUpdate will follow with players list
    showScreen('waiting');
    els.displayCode.textContent = roomCode;
    els.btnStart.classList.toggle('hidden', !host);
    els.waitingForHost.classList.toggle('hidden', host);
    els.botSelector.classList.toggle('hidden', !host);
    // If reconnecting to an active game, gameState event will fire next
  });

  socket.on('roomUpdate', ({ players }) => {
    renderWaitingPlayers(players);
    // Update host controls if our host status changed
    const me = players.find(p => p.playerId === myPlayerId);
    if (me) {
      isHost = me.isHost;
      els.btnStart.classList.toggle('hidden', !isHost);
      els.waitingForHost.classList.toggle('hidden', isHost);
      els.botSelector.classList.toggle('hidden', !isHost);
    }
  });

  socket.on('gameStarting', () => {
    showToast('ゲームを開始します...', 2000);
  });

  socket.on('roundStarted', () => {
    clearCountdown();
    showScreen('game');
  });

  socket.on('gameState', (state) => {
    gameState = state;
    renderGame(state);
  });

  socket.on('turnStart', ({ playerId, seconds }) => {
    updateTimer(seconds, TURN_SECONDS);
    const player = findPlayer(playerId);
    const isMe = playerId === myPlayerId;
    els.turnLabel.textContent = isMe ? 'あなたのターン！' : `${player?.nickname || '?'} のターン`;
    els.btnPass.classList.add('hidden');
    if (isMe) {
      showTurnBanner();
      // Green flash on game screen
      const gs = screens.game;
      gs.classList.remove('my-turn-flash');
      void gs.offsetWidth;
      gs.classList.add('my-turn-flash');
    }
  });

  socket.on('timerTick', ({ seconds }) => {
    updateTimer(seconds, TURN_SECONDS);
  });

  socket.on('cardPlayed', ({ playerId, imageId }) => {
    const isMe = playerId === myPlayerId;
    if (!isMe) {
      // Opponent played: trigger landing animation when gameState updates top card
      pendingLandingEffect = true;
    }
  });

  socket.on('playerDrewCards', ({ playerId, count }) => {
    if (playerId !== myPlayerId) {
      const player = findPlayer(playerId);
      showToast(`${player?.nickname || '?'} がカードを ${count} 枚引いた`, 1500);
    }
  });

  socket.on('waitingForColor', ({ playerId }) => {
    if (playerId === myPlayerId) {
      // Show color picker to the player who played wild
      els.colorPicker.classList.remove('hidden');
    } else {
      const player = findPlayer(playerId);
      els.waitingColorText.textContent = `${player?.nickname || '?'} が色を選んでいます...`;
      els.waitingColorOverlay.classList.remove('hidden');
    }
  });

  socket.on('colorChosen', ({ color, playerId }) => {
    els.colorPicker.classList.add('hidden');
    els.waitingColorOverlay.classList.add('hidden');
    const player = findPlayer(playerId);
    const name = playerId === myPlayerId ? 'あなた' : player?.nickname || '?';
    showToast(`${name} が${COLOR_NAMES[color]}を選んだ`, 1500);
  });

  socket.on('unoWindow', ({ playerId }) => {
    const isMe = playerId === myPlayerId;
    if (isMe) {
      els.btnUno.classList.remove('hidden');
      els.btnChallenge.classList.add('hidden');
    } else {
      els.btnUno.classList.add('hidden');
      const player = findPlayer(playerId);
      els.btnChallenge.textContent = `告発！ ${player?.nickname || '?'}`;
      els.btnChallenge.dataset.target = playerId;
      els.btnChallenge.classList.remove('hidden');
    }
  });

  socket.on('unoDeclared', ({ playerId }) => {
    els.btnUno.classList.add('hidden');
    els.btnChallenge.classList.add('hidden');
    const player = findPlayer(playerId);
    const name = playerId === myPlayerId ? 'あなた' : player?.nickname || '?';
    showToast(`${name} が UNO! を宣言しました 🎉`, 2000);
  });

  socket.on('unoChallenge', ({ challengerId, targetId, success }) => {
    els.btnUno.classList.add('hidden');
    els.btnChallenge.classList.add('hidden');
    const challenger = findPlayer(challengerId);
    const target = findPlayer(targetId);
    const cName = challengerId === myPlayerId ? 'あなた' : challenger?.nickname || '?';
    const tName = targetId === myPlayerId ? 'あなた' : target?.nickname || '?';
    if (success) {
      showToast(`${cName} の告発成功！ ${tName} は2枚ドロー 😱`, 2500);
    } else {
      showToast(`${cName} の告発失敗！ すでに宣言済み`, 2000);
    }
  });

  socket.on('deckReshuffled', () => {
    showToast('山札をシャッフルしました', 1500);
  });

  socket.on('emote', ({ playerId, emoteId }) => {
    const player = findPlayer(playerId);
    const name = playerId === myPlayerId ? 'あなた' : player?.nickname || '?';
    const em = EMOTE_MAP[emoteId];
    if (!em) return;
    showEmoteFloat(`${em.emoji}\n${name}: ${em.label}`);
  });

  socket.on('playerDisconnected', ({ playerId, players }) => {
    renderWaitingPlayers(players);
    const player = findPlayer(playerId);
    showToast(`${player?.nickname || '?'} が切断されました`, 2000);
    if (gameState) {
      gameState.players = players;
      renderOpponents(players, gameState.currentPlayerIndex);
    }
  });

  socket.on('playerReconnected', ({ playerId, players }) => {
    if (players) renderWaitingPlayers(players);
    const player = (players || []).find(p => p.playerId === playerId);
    showToast(`${player?.nickname || '?'} が再接続しました`, 2000);
    if (gameState) {
      gameState.players = players;
      renderOpponents(players, gameState.currentPlayerIndex);
    }
  });

  socket.on('playerLeft', ({ playerId, players }) => {
    const player = findPlayer(playerId);
    showToast(`${player?.nickname || '?'} が退出しました`, 2000);
    if (players && gameState) {
      gameState.players = players;
      renderOpponents(players, gameState.currentPlayerIndex);
    }
  });

  socket.on('roundResult', ({ winnerId, roundScores, totalScores, hands }) => {
    showRoundResult(winnerId, roundScores, totalScores, hands);
  });

  socket.on('gameResult', ({ winnerId, totalScores }) => {
    showGameResult(winnerId, totalScores);
  });

  socket.on('gameCancelled', ({ reason }) => {
    showToast(reason, 3000);
    setTimeout(() => {
      showScreen('waiting');
      els.btnStart.classList.toggle('hidden', !isHost);
      els.waitingForHost.classList.toggle('hidden', isHost);
      els.botSelector.classList.toggle('hidden', !isHost);
    }, 3000);
  });

  socket.on('drewCard', ({ card, canPlay: cp }) => {
    // gameState will be updated separately; show pass button if card is playable
    if (cp) {
      els.btnPass.classList.remove('hidden');
      showToast('引いたカードを出しますか？ 出さない場合はパスを押してください', 3000);
    }
  });
}

// ── Settings helpers ──────────────────────────────────────────────────────────
function updateUserChip(nickname, avatar) {
  if (!nickname) {
    els.userChip.classList.add('hidden');
    els.btnLoginLink?.classList.remove('hidden');
    return;
  }
  els.userChip.classList.remove('hidden');
  els.btnLoginLink?.classList.add('hidden');
  els.chipName.textContent = nickname;
  if (avatar) {
    els.chipAvatar.textContent = avatar;
    els.chipAvatar.style.fontSize = '1.1rem';
    els.chipAvatar.style.background = '#111';
  } else {
    els.chipAvatar.textContent = nickname[0].toUpperCase();
    els.chipAvatar.style.fontSize = '.95rem';
    els.chipAvatar.style.background = '#111';
  }
}

function showSettingsMsg(el, message, success) {
  el.textContent = message;
  el.className = 'settings-msg ' + (success ? 'success' : 'error');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function openSettings() {
  // 現在選択中のアバターをハイライト
  document.querySelectorAll('.avatar-option').forEach(b => {
    b.classList.toggle('selected', b.dataset.avatar === myAvatar);
  });
  // メッセージをリセット
  [els.avatarMsg, els.usernameChangeMsg, els.passwordChangeMsg, els.deleteMsg]
    .forEach(el => el.classList.add('hidden'));
  showScreen('settings');
}

// ── Guest sheet open/close ────────────────────────────────────────────────────
function openGuestSheet() {
  els.guestSheet.classList.remove('hidden');
  setTimeout(() => els.nickname.focus(), 300);
}
function closeGuestSheet() {
  els.guestSheet.classList.add('hidden');
}

// ── Event Bindings ────────────────────────────────────────────────────────────
function bindEvents() {
  els.btnGuestLink.addEventListener('click', () => {
    myPlayerId = null;
    myNickname = null;
    openLobby();
  });
  els.btnJoinLink.addEventListener('click', () => {
    myPlayerId = null;
    myNickname = null;
    openLobby();
  });
  els.btnLoginLink.addEventListener('click', () => showScreen('login'));
  els.btnLoginBack.addEventListener('click', () => showScreen('top'));

  // ── Lobby ──
  els.btnLobbyBack.addEventListener('click', () => showScreen('top'));

  els.btnLobbyCreate.addEventListener('click', () => {
    const nick = myPlayerId ? myNickname : els.lobbyNicknameInput.value.trim();
    if (!nick) {
      els.lobbyError.textContent = 'ニックネームを入力してください';
      els.lobbyError.classList.remove('hidden');
      return;
    }
    myNickname = nick;
    els.lobbyError.classList.add('hidden');
    socket.emit('createRoom', { nickname: nick });
  });

  els.btnGotoJoin.addEventListener('click', () => {
    if (!myPlayerId) {
      const nick = els.lobbyNicknameInput.value.trim();
      if (!nick) {
        els.lobbyError.textContent = 'ニックネームを入力してください';
        els.lobbyError.classList.remove('hidden');
        return;
      }
      myNickname = nick;
    }
    els.lobbyError.classList.add('hidden');
    els.joinError.classList.add('hidden');
    els.joinRoomCodeInput.value = '';
    showScreen('join');
  });

  els.lobbyNicknameInput.addEventListener('keydown', e => { if (e.key === 'Enter') els.btnLobbyCreate.click(); });

  // ── Join ──
  els.btnJoinBack.addEventListener('click', () => showScreen('lobby'));

  els.btnJoinSubmit.addEventListener('click', () => {
    const code = els.joinRoomCodeInput.value.trim();
    if (!/^\d{4}$/.test(code)) {
      els.joinError.textContent = '4桁のルームコードを入力してください';
      els.joinError.classList.remove('hidden');
      return;
    }
    const nick = myPlayerId ? myNickname : myNickname;
    if (!nick) { showScreen('lobby'); return; }
    els.joinError.classList.add('hidden');
    socket.emit('joinRoom', { roomCode: code, nickname: nick });
  });

  els.joinRoomCodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') els.btnJoinSubmit.click(); });

  // ── Settings ──
  els.btnSettings.addEventListener('click', openSettings);
  els.btnSettingsBack.addEventListener('click', () => showScreen('top'));

  els.btnLogout.addEventListener('click', () => {
    myAvatar = null;
    clearSession();
    els.userChip.classList.add('hidden');
    showScreen('top');
  });

  els.avatarGrid.addEventListener('click', e => {
    const btn = e.target.closest('.avatar-option');
    if (!btn) return;
    socket.emit('setAvatar', { avatar: btn.dataset.avatar });
  });

  els.formChangeUsername.addEventListener('submit', e => {
    e.preventDefault();
    const newUsername = els.newUsername.value.trim();
    const password = els.confirmPwUsername.value;
    const btn = els.formChangeUsername.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = '変更中...';
    socket.emit('changeUsername', { newUsername, password });
  });

  els.formChangePassword.addEventListener('submit', e => {
    e.preventDefault();
    const currentPassword = els.currentPw.value;
    const newPassword = els.newPw.value;
    const btn = els.formChangePassword.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = '変更中...';
    socket.emit('changePassword', { currentPassword, newPassword });
  });

  els.formDeleteAccount.addEventListener('submit', e => {
    e.preventDefault();
    if (!confirm('本当にアカウントを削除しますか？この操作は取り消せません。')) return;
    const password = els.deletePw.value;
    const btn = els.formDeleteAccount.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = '削除中...';
    socket.emit('deleteAccount', { password });
  });

  // ── Login / Register tabs ──
  document.querySelectorAll('.login-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const isLogin = tab.dataset.tab === 'login';
      els.formLogin.classList.toggle('hidden', !isLogin);
      els.formRegister.classList.toggle('hidden', isLogin);
      els.loginError.classList.add('hidden');
      els.registerError.classList.add('hidden');
    });
  });

  // ── Password visibility toggle ──
  document.querySelectorAll('.btn-toggle-pw').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
      btn.textContent = input.type === 'password' ? '👁' : '🙈';
    });
  });

  // ── Login form submit ──
  els.formLogin.addEventListener('submit', e => {
    e.preventDefault();
    const username = els.loginUsername.value.trim();
    const password = els.loginPassword.value;
    els.loginError.classList.add('hidden');
    const btn = els.formLogin.querySelector('.auth-submit-btn');
    btn.disabled = true;
    btn.textContent = '確認中...';
    socket.emit('login', { username, password });
  });

  // ── Register form submit ──
  els.formRegister.addEventListener('submit', e => {
    e.preventDefault();
    const username = els.regUsername.value.trim();
    const password = els.regPassword.value;
    els.registerError.classList.add('hidden');
    const btn = els.formRegister.querySelector('.auth-submit-btn');
    btn.disabled = true;
    btn.textContent = '作成中...';
    socket.emit('register', { username, password });
  });

  els.btnLeaveWaiting.addEventListener('click', () => {
    socket.emit('leaveRoom');
    clearSession();
    showScreen('top');
  });

  els.btnCopyUrl.addEventListener('click', () => {
    const url = `${location.origin}/room/${myRoomCode}`;
    navigator.clipboard.writeText(url).then(() => showToast('URLをコピーしました！', 1500));
  });

  // ボット数ボタンのトグル
  document.querySelectorAll('.bot-count-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bot-count-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  els.btnStart.addEventListener('click', () => {
    const activeBtn = document.querySelector('.bot-count-btn.active');
    const botCount = activeBtn ? parseInt(activeBtn.dataset.count, 10) : 0;
    socket.emit('startGame', { botCount });
  });

  els.btnDraw.addEventListener('click', () => {
    if (!gameState?.isMyTurn || gameState?.waitingForColor || gameState?.hasDrawnThisTurn) return;
    socket.emit('drawCard');
    selectedUid = null;
  });

  els.btnPass.addEventListener('click', () => {
    socket.emit('passTurn');
    els.btnPass.classList.add('hidden');
  });

  els.btnUno.addEventListener('click', () => {
    socket.emit('declareUno');
    els.btnUno.classList.add('hidden');
  });

  els.btnChallenge.addEventListener('click', () => {
    const target = els.btnChallenge.dataset.target;
    if (target) socket.emit('challengeUno', { targetPlayerId: target });
    els.btnChallenge.classList.add('hidden');
  });

  // Color picker
  document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      els.colorPicker.classList.add('hidden');
      socket.emit('chooseColor', { color });
    });
  });

  // Emote button
  els.btnEmote.addEventListener('click', (e) => {
    e.stopPropagation();
    emoteOpen = !emoteOpen;
    els.emotePanel.classList.toggle('hidden', !emoteOpen);
  });

  document.querySelectorAll('.emote-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('sendEmote', { emoteId: btn.dataset.emote });
      emoteOpen = false;
      els.emotePanel.classList.add('hidden');
    });
  });

  document.addEventListener('click', (e) => {
    if (emoteOpen && !els.emotePanel.contains(e.target) && e.target !== els.btnEmote) {
      emoteOpen = false;
      els.emotePanel.classList.add('hidden');
    }
  });

  els.btnBackLobby.addEventListener('click', () => {
    // Rejoin the waiting room
    if (myRoomCode && myPlayerId) {
      socket.emit('joinRoom', { roomCode: myRoomCode, nickname: myNickname, playerId: myPlayerId });
    } else {
      showScreen('top');
    }
  });

  // Room code input: numbers only
  els.roomCode.addEventListener('input', () => {
    els.roomCode.value = els.roomCode.value.replace(/\D/g, '').slice(0, 4);
  });
}

// ── Render: Waiting Room ──────────────────────────────────────────────────────
function showWaitingRoom(roomCode, players, host) {
  myRoomCode = roomCode;
  isHost = host;
  showScreen('waiting');
  els.displayCode.textContent = roomCode;
  els.btnStart.classList.toggle('hidden', !host);
  els.waitingForHost.classList.toggle('hidden', host);
  els.botSelector.classList.toggle('hidden', !host);
  renderWaitingPlayers(players);
}

function renderWaitingPlayers(players) {
  els.waitingPlayers.innerHTML = '';
  players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = `waiting-player ${p.connected === false ? 'disconnected' : ''}`;
    div.innerHTML = `
      <div class="player-avatar avatar-${i}">${p.nickname.charAt(0).toUpperCase()}</div>
      <span class="player-name">${escHtml(p.nickname)}${p.playerId === myPlayerId ? ' (あなた)' : ''}</span>
      ${p.isHost ? '<span class="host-badge">HOST</span>' : ''}
      ${p.connected === false ? '<span style="color:var(--text-muted);font-size:.8rem">切断中</span>' : ''}
    `;
    els.waitingPlayers.appendChild(div);
  });
}

// ── Render: Game Screen ───────────────────────────────────────────────────────
function renderGame(state) {
  if (!state) return;
  renderOpponents(state.players, state.currentPlayerIndex);
  renderTopCard(state.topCard, state.currentColor);
  renderMyHand(state.myHand, state.playableUids, state.drawnCardUid, state.isMyTurn);
  updateColorIndicator(state.currentColor);
  updateDirectionBadge(state.direction);
  els.deckCount.textContent = state.deckCount;

  // Restore UNO state on reconnect
  if (state.unoState && !state.unoState.declared) {
    if (state.unoState.playerId === myPlayerId) {
      els.btnUno.classList.remove('hidden');
    } else {
      const target = findPlayer(state.unoState.playerId);
      els.btnChallenge.textContent = `告発！ ${target?.nickname || '?'}`;
      els.btnChallenge.dataset.target = state.unoState.playerId;
      els.btnChallenge.classList.remove('hidden');
    }
  }

  // Pass button visibility
  if (state.isMyTurn && state.hasDrawnThisTurn) {
    els.btnPass.classList.remove('hidden');
  }

  // Color picker for reconnect
  if (state.waitingForColor === myPlayerId) {
    els.colorPicker.classList.remove('hidden');
  } else if (state.waitingForColor) {
    const player = state.players.find(p => p.playerId === state.waitingForColor);
    els.waitingColorText.textContent = `${player?.nickname || '?'} が色を選んでいます...`;
    els.waitingColorOverlay.classList.remove('hidden');
  }
}

function renderOpponents(players, currentPlayerIndex) {
  if (!players) return;
  const others = players.filter(p => p.playerId !== myPlayerId);
  els.opponentsArea.innerHTML = '';

  others.forEach((player, i) => {
    const curPlayer = players[currentPlayerIndex];
    const isActive = curPlayer && curPlayer.playerId === player.playerId;
    const idx = players.findIndex(p => p.playerId === player.playerId);

    const div = document.createElement('div');
    div.className = `opponent ${isActive ? 'active-player' : ''}`;

    const handCount = Math.min(player.cardCount, 20);
    const miniCards = Array.from({ length: handCount }, () =>
      `<div class="opponent-card-mini"></div>`
    ).join('');

    div.innerHTML = `
      <div class="opponent-name-bar">${escHtml(player.nickname)}${player.connected === false ? ' 📵' : ''}</div>
      <div class="opponent-hand">${miniCards}</div>
      <div class="opponent-info-row">
        <span class="opponent-card-count">${player.cardCount}枚</span>
        <span class="opponent-score">${player.score}pt</span>
      </div>
    `;
    els.opponentsArea.appendChild(div);
  });
}

function renderTopCard(card, currentColor) {
  if (!card) return;
  els.topCard.innerHTML = '';
  els.topCard.className = `card card--${card.color}`;
  renderCardContent(els.topCard, card);

  // 相手カード着地アニメーション
  if (pendingLandingEffect) {
    pendingLandingEffect = false;
    triggerLandingEffect();
  }
}

function renderMyHand(hand, playableUids, drawnCardUid, isMyTurn) {
  els.myHand.innerHTML = '';
  if (!hand) return;

  hand.forEach(card => {
    const el = document.createElement('div');
    const isPlayable = playableUids && playableUids.includes(card.uid);
    const isDrawn = card.uid === drawnCardUid;
    el.className = [
      'card', `card--${card.color}`, 'hand-card',
      isDrawn ? 'drawn-card' : '',
      (isMyTurn && isPlayable) ? 'playable' : '',
      (isMyTurn && !isPlayable) ? 'not-playable' : ''
    ].filter(Boolean).join(' ');
    el.dataset.uid = card.uid;
    renderCardContent(el, card);

    el.addEventListener('click', () => handleCardClick(card, isPlayable, isMyTurn));
    els.myHand.appendChild(el);
  });
}

function renderCardContent(el, card) {
  const label = getCardLabel(card);
  el.innerHTML = `
    <span class="card-corner top-left">${label}</span>
    <span class="card-label">${label}</span>
    <span class="card-corner bottom-right">${label}</span>
  `;

  // Try to load actual image asset
  const imgSrc = `/assets/cards/${card.imageId}.png`;
  if (imageCache[card.imageId] === 'ok') {
    applyCardImage(el, imgSrc);
  } else if (imageCache[card.imageId] !== 'fail') {
    const img = new Image();
    img.onload = () => { imageCache[card.imageId] = 'ok'; applyCardImage(el, imgSrc); };
    img.onerror = () => { imageCache[card.imageId] = 'fail'; };
    img.src = imgSrc;
  }
}

function applyCardImage(el, src) {
  el.classList.add('has-image');
  el.innerHTML = `<img src="${src}" alt="">`;
}

// ── Card Interaction ──────────────────────────────────────────────────────────
function handleCardClick(card, isPlayable, isMyTurn) {
  if (!isMyTurn || !isPlayable) return;
  if (gameState?.waitingForColor) return;

  if (card.type === 'wild' || card.type === 'wild-draw4') {
    const el = els.myHand.querySelector(`[data-uid="${card.uid}"]`);
    if (el) flyCardToDiscard(el);
    socket.emit('playCard', { uid: card.uid });
    selectedUid = null;
    els.btnPass.classList.add('hidden');
  } else {
    if (selectedUid === card.uid) {
      // 2回目タップ → プレイ
      const el = els.myHand.querySelector(`[data-uid="${card.uid}"]`);
      if (el) flyCardToDiscard(el);
      socket.emit('playCard', { uid: card.uid });
      selectedUid = null;
      els.btnPass.classList.add('hidden');
    } else {
      // 1回目タップ → 選択
      document.querySelectorAll('.hand-card.selected').forEach(c => {
        c.classList.remove('selected', 'just-selected');
      });
      selectedUid = card.uid;
      const el = els.myHand.querySelector(`[data-uid="${card.uid}"]`);
      if (el) {
        el.classList.add('selected', 'just-selected');
        el.addEventListener('animationend', () => el.classList.remove('just-selected'), { once: true });
      }
    }
  }
}

// ── Play Animation ────────────────────────────────────────────────────────────
function flyCardToDiscard(sourceEl) {
  const srcRect = sourceEl.getBoundingClientRect();
  const dstRect = els.topCard.getBoundingClientRect();

  // 元のカードを即座に非表示（サーバー応答後に再描画される）
  sourceEl.style.opacity = '0';
  sourceEl.style.pointerEvents = 'none';

  // 飛ぶクローンを生成
  const clone = sourceEl.cloneNode(true);
  const rot = (Math.random() - 0.5) * 28;
  clone.style.cssText = `
    position: fixed;
    left: ${srcRect.left}px; top: ${srcRect.top}px;
    width: ${srcRect.width}px; height: ${srcRect.height}px;
    margin: 0; z-index: 999; pointer-events: none;
    transition:
      left   0.38s cubic-bezier(0.25, 0.46, 0.45, 0.94),
      top    0.38s cubic-bezier(0.25, 0.46, 0.45, 0.94),
      width  0.38s ease, height 0.38s ease,
      transform 0.38s cubic-bezier(0.25, 0.46, 0.45, 0.94),
      opacity 0.1s ease 0.32s;
    transform-origin: center center;
    transform: scale(1.05);
  `;
  document.body.appendChild(clone);

  // 次フレームでアニメーション開始
  requestAnimationFrame(() => requestAnimationFrame(() => {
    clone.style.left      = `${dstRect.left}px`;
    clone.style.top       = `${dstRect.top}px`;
    clone.style.width     = `${dstRect.width}px`;
    clone.style.height    = `${dstRect.height}px`;
    clone.style.transform = `rotate(${rot}deg) scale(1.08)`;
    clone.style.opacity   = '0';
  }));

  // 着地エフェクト
  setTimeout(() => {
    clone.remove();
    triggerLandingEffect(rot);
  }, 420);
}

function triggerLandingEffect(rot = -5) {
  // バウンスアニメーション
  els.topCard.style.setProperty('--land-rot', `${rot}deg`);
  els.topCard.classList.remove('card-landing');
  void els.topCard.offsetWidth; // reflow
  els.topCard.classList.add('card-landing');
  els.topCard.addEventListener('animationend', () => els.topCard.classList.remove('card-landing'), { once: true });

  // リップル
  const ripple = document.createElement('div');
  ripple.className = 'play-ripple';
  const discardArea = els.topCard.parentElement;
  discardArea.style.position = 'relative';
  discardArea.appendChild(ripple);
  setTimeout(() => ripple.remove(), 600);
}

// "あなたのターン" バナー
let bannerTimer = null;
function showTurnBanner() {
  // 既存バナーを削除
  document.querySelectorAll('.turn-banner').forEach(b => b.remove());
  if (bannerTimer) clearTimeout(bannerTimer);

  const banner = document.createElement('div');
  banner.className = 'turn-banner';
  banner.textContent = '✨ あなたのターン！';
  document.body.appendChild(banner);

  bannerTimer = setTimeout(() => {
    banner.classList.add('out');
    banner.addEventListener('animationend', () => banner.remove(), { once: true });
  }, 1800);
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function updateTimer(seconds, total) {
  const pct = Math.max(0, (seconds / total)) * 100;
  els.timerBar.style.setProperty('--timer-w', pct + '%');
  els.timerBar.classList.toggle('urgent', seconds <= 5);
  els.timerText.textContent = seconds;
}

// ── Direction Badge ───────────────────────────────────────────────────────────
function updateDirectionBadge(direction) {
  els.directionBadge.textContent = direction === 1 ? '↻ 時計回り' : '↺ 反時計回り';
  els.directionBadge.classList.toggle('reversed', direction === -1);
}

// ── Color Indicator ───────────────────────────────────────────────────────────
function updateColorIndicator(color) {
  els.colorIndicator.className = `color-indicator ${color || ''}`;
}

// ── Round Result Screen ───────────────────────────────────────────────────────
function showRoundResult(winnerId, roundScores, totalScores, hands) {
  clearCountdown();
  showScreen('roundResult');

  const winner = findPlayer(winnerId);
  els.roundWinner.textContent = winnerId === myPlayerId ? 'あなた' : (winner?.nickname || '?');

  // Scores table
  const players = gameState?.players || [];
  els.roundScores.innerHTML = players.map(p => {
    const pts = roundScores[p.playerId] || 0;
    const total = totalScores[p.playerId] || 0;
    const isW = p.playerId === winnerId;
    return `<div class="score-row ${isW ? 'winner-row' : ''}">
      <span class="score-name">${isW ? '🏆 ' : ''}${escHtml(p.playerId === myPlayerId ? 'あなた' : p.nickname)}</span>
      <span class="score-value">${total} pt <span class="score-delta">+${pts}</span></span>
    </div>`;
  }).join('');

  // Hands display
  els.roundHands.innerHTML = players.filter(p => p.playerId !== winnerId).map(p => {
    const playerHand = hands[p.playerId] || [];
    const miniCards = playerHand.map(c =>
      `<span class="mini-card ${c.color}">${getCardLabel(c)}</span>`
    ).join('');
    return `<div class="hand-row">
      <div class="hand-row-name">${escHtml(p.playerId === myPlayerId ? 'あなたの残り手札' : p.nickname + ' の残り手札')}</div>
      <div class="hand-cards-mini">${miniCards || '<span style="color:var(--text-muted)">なし</span>'}</div>
    </div>`;
  }).join('');

  // Countdown
  let secs = 6;
  els.nextCountdown.textContent = `次のラウンドまで ${secs} 秒...`;
  countdownTimer = setInterval(() => {
    secs--;
    if (secs <= 0) {
      clearCountdown();
      els.nextCountdown.textContent = '';
    } else {
      els.nextCountdown.textContent = `次のラウンドまで ${secs} 秒...`;
    }
  }, 1000);
}

function clearCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

// ── Game End Screen ───────────────────────────────────────────────────────────
function showGameResult(winnerId, totalScores) {
  clearCountdown();
  showScreen('gameEnd');

  const winner = findPlayer(winnerId);
  els.gameWinner.textContent = winnerId === myPlayerId ? 'あなた' : (winner?.nickname || '?');

  const players = gameState?.players || [];
  const sorted = [...players].sort((a, b) => (totalScores[b.playerId] || 0) - (totalScores[a.playerId] || 0));
  const medals = ['🥇', '🥈', '🥉', ''];

  els.finalScores.innerHTML = sorted.map((p, i) => `
    <div class="score-row ${p.playerId === winnerId ? 'winner-row' : ''}">
      <span class="score-name">${medals[i] || ''} ${escHtml(p.playerId === myPlayerId ? 'あなた' : p.nickname)}</span>
      <span class="score-value">${totalScores[p.playerId] || 0} pt</span>
    </div>
  `).join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getCardLabel(card) {
  if (card.type === 'number') return String(card.value);
  return CARD_LABELS[card.type] || card.type.toUpperCase();
}

function findPlayer(playerId) {
  return (gameState?.players || []).find(p => p.playerId === playerId) || null;
}

function saveSession(roomCode, playerId, nickname, avatar) {
  if (roomCode !== undefined) myRoomCode = roomCode;
  if (playerId) myPlayerId = playerId;
  if (nickname) myNickname = nickname;
  if (avatar !== undefined) myAvatar = avatar || null;
  if (roomCode) localStorage.setItem('uno_roomCode', roomCode);
  if (playerId) localStorage.setItem('uno_playerId', playerId);
  if (nickname) localStorage.setItem('uno_nickname', nickname);
  if (avatar) localStorage.setItem('uno_avatar', avatar);
  else if (avatar === null) localStorage.removeItem('uno_avatar');
}

function clearSession() {
  myRoomCode = null;
  myPlayerId = null;
  myNickname = null;
  myAvatar = null;
  localStorage.removeItem('uno_roomCode');
  localStorage.removeItem('uno_playerId');
  localStorage.removeItem('uno_nickname');
  localStorage.removeItem('uno_avatar');
}

function showError(msg) {
  els.topError.textContent = msg;
  els.topError.classList.remove('hidden');
}
function hideError() { els.topError.classList.add('hidden'); }

let toastTimer = null;
function showToast(msg, duration = 2000) {
  els.gameToast.textContent = msg;
  els.gameToast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.gameToast.classList.add('hidden'), duration);
}

function showEmoteFloat(text) {
  const el = document.createElement('div');
  el.className = 'emote-float';
  el.style.cssText = `position:fixed;top:40%;left:${20 + Math.random()*60}%;transform:translate(-50%,-50%);font-size:2.5rem;text-align:center;z-index:300;pointer-events:none;white-space:pre;animation:floatUp 2.5s ease-out forwards;`;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
