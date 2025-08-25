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

// Devuelve la mejor cadena de conexión disponible (Neon / Vercel Postgres / fallback)
function getConnectionString() {
  // En producción usa solo DATABASE_URL
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

/** Guarda/actualiza token (DB si hay; si no, memoria) */
async function saveToken(storeId, accessToken) {
  storeTokens[storeId] = accessToken;
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
    console.log(`[DB] Token guardado para store_id=${storeId}`);
  } catch (err) {
    console.error('[DB] ERROR guardando token:', err);
  }
}

/** Obtiene token por store_id (prefiere DB; si falla, memoria) */
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

/** Chequea si hay token persistido */
async function hasToken(storeId) {
  if (!storeId) return false;
  if (pool) {
    try {
      const { rows } = await pool.query(
        'SELECT 1 FROM tokens WHERE store_id = $1 LIMIT 1',
        [storeId]
      );
      return rows.length > 0;
    } catch (e) {
      console.error('[DB] hasToken error:', e);
    }
  }
  return !!storeTokens[storeId];
}

/* =========================
   Config de marca (colores / logo)
   ========================= */
const BRAND_PRIMARY = process.env.BRAND_PRIMARY || '#0f6fff'; // podés setear color de tu web
const BRAND_ACCENT  = process.env.BRAND_ACCENT  || '#00b2ff';
const LOGO_URL      = process.env.LOGO_URL      || 'https://www.sacudigital.com/apps-sacu/feedxml/logo.png';

/* =========================
   Landing minimal (instalar + ir al panel)
   ========================= */
