// server.js
const express = require('express');
const { Pool } = require('pg');
// fetch: usa global (Node 18+) o cae a node-fetch si es necesario (ESM)
const fetch = (...args) => {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch(...args);
  return import('node-fetch').then(({ default: f }) => f(...args));
};

const app = express();

/* =========================
   PostgreSQL: pool & schema
   ========================= */
let pool;
(async () => {
  try {
    if (process.env.DATABASE_URL) {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      });
      await ensureSchema();
      console.log('[DB] Pool inicializado y schema verificado');
    } else {
      console.warn('[DB] Sin DATABASE_URL: se usará almacenamiento en memoria');
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

// Fallback en memoria (mismo proceso)
const storeTokens = Object.create(null);

/** Guarda/actualiza token de la tienda (DB si hay; si no, memoria) */
async function saveToken(storeId, accessToken) {
  storeTokens[storeId] = accessToken; // siempre actualiza memoria (cálido inmediato)

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
   Helpers Tiendanube
   ========================= */
function getInstallUrl(state) {
  const appId = process.env.TN_CLIENT_ID;
  return `https://www.tiendanube.com/apps/${appId}/authorize?state=${state}`;
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
function buildXmlFeed(products, storeDomain) {
  const toStringValue = (value) => {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value === 'object') {
      for (const k in value) {
        const v = value[k];
        if (typeof v === 'string' || typeof v === 'number') return String(v);
      }
      return JSON.stringify(value);
    }
    return String(value);
  };

  const items = products.map((p) => {
    const productId = toStringValue(p.handle) || toStringValue(p.id);
    const imageUrl =
      p.images && p.images.length ? toStringValue(p.images[0].src) : '';
    let price = '0.00 ARS';
    if (p.variants && p.variants.length) {
      price = `${toStringValue(p.variants[0].price)} ARS`;
    }
    const available = p.variants && p.variants.find((v) => v.available);
    const availability = available ? 'in_stock' : 'out_of_stock';
    const title = toStringValue(p.name);
    const description = toStringValue(p.description) || title;
    const brand = toStringValue(p.brand) || 'Media Naranja';
    const handle = toStringValue(p.handle);

    return [
      '    <item>',
      `      <g:id>${productId}</g:id>`,
      `      <g:title><![CDATA[${title}]]></g:title>`,
      `      <g:description><![CDATA[${description}]]></g:description>`,
      `      <g:link>https://${storeDomain}/productos/${handle}</g:link>`,
      `      <g:image_link>${imageUrl}</g:image_link>`,
      `      <g:availability>${availability}</g:availability>`,
      `      <g:price>${price}</g:price>`,
      `      <g:condition>new</g:condition>`,
      `      <g:brand><![CDATA[${brand}]]></g:brand>`,
      `      <g:identifier_exists>false</g:identifier_exists>`,
      '    </item>',
    ].join('\n');
  });

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">`,
    `  <channel>`,
    `    <title>Feed de Productos Tiendanube</title>`,
    `    <link>https://${storeDomain}</link>`,
    `    <description>Feed generado desde la API de Tiendanube</description>`,
    items.join('\n'),
    `  </channel>`,
    `</rss>`,
  ].join('\n');
}

app.get('/feed.xml', async (req, res) => {
  const { store_id } = req.query;
  if (!store_id) return res.status(400).send('Missing store_id');

  const accessToken = await getToken(String(store_id));
  if (!accessToken) {
    return res.status(401).send('Store not authorized. Please install the app first.');
  }

  try {
    const apiVersion = process.env.API_VERSION || 'v1';
    const url = `https://api.tiendanube.com/${apiVersion}/${store_id}/products`;

    const resp = await fetch(url, {
      headers: {
        Authentication: `bearer ${accessToken}`, // Tiendanube usa "Authentication"
        'User-Agent': 'TN Feed App (sacudigital@gmail.com)',
        Accept: 'application/json',
      },
    });

    const products = await resp.json();
    if (!Array.isArray(products)) {
      console.error('[Feed] Respuesta inesperada de productos:', products);
      return res.status(500).send('Error fetching products');
    }

    let storeDomain = '';
    if (products.length && products[0].permalink) {
      try {
        storeDomain = new URL(products[0].permalink).hostname;
      } catch {
        storeDomain = `${store_id}.tiendanube.com`;
      }
    } else {
      storeDomain = `${store_id}.tiendanube.com`;
    }

    const xml = buildXmlFeed(products, storeDomain);
    res.set('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err) {
    console.error('[Feed] Error generando feed:', err);
    res.status(500).send('Error generating feed');
  }
});

/* =========================
   Endpoints de debug (opc.)
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
      if (!pool) return res.json({ rows: Object.keys(storeTokens).map(s => ({ store_id: s })) });
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
