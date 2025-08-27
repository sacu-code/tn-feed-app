// server.js
const express = require('express');
const { Pool } = require('pg');

// --- fetch (Node 18+ trae global fetch; en otras versiones cae a node-fetch)
const fetch = (...args) => {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch(...args);
  return import('node-fetch').then(({ default: f }) => f(...args));
};

const app = express();

/* =========================
   PostgreSQL: pool & schema
   ========================= */

let pool;

// En producción usá solo DATABASE_URL (Neon)
function getConnectionString() {
  if (process.env.NODE_ENV === 'production') {
    return process.env.DATABASE_URL || null;
  }
  return (
    process.env.DATABASE_URL ||
    process.env.DATABASE_POSTGRES_URL ||
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_POSTGRES_URL_NON_POOLING ||
    process.env.DATABASE_DATABASE_URL_UNPOOLED ||
    null
  );
}

(async () => {
  try {
    const connectionString = getConnectionString();
    if (connectionString) {
      pool = new Pool({
        connectionString,
        ssl: { rejectUnauthorized: false },
      });
      await ensureSchema();
      console.log('[DB] Pool inicializado y schema verificado');
    } else {
      console.warn('[DB] Sin cadena de conexión: se usará almacenamiento en memoria');
    }
  } catch (err) {
    console.warn('[DB] No se pudo inicializar la base de datos', err);
    pool = undefined;
  }
})();

/** Crea tabla tokens si no existe */
async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      id SERIAL PRIMARY KEY,
      store_id TEXT UNIQUE NOT NULL,
      access_token TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_store_id ON tokens(store_id);
  `);
}

// Fallback en memoria (mientras no haya DB)
const storeTokens = Object.create(null);

async function saveToken(storeId, accessToken) {
  storeTokens[storeId] = accessToken; // uso inmediato
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO tokens (store_id, access_token, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (store_id)
       DO UPDATE SET access_token = EXCLUDED.access_token,
                     created_at   = NOW()`,
      [storeId, accessToken]
    );
    console.log([DB] Token guardado para store_id=${storeId});
  } catch (err) {
    console.error('[DB] ERROR guardando token:', err);
  }
}

async function getToken(storeId) {
  if (pool) {
    try {
      const { rows } = await pool.query(
        'SELECT access_token FROM tokens WHERE store_id = $1 LIMIT 1',
        [storeId]
      );
      if (rows.length) return rows[0].access_token;
    } catch (err) {
      console.error('[DB] ERROR leyendo token:', err);
    }
  }
  return storeTokens[storeId] || null;
}

async function hasToken(storeId) {
  if (!storeId) return false;
  if (pool) {
    try {
      const { rows } = await pool.query('SELECT 1 FROM tokens WHERE store_id = $1 LIMIT 1', [storeId]);
      return rows.length > 0;
    } catch (e) {
      console.error('[DB] hasToken error:', e);
    }
  }
  return !!storeTokens[storeId];
}

/* =========================
   Helper Tiendanube
   ========================= */
function getInstallUrl(state) {
  const appId = process.env.TN_CLIENT_ID;
  return https://www.tiendanube.com/apps/${appId}/authorize?state=${state};
}

/* =========================
   Landing (título + botón naranja + formulario)
   ========================= */
app.get('/', (_req, res) => {
  const appUrl = process.env.APP_URL || 'https://tn-feed-app.vercel.app';
  res.type('html').send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>XML Nube by Sacu Partner Tecnológico Tiendanube</title>
  <style>
    body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial; margin: 2rem; color: #222; }
    .wrap { max-width: 880px; margin: 0 auto; }
    h1 { font-size: 1.6rem; margin: 0 0 .5rem; font-weight: 700; }
    p  { line-height: 1.55; color:#444; margin:.35rem 0; }
    .cta {
      margin-top: 1.25rem; display: inline-block;
      background: #ff6f3d; color: #fff; text-decoration: none;
      padding: .70rem 1.15rem; border-radius: 28px;
      box-shadow: 0 2px 8px rgba(0,0,0,.12);
      transition: transform .05s ease, filter .15s ease;
    }
    .cta:hover { filter: brightness(1.05); }
    .cta:active {
