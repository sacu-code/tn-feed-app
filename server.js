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

/**
 * Devuelve la mejor cadena de conexión disponible (Neon / Vercel Postgres / fallback).
 * Mantiene un orden de prioridad para minimizar sorpresas en producción.
 * Si ninguna existe, devuelve null y la app caerá al modo en memoria.
 */
function getConnectionString() {
  return (
    process.env.DATABASE_URL ||                        // recomendada: Neon pooler con ?sslmode=require
    process.env.DATABASE_POSTGRES_URL ||               // creada por integraciones
    process.env.DATABASE_URL_UNPOOLED ||               // sin pool
    process.env.DATABASE_POSTGRES_URL_NON_POOLING ||   // sin pool (nombres alternativos)
    process.env.DATABASE_DATABASE_URL_UNPOOLED ||      // sin pool (otra variante)
    null
  );
}

(async () => {
  try {
    const connectionString = getConnectionString();
    if (connectionString) {
      pool = new Pool({
        connectionString,
        ssl: { rejectUnauthorized: false }, // necesario con Neon/pg en serverless
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
  // siempre lo guardamos en memoria para uso inmediato
  storeTokens[storeId] = accessToken;

  if (!pool) return;
  try {
    await pool.query(
      `
      INSERT INTO tokens (store_id, access_token, created_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (store_id)
      DO UPDATE SET access_token = EXCLUDED.access_token,
                    created_at   = NOW()
      `,
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

/* =========================
   Landing (raíz)
   ========================= */

// Landing para Tiendanube (sirve para el modo "Aplicación de Prueba")
app.get('/', (_req, res) => {
  const appUrl = process.env.APP_URL || 'https://tn-feed-app.vercel.app';
  res.type('html').send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Feed XML — SACU Digital</title>
  <style>
    body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial; margin: 2rem; color: #222; }
    .wrap { max-width: 820px; margin: 0 auto; }
    h1 { font-size: 1.6rem; margin: 0 0 .5rem; }
    p { line-height: 1.5; }
    .cta { margin-top: 1rem; display: inline-block; background: #1976d2; color: #fff; text-decoration: none; padding: .6rem 1rem; border-radius: .4rem; }
    .links a { margin-right: 1rem; }
    code { background: #f6f8fa; padding: .15rem .35rem; border-radius: .25rem; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Feed XML para Tiendanube</h1>
    <p>Generá un feed compatible con Google Merchant para tu tienda. Instalá la app y obtené tu enlace de <code>/feed.xml?store_id=…</code>.</p>

    <a class="cta" href="/install">Instalar en mi tienda</a>

    <div class="links" style="margin-top:1rem">
      <a href="/health/db" target="_blank">Health DB</a>
      <a href="/debug/tokens" target="_blank">Tokens</a>
    </div>

    <p style="margin-top:1.5rem; color:#555">
      URL de producción: <code>${appUrl}</code>
    </p>
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
  // Trae productos en páginas de 200
  let page = 1;
  const per_page = 200;
  const all = [];
  while (true) {
    const data = await tnFetch(
      storeId,
      token,
      `/products?page=${page}&per_page=${per_page}`
    );
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < per_page) break;
    page += 1;
  }
  return all;
}

/* =========================
   Rutas: instalación & OAuth
   ========================= */

app.get('/install', (req, res) => {
  const state = Math.random().toString(36).slice(2);
  res.redirect(getInstallUrl(state));
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

    const feedUrl = `${process.env.APP_URL}/feed.xml?store_id=${storeId}`;
    res.send(
      `<h1>¡App instalada correctamente!</h1>
       <p>Ahora podés acceder a tu feed en el siguiente enlace:</p>
       <a href="${feedUrl}">${feedUrl}</a>`
    );
  } catch (err) {
    console.error('[OAuth] Error callback:', err);
    res.status(500).send('Error processing OAuth callback');
  }
});

/* =========================
   Generación del feed XML
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

  const xml = [
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

  return xml;
}

app.get('/feed.xml', async (req, res) => {
  const { store_id } = req.query;
  if (!store_id) return res.status(400).send('Missing store_id');

  try {
    const token = await getToken(store_id);
    if (!token) {
      return res
        .status(401)
        .send('No hay token. Instala la app primero para esta tienda.');
    }

    // Dominio canónico de la tienda (si no lo tenés guardado, usa {store_id}.tiendanube.com)
    const storeDomain = `${store_id}.tiendanube.com`;

    // Traer productos de la API
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
   Debug opcional
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
        return res.json({
          rows: Object.keys(storeTokens).map((s) => ({ store_id: s })),
        });
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
