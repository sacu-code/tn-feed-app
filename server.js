const express = require('express');
const { Pool } = require('pg');

const fetch = (...args) => {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch(...args);
  return import('node-fetch').then(({ default: f }) => f(...args));
};

const app = express();

/* ========== DB setup ========== */
let pool;
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
  const connectionString = getConnectionString();
  if (connectionString) {
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tokens (
        id SERIAL PRIMARY KEY,
        store_id TEXT UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_store_id ON tokens(store_id);
    `);
    console.log('[DB] Base de datos inicializada.');
  } else {
    console.warn('[DB] Sin cadena de conexión; se usará almacenamiento en memoria.');
  }
})();
const storeTokens = Object.create(null);
async function saveToken(storeId, accessToken) {
  storeTokens[storeId] = accessToken;
  if (!pool) return;
  await pool.query(
    `INSERT INTO tokens (store_id, access_token, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (store_id)
     DO UPDATE SET access_token = EXCLUDED.access_token,
                   created_at   = NOW()`,
    [storeId, accessToken]
  );
}
async function getToken(storeId) {
  if (pool) {
    const { rows } = await pool.query(
      'SELECT access_token FROM tokens WHERE store_id = $1 LIMIT 1',
      [storeId]
    );
    if (rows.length) return rows[0].access_token;
  }
  return storeTokens[storeId] || null;
}
async function hasToken(storeId) {
  if (!storeId) return false;
  if (pool) {
    const { rows } = await pool.query(
      'SELECT 1 FROM tokens WHERE store_id = $1 LIMIT 1',
      [storeId]
    );
    return rows.length > 0;
  }
  return !!storeTokens[storeId];
}

/* ========== Middleware para permitir iframes ========== */
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  next();
});

/* ========== Landing con botón naranja ========== */
app.get('/', (_req, res) => {
  const appUrl = process.env.APP_URL || 'https://tn-feed-app.vercel.app';
  res.type('html').send(`
    <!doctype html>
    <html lang="es">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>XML Nube by Sacu Partner Tecnológico Tiendanube</title>
      <style>
        body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial; margin: 2rem; color: #222; }
        .wrap { max-width: 880px; margin: 0 auto; }
        h1 { font-size: 1.6rem; font-weight: 700; margin-bottom: .5rem; }
        p  { line-height: 1.55; color:#444; margin:.35rem 0; }
        .cta {
          margin-top: 1.25rem; display: inline-block;
          background: #ff6f3d; color: #fff; text-decoration: none;
          padding: .70rem 1.15rem; border-radius: 28px;
          box-shadow: 0 2px 8px rgba(0,0,0,.12);
          transition: transform .05s ease, filter .15s ease;
        }
        .cta:hover { filter: brightness(1.05); }
        .cta:active { transform: translateY(1px); }
        .card {
          margin-top: 1.25rem; padding: 1rem; border: 1px solid #e5e7eb;
          border-radius: .5rem; background:#fafafa;
        }
        input[type="text"] { padding:.55rem .6rem; border:1px solid #d1d5db; border-radius:.4rem; width: 320px; }
        button[type="submit"] { margin-left:.5rem; padding:.55rem .8rem; border:0; background:#374151; color:#fff; border-radius:.4rem; }
        small code { background:#f6f8fa; padding:.15rem .35rem; border-radius:.25rem; }
      </style>
    </head>
    <body>
      <div class="wrap">
        <h1>XML Nube by Sacu Partner Tecnológico Tiendanube</h1>
        <p>Generá un feed compatible con Google Merchant. Instalá la app y luego accedé a tu enlace <small><code>/feed.xml?store_id=…</code></small>.</p>
        <a class="cta" href="/admin/apps/19066/authorize/" target="_top">Instalar en mi tienda</a>
        <div class="card">
          <form action="/dashboard" method="get">
            <label for="store_id"><strong>Ver mi feed:</strong></label><br/>
            <input id="store_id" name="store_id" type="text" placeholder="Ingresá tu store_id" required />
            <button type="submit">Ir al panel</button>
          </form>
          <p style="margin-top:.6rem;color:#555">URL de producción: <code>${appUrl}</code></p>
        </div>
      </div>
    </body>
    </html>
  `);
});

/* ========== Dashboard por tienda ========== */
app.get('/dashboard', async (req, res) => {
  const { store_id } = req.query || {};
  const appUrl  = process.env.APP_URL || 'https://tn-feed-app.vercel.app';
  const feedUrl = store_id ? `${appUrl}/feed.xml?store_id=${store_id}` : '';
  const has = await hasToken(store_id);
  res.type('html').send(`
    <!doctype html>
    <html lang="es">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>Mi Catálogo — XML Nube</title>
      <style>
        body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial; margin: 2rem; color:#222; }
        .wrap { max-width: 880px; margin: 0 auto; }
        .badge { font-size:.78rem; padding:.2rem .45rem; border-radius:.4rem; margin-left:.35rem; }
        .ok   { background:#e9f7ef; color:#1b5e20; border:1px solid #c8e6c9; }
        .warn { background:#fff3cd; color:#7c4a03; border:1px solid #ffecb5; }
        .box  { border:1px solid #e5e7eb; border-radius:.5rem; padding:1rem; margin-top:1rem; background:#fafafa; }
        .row  { display:flex; gap:.5rem; margin-top:.5rem; }
        input[type="text"] { width:100%; padding:.55rem .6rem; border:1px solid #d1d5db; border-radius:.4rem; }
        .btn  { padding:.55rem .8rem; border:0; border-radius:.4rem; background:#ff6f3d; color:#fff; }
        .btn.darker { background:#374151; }
        .muted { color:#666; }
      </style>
    </head>
    <body>
      <div class="wrap">
        <h2>Conectar a Tiendanube ${has ? '<span class="badge ok">Autenticado</span>' : '<span class="badge warn">Falta instalar</span>'}</h2>
        <p class="muted">Estado de la conexión con tu tienda.</p>
        <div class="box">
          <h3>Catálogo ${has ? '<span class="badge ok">Catálogo encontrado</span>' : ''}</h3>
          ${store_id ? `
            <label for="url"><small>Copiá tu URL de catálogo:</small></label>
            <div class="row">
              <input id="url" type="text" readonly value="${feedUrl}" />
              <button class="btn" onclick="navigator.clipboard.writeText('${feedUrl}').then(()=>alert('Enlace copiado'))">Copiar</button>
              <a class="btn darker" href="${feedUrl}" target="_blank">Abrir</a>
            </div>
            <p class="muted" style="margin-top:.5rem;">Este enlace es el que debés pegar en Google Merchant u otros destinos.</p>
          ` : `
            <p>Ingresá desde la <a href="/">landing</a> tu <code>store_id</code> o instalá la app.</p>
          `}
          ${!has ? `
            <p style="margin-top:1rem;">
              <a class="btn" href="/admin/apps/19066/authorize/" target="_top">Instalar en mi tienda</a>
            </p>
          ` : ''}
        </div>
      </div>
    </body>
    </html>
  `);
});

/* ========== Ayudantes API Tiendanube ========== */
function getInstallUrl(state) {
  const appId = process.env.TN_CLIENT_ID;
  return `https://www.tiendanube.com/apps/${appId}/authorize?state=${state}`;
}
async function tnFetch(storeId, token, path) {
  const base = `https://api.tiendanube.com/v1/${storeId}`;
  const url  = `${base}${path}`;
  const ua   = process.env.TN_USER_AGENT || 'tn-feed-app (no-email@domain)';
  const res  = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': ua,
      'Authentication': `bearer ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tiendanube API ${res.status} ${res.statusText} – ${text}`);
  }
  return res.json();
}
async function fetchAllProducts(storeId, token) {
  let page = 1;
  const per_page = 200;
  const all = [];
  while (true) {
    const data = await tnFetch(storeId, token, `/products?page=${page}&per_page=${per_page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < per_page) break;
    page += 1;
  }
  return all;
}

/* ========== Instalación y OAuth ========== */
app.get('/install', (_req, res) => {
  res.redirect('/admin/apps/19066/authorize/');
});
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');
  try {
    const resp = await fetch('https://www.tiendanube.com/apps/authorize/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.TN_CLIENT_ID,
        client_secret: process.env.TN_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.access_token || !data.user_id) {
      console.error('[OAuth] Respuesta inválida:', data);
      return res.status(500).send('Error al obtener access_token');
    }
    const storeId = String(data.user_id);
    await saveToken(storeId, data.access_token);
    res.redirect(`/dashboard?store_id=${storeId}`);
  } catch (err) {
    console.error('[OAuth] Error callback:', err);
    res.status(500).send('Error processing OAuth callback');
  }
});

/* ========== Feed XML ========== */
function buildXmlFeed(products, storeDomain) {
  const items = products.map((p) => {
  ...
  });
  // (Función completa igual que antes)
}
app.get('/feed.xml', async (req, res) => {
  // (Función completa igual que antes)
});

/* ========== Debug opcional ========== */
if (process.env.DEBUG === 'true') {
  // /health/db y /debug/tokens
}

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
module.exports = app;
