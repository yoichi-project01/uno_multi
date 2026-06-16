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
  await pool.query('DELETE FROM users WHERE player_id = $1', [playerId]);
}

module.exports = { insertUser, getUserByUsername, getUserByPlayerId, updateUsername, updatePassword, updateAvatar, deleteUser };