app.get('/', (_req, res) => {
  const appUrl = process.env.APP_URL || 'https://tn-feed-app.vercel.app';
  res.type('html').send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Feed XML — SACU Digital</title>
  <style>
    :root { --brand:${BRAND_PRIMARY}; --accent:${BRAND_ACCENT}; color-scheme: light dark; }
    body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial; margin: 2rem; color: #222; }
    .wrap { max-width: 880px; margin: 0 auto; }
    header { display:flex; align-items:center; gap:.75rem; margin-bottom:1rem; }
    header img { height: 38px; }
    h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
    p { line-height: 1.55; color:#444; margin:.25rem 0; }
    .cta { margin-top: 1rem; display: inline-block; background: var(--brand); color: #fff;
           text-decoration: none; padding: .65rem 1rem; border-radius: .5rem; }
    .card { margin-top: 1.25rem; padding: 1rem; border: 1px solid #e5e7eb; border-radius: .5rem; background:#fafafa }
    input[type="text"] { padding:.55rem .6rem; border:1px solid #d1d5db; border-radius:.4rem; width: 320px; }
    button[type="submit"] { margin-left:.5rem; padding:.55rem .8rem; border:0; background:#374151; color:#fff; border-radius:.4rem; }
    small code { background: #f6f8fa; padding: .15rem .35rem; border-radius: .25rem; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <img src="${LOGO_URL}" alt="SACU Digital" />
      <div>
        <h1>Feed XML para Tiendanube</h1>
        <p>Generá un feed compatible con Google Merchant. Instalá la app y luego accedé a tu enlace <small><code>/feed.xml?store_id=…</code></small>.</p>
      </div>
    </header>

    <!-- IMPORTANTE: target _top rompe el iframe de Tiendanube -->
    <a class="cta" href="/admin/apps/19066/authorize/" target="_top">Instalar en mi tienda</a>

    <div class="card">
      <form action="/dashboard" method="get">
        <label for="store_id"><strong>Ver mi feed:</strong></label><br/>
        <input id="store_id" name="store_id" type="text" placeholder="Ingresá tu store_id" required />
        <button type="submit">Ir al panel</button>
      </form>
      <p style="margin:.6rem 0 0;color:#555">
        URL de producción: <code>${appUrl}</code>
      </p>
    </div>
  </div>
</body>
</html>`);
});

/* =========================
   Panel por tienda (muestra link listo para copiar)
   ========================= */
app.get('/dashboard', async (req, res) => {
  const { store_id } = req.query || {};
  const appUrl = process.env.APP_URL || 'https://tn-feed-app.vercel.app';
  const feedUrl = store_id ? `${appUrl}/feed.xml?store_id=${store_id}` : '';
  const has = await hasToken(store_id);

  res.type('html').send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Mi Catálogo — Feed XML</title>
  <style>
    :root { --brand:${BRAND_PRIMARY}; --accent:${BRAND_ACCENT}; }
    body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial; margin: 2rem; color: #222; }
    .wrap { max-width: 880px; margin: 0 auto; }
    .badge { font-size:.78rem; padding:.2rem .45rem; border-radius:.4rem; margin-left:.35rem }
    .ok { background:#e9f7ef; color:#1b5e20; border:1px solid #c8e6c9 }
    .warn { background:#fff3cd; color:#7c4a03; border:1px solid #ffecb5 }
    input[type="text"] { width: 100%; padding:.55rem .6rem; border:1px solid #d1d5db; border-radius:.4rem; }
    .row { display:flex; gap:.5rem; margin-top:.5rem }
    .btn { padding:.55rem .8rem; border:0; border-radius:.4rem; background:var(--brand); color:#fff; }
    .muted { color:#666 }
    .box { border:1px solid #e5e7eb; border-radius:.5rem; padding:1rem; margin-top:1rem; background:#fafafa }
    a { color:var(--brand); text-decoration:none }
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
          <a class="btn" href="${feedUrl}" target="_blank" style="background:#374151">Abrir</a>
        </div>
        <p class="muted" style="margin-top:.5rem">Este enlace es el que debés pegar en Google Merchant u otros destinos.</p>
      ` : `
        <p>Ingresá desde la <a href="/">landing</a> tu <code>store_id</code> o instalá la app.</p>
      `}
      ${!has ? `
        <p style="margin-top:1rem">
          <a class="btn" href="/admin/apps/19066/authorize/" target="_top">Instalar en mi tienda</a>
        </p>` : ''}
    </div>
  </div>
</body>
</html>`);
});

/* =========================
   Helpers Tiendanube
   ========================= */

function getInstallUrl(state) {
  const appId = process.env.TN_CLIENT_ID;
  return `https://www.tiendanube.com/apps/${appId}/authorize?state=${state}`;
}

// --- API de Tiendanube
async function tnFetch(storeId, token, path) {
  const base = `https://api.tiendanube.com/v1/${storeId}`;
  const url = `${base}${path}`;
  const ua = process.env.TN_USER_AGENT || 'tn-feed-app (no-email@domain)';
  const res = await fetch(url, {
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

/* =========================
   OAuth callback (igual que tu versión, pero redirige a dashboard)
   ========================= */

app.get('/install', (req, res) => {
  // si alguien entra directo desde fuera del admin
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
        client_id: process.env.TN_CLIENT_ID,
        client_secret: process.env.TN_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error('[OAuth] Error intercambiando code:', data);
      return res.status(500).send('Failed to obtain access token');
    }
    const { access_token, user_id } = data;
    if (!access_token || !user_id) {
      console.error('[OAuth] Respuesta inválida:', data);
      return res.status(500).send('Invalid token response from Tiendanube');
    }
    const storeId = String(user_id);
    await saveToken(storeId, access_token);
    res.redirect(`/dashboard?store_id=${storeId}`);
  } catch (err) {
    console.error('[OAuth] Error callback:', err);
    res.status(500).send('Error processing OAuth callback');
  }
});

/* =========================
   Generación del feed XML (idéntico)
   ========================= */

function toStringValue(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function buildXmlFeed(products, storeDomain) {
  const items = products.map((p) => {
    const productId = toStringValue(p.handle || p.id);
    const title = toStringValue(p.name);
    const description = toStringValue(p.description) || title;
    const handle = toStringValue(p.handle || '');
    const link = `https://${storeDomain}/productos/${handle}/?utm_source=xml`;
    const imageUrl =
      Array.isArray(p.images) && p.images.length > 0
        ? toStringValue(p.images[0].src || p.images[0].url || '')
        : '';
    let price = '0.00 ARS';
    if (Array.isArray(p.variants) && p.variants.length > 0) {
      price = `${toStringValue(p.variants[0].price)} ARS`;
    }
    const availability =
      Array.isArray(p.variants) && p.variants.find((v) => v.available)
        ? 'in_stock'
        : 'out_of_stock';
    const brand =
      p.brand && (p.brand.name || p.brand)
        ? toStringValue(p.brand.name || p.brand)
        : 'Media Naranja';
    return [
      '  <item>',
      `    <g:id>${productId}</g:id>`,
      `    <g:title><![CDATA[${title}]]></g:title>`,
      `    <g:description><![CDATA[${description}]]></g:description>`,
      `    <g:link>${link}</g:link>`,
      `    <g:image_link>${imageUrl}</g:image_link>`,
      `    <g:availability>${availability}</g:availability>`,
      `    <g:price>${price}</g:price>`,
      '    <g:condition>new</g:condition>',
      `    <g:brand><![CDATA[${brand}]]></g:brand>`,
      '    <g:identifier_exists>false</g:identifier_exists>',
      '  </item>',
    ].join('\n');
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">`,
    `<channel>`,
    `  <title>Feed de Productos Tiendanube</title>`,
    `  <link>https://${storeDomain}/</link>`,
    `  <description>Feed generado desde la API de Tiendanube</description>`,
    items.join('\n'),
    `</channel>`,
    `</rss>`,
  ].join('\n');
}

app.get('/feed.xml', async (req, res) => {
  const { store_id } = req.query;
  if (!store_id) return res.status(400).send('Missing store_id');
  try {
    const token = await getToken(store_id);
    if (!token) {
      return res.status(401).send('No hay token. Instala la app primero para esta tienda.');
    }
    const storeDomain = `${store_id}.tiendanube.com`;
    const products = await fetchAllProducts(store_id, token);
    const xml = buildXmlFeed(products, storeDomain);
    res.setHeader('Content-Type', 'text/xml; charset=utf-8');
    res.send(xml);
  } catch (err) {
    console.error('[Feed] Error generando feed:', err);
    res.status(500).send('Error generating feed');
  }
});

/* =========================
   Debug opcional (sólo si DEBUG=true)
   ========================= */
if (process.env.DEBUG === 'true') {
  app.get('/health/db', async (_req, res) => {
    try {
      if (!pool) return res.json({ ok: false, reason: 'no-pool' });
      const c = await pool.connect();
      await c.query('SELECT 1');
      c.release();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/debug/tokens', async (_req, res) => {
    try {
      if (!pool)
        return res.json({ rows: Object.keys(storeTokens).map((s) => ({ store_id: s })) });
      const { rows } = await pool.query(
        'SELECT store_id, created_at FROM tokens ORDER BY created_at DESC LIMIT 50'
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

/* =========================
   Arranque local / export
   ========================= */
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
module.exports = app;
