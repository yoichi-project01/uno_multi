'use strict';

require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL が設定されていません。.env ファイルを確認してください。');
}

const connectionString = process.env.DATABASE_URL
  .replace('channel_binding=require&', '')
  .replace('&channel_binding=require', '');

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT   UNIQUE NOT NULL,
      password_hash TEXT   NOT NULL,
      player_id     TEXT   UNIQUE NOT NULL,
      avatar        TEXT,
      created_at    BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friendships (
      id           SERIAL PRIMARY KEY,
      requester_id TEXT   NOT NULL,
      recipient_id TEXT   NOT NULL,
      status       TEXT   NOT NULL DEFAULT 'pending',
      created_at   BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(requester_id, recipient_id)
    );
  `);
  console.log('DB: migration OK');
}

migrate().catch(err => {
  console.error('DB migration failed:', err.message);
  process.exit(1);
});

async function insertUser(username, passwordHash, playerId) {
  await pool.query(
    'INSERT INTO users (username, password_hash, player_id) VALUES ($1, $2, $3)',
    [username, passwordHash, playerId]
  );
}

async function getUserByUsername(username) {
  const { rows } = await pool.query(
    'SELECT username, password_hash, player_id, avatar FROM users WHERE username = $1',
    [username]
  );
  return rows[0] ?? null;
}

async function getUserByPlayerId(playerId) {
  const { rows } = await pool.query(
    'SELECT username, password_hash, player_id, avatar FROM users WHERE player_id = $1',
    [playerId]
  );
  return rows[0] ?? null;
}

async function updateUsername(playerId, newUsername) {
  await pool.query('UPDATE users SET username = $1 WHERE player_id = $2', [newUsername, playerId]);
}

async function updatePassword(playerId, passwordHash) {
  await pool.query('UPDATE users SET password_hash = $1 WHERE player_id = $2', [passwordHash, playerId]);
}

async function updateAvatar(playerId, avatar) {
  await pool.query('UPDATE users SET avatar = $1 WHERE player_id = $2', [avatar, playerId]);
}

async function deleteUser(playerId) {
  await pool.query('DELETE FROM friendships WHERE requester_id = $1 OR recipient_id = $1', [playerId]);
  await pool.query('DELETE FROM users WHERE player_id = $1', [playerId]);
}

// ── Friendships ──────────────────────────────────────────────────────────────

async function sendFriendRequest(requesterId, recipientUsername) {
  const recipient = await getUserByUsername(recipientUsername);
  if (!recipient) throw new Error('USER_NOT_FOUND');
  if (recipient.player_id === requesterId) throw new Error('SELF');

  const { rows } = await pool.query(
    `SELECT * FROM friendships WHERE (requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1)`,
    [requesterId, recipient.player_id]
  );
  const existing = rows[0];
  if (existing) {
    if (existing.status === 'accepted') throw new Error('ALREADY_FRIENDS');
    if (existing.requester_id === requesterId) throw new Error('ALREADY_REQUESTED');
    // 相手からの保留中リクエストが既にある場合は自動的に承認扱いにする
    await pool.query(`UPDATE friendships SET status = 'accepted' WHERE id = $1`, [existing.id]);
    return { autoAccepted: true, friendPlayerId: recipient.player_id, friendUsername: recipient.username, friendAvatar: recipient.avatar };
  }

  await pool.query(
    `INSERT INTO friendships (requester_id, recipient_id, status) VALUES ($1, $2, 'pending')`,
    [requesterId, recipient.player_id]
  );
  return { autoAccepted: false, friendPlayerId: recipient.player_id, friendUsername: recipient.username, friendAvatar: recipient.avatar };
}

async function respondToFriendRequest(recipientId, requesterId, accept) {
  if (accept) {
    const { rowCount } = await pool.query(
      `UPDATE friendships SET status = 'accepted' WHERE requester_id = $1 AND recipient_id = $2 AND status = 'pending'`,
      [requesterId, recipientId]
    );
    return rowCount > 0;
  }
  const { rowCount } = await pool.query(
    `DELETE FROM friendships WHERE requester_id = $1 AND recipient_id = $2 AND status = 'pending'`,
    [requesterId, recipientId]
  );
  return rowCount > 0;
}

async function removeFriendship(playerId, otherPlayerId) {
  await pool.query(
    `DELETE FROM friendships WHERE (requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1)`,
    [playerId, otherPlayerId]
  );
}

async function getFriendsList(playerId) {
  const { rows } = await pool.query(
    `SELECT u.player_id, u.username, u.avatar
     FROM friendships f
     JOIN users u ON u.player_id = CASE WHEN f.requester_id = $1 THEN f.recipient_id ELSE f.requester_id END
     WHERE (f.requester_id = $1 OR f.recipient_id = $1) AND f.status = 'accepted'
     ORDER BY u.username`,
    [playerId]
  );
  return rows;
}

async function getPendingRequests(playerId) {
  const { rows } = await pool.query(
    `SELECT u.player_id, u.username, u.avatar, f.created_at
     FROM friendships f
     JOIN users u ON u.player_id = f.requester_id
     WHERE f.recipient_id = $1 AND f.status = 'pending'
     ORDER BY f.created_at DESC`,
    [playerId]
  );
  return rows;
}

module.exports = {
  insertUser, getUserByUsername, getUserByPlayerId, updateUsername, updatePassword, updateAvatar, deleteUser,
  sendFriendRequest, respondToFriendRequest, removeFriendship, getFriendsList, getPendingRequests,
};
