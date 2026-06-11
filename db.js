'use strict';

require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL が設定されていません。.env ファイルを確認してください。');
}

// Neon は pooler 接続文字列に channel_binding=require が付くことがある
// pg ドライバーが未対応のパラメータを除去して接続
const connectionString = process.env.DATABASE_URL.replace('channel_binding=require&', '').replace('&channel_binding=require', '');

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
});

// ── Schema migration ──────────────────────────────────────────────────────────
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT   UNIQUE NOT NULL,
      password_hash TEXT   NOT NULL,
      player_id     TEXT   UNIQUE NOT NULL,
      created_at    BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
  `);
  console.log('DB: migration OK');
}

migrate().catch(err => {
  console.error('DB migration failed:', err.message);
  process.exit(1);
});

// ── Query helpers ─────────────────────────────────────────────────────────────
async function insertUser(username, passwordHash, playerId) {
  await pool.query(
    'INSERT INTO users (username, password_hash, player_id) VALUES ($1, $2, $3)',
    [username, passwordHash, playerId]
  );
}

async function getUserByUsername(username) {
  const { rows } = await pool.query(
    'SELECT username, password_hash, player_id FROM users WHERE username = $1',
    [username]
  );
  return rows[0] ?? null;
}

module.exports = { insertUser, getUserByUsername };
