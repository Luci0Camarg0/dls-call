// Banco de dados do DLS Call.
// Na internet usa o Postgres do Neon (variável DATABASE_URL).
// No seu PC, sem DATABASE_URL, usa um Postgres embutido (PGlite) salvo na pasta data/.

const path = require('path');

const SCHEMA = `
create table if not exists users (
  id text primary key,
  username text unique not null,
  display_name text not null,
  pass_hash text not null,
  avatar text,
  banner text,
  banner_color text,
  prefs jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table if not exists sessions (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists servers (
  id text primary key,
  name text not null,
  icon text,
  invite text unique not null,
  owner_id text,
  created_at timestamptz not null default now()
);
create table if not exists members (
  server_id text not null references servers(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (server_id, user_id)
);
create index if not exists members_user on members(user_id);
create table if not exists messages (
  id bigserial primary key,
  server_id text not null references servers(id) on delete cascade,
  user_id text references users(id) on delete set null,
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_server on messages(server_id, id desc);
create table if not exists sounds (
  id text primary key,
  server_id text not null references servers(id) on delete cascade,
  name text not null,
  file text not null,
  duration real,
  created_by text,
  created_at timestamptz not null default now()
);
create table if not exists files (
  id text primary key,
  mime text not null,
  size integer not null,
  data bytea not null,
  owner_id text,
  created_at timestamptz not null default now()
);
`;

let client = null;

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000 });
    pool.on('error', (e) => console.warn('[db] erro de conexão:', e.message));
    client = { query: (sql, params) => pool.query(sql, params), exec: (sql) => pool.query(sql) };
    console.log('[db] usando Postgres (DATABASE_URL)');
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
    const db = new PGlite(dir);
    client = { query: (sql, params) => db.query(sql, params), exec: (sql) => db.exec(sql) };
    console.warn(`[db] DATABASE_URL não definido; usando banco local em ${dir} (só para testes)`);
  }
  await client.exec(SCHEMA);
}

async function q(sql, params = []) {
  const r = await client.query(sql, params);
  return r.rows;
}

async function one(sql, params = []) {
  return (await q(sql, params))[0] || null;
}

module.exports = { init, q, one };
