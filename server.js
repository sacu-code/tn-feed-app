// server.js
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

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

/**
 * Elimina el token de una tienda (memoria + DB). Usado en app/uninstalled.
 */
async function deleteToken(storeId) {
  delete storeTokens[storeId];
  if (!pool) return;
  try {
    await pool.query('DELETE FROM tokens WHERE store_id = $1', [storeId]);
    console.log(`[DB] Token eliminado para store_id=${storeId}`);
  } catch (err) {
    console.error('[DB] ERROR eliminando token:', err);
  }
}

/* =========================
   Config de marca (colores / logo)
   ========================= */
const BRAND_PRIMARY = process.env.BRAND_PRIMARY || '#0f6fff';
const BRAND_ACCENT  = process.env.BRAND_ACCENT  || '#00b2ff';
const LOGO_URL      = process.env.LOGO_URL      || 'https://www.sacudigital.com/apps-sacu/feedxml/logo.png';

/* =========================
   Helpers Tiendanube
   ========================= */

// Genera la URL de instalación en Tiendanube usando TN_CLIENT_ID.
function getInstallUrl(state = '') {
  const appId = process.env.TN_CLIENT_ID;
  const baseUrl = `https://www.tiendanube.com/apps/${appId}/authorize`;
  return state ? `${baseUrl}?state=${state}` : baseUrl;
}

// Construye la URL de la API OAuth de Tiendanube
function getTokenExchangeUrl() {
  return 'https://www.tiendanube.com/apps/authorize/token';
}

// --- NUEVO: normalización robusta (EVITA [object Object])
function normalizeDomain(val) {
  if (!val) return null;

  if (typeof val === 'string') {
    return val.trim().replace(/^https?:\/\//i, '').replace(/\/+$/g, '');
  }
  if (typeof val === 'number') return String(val);

  // objeto típico: { domain: "..."} o { url: "https://..."} o { es: "..."} etc.
  if (typeof val === 'object') {
    if (val.domain) return normalizeDomain(val.domain);
    if (val.url) return normalizeDomain(val.url);
    if (val.name) return normalizeDomain(val.name);
    if (val.host) return normalizeDomain(val.host);
    if (val.es) return normalizeDomain(val.es);

    // último recurso: evitar [object Object]
    const s = String(val);
    if (s === '[object Object]') return null;
    return normalizeDomain(s);
  }
  return null;
}

function isLikelyHost(h) {
  if (!h) return false;
  // host simple (sin protocolo)
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(h);
}

function pickBestDomain(domains) {
  const list = (domains || [])
    .map(normalizeDomain)
    .filter(Boolean);

  if (!list.length) return null;

  // preferir custom (no *.tiendanube.com)
  const custom = list.find(d => !/\.tiendanube\.com$/i.test(d));
  return custom || list[0];
}

// override por query o por env DOMAINS_MAP="6467092:vertexretail.com.ar,2307236:los-locos.com"
function resolveDomainOverrides(req, storeId) {
  const q = normalizeDomain(req.query.domain);
  if (q && isLikelyHost(q) && !/\.tiendanube\.com$/i.test(q)) return q;

  const mapStr = process.env.DOMAINS_MAP || '';
  if (mapStr) {
    const pairs = mapStr.split(',').map(s => s.trim()).filter(Boolean);
    const hit = pairs.find(p => p.startsWith(String(storeId) + ':'));
    if (hit) {
      const val = hit.split(':').slice(1).join(':'); // por si el dominio trae ":" raro
      const host = normalizeDomain(val);
      if (host && isLikelyHost(host)) return host;
    }
  }
  return null;
}

// Función para construir enlaces de productos (blindada)
function productLink(storeDomain, handle) {
  const host = normalizeDomain(storeDomain) || 'invalid-domain';
  return `https://${host}/productos/${handle}/?utm_source=xml`;
}

/* =========================
   API Tiendanube: fetch helpers
   ========================= */

// Petición autenticada a la API de Tiendanube
async function tnFetch(storeId, token, path) {
  // Nota: si usás la versión 2025-03, cambiá a /2025-03/{store_id}
  const base = `https://api.tiendanube.com/v1/${storeId}`;
  const url = `${base}${path}`;
  const ua = process.env.TN_USER_AGENT || 'feed-xml-by-sacu (contacto@sacudigital.com)';
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': ua,
      'Authentication': `bearer ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Tiendanube API ${res.status} ${res.statusText} – ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Pagina productos
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
   Dominio público (sin romper por scopes)
   Orden: query -> DOMAINS_MAP -> /domains -> /store -> fallback
   ========================= */

async function getPublicDomain(req, storeId, token) {
  // 1) overrides (query / env)
  const override = resolveDomainOverrides(req, storeId);
  if (override) return override;

  // 2) /domains (si hay permiso)
  try {
    const arr = await tnFetch(storeId, token, '/domains');
    // puede venir como [{domain:"..."}, ...] o strings
    const domains = Array.isArray(arr) ? arr.map(d => normalizeDomain(d?.domain ?? d)) : [];
    const pick = pickBestDomain(domains);
    if (pick) return pick;
  } catch (e) {
    // 403/401/404: ignorar y seguir a /store
  }

  // 3) /store (si existe/permiso)
  try {
    const store = await tnFetch(storeId, token, '/store');
    // distintas formas posibles
    const domainsFromStore =
      Array.isArray(store?.domains) ? store.domains :
      Array.isArray(store?.domain) ? store.domain :
      null;

    const pick =
      pickBestDomain(domainsFromStore) ||
      normalizeDomain(store?.original_domain) ||
      normalizeDomain(store?.store_domain);

    if (pick && isLikelyHost(pick)) return pick;
  } catch (e) {
    // ignorar
  }

  // 4) fallback
  return `${storeId}.tiendanube.com`;
}

/* =========================
   Parseo simple de cookies
   ========================= */
function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((acc, part) => {
    const [name, ...rest] = part.trim().split('=');
    acc[name] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

/* =========================
   Landing + Auto-redirect si hay cookie/token
   ========================= */
app.get('/', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sid = req.query.store_id || cookies.store_id;

  if (sid && await hasToken(sid)) {
    return res.redirect(`/dashboard?store_id=${sid}`);
  }

  const appUrl = process.env.APP_URL || 'https://tn-feed-app.vercel.app';
  const installUrl = getInstallUrl();
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
    .cta { margin-top: 1.25rem; display:inline-block; background:#ff6f3d; color:#fff; text-decoration:none; padding:.70rem 1.15rem; border-radius:28px; box-shadow:0 2px 8px rgba(0,0,0,.12); transition:transform .05s ease, filter .15s ease; }
    .cta:hover { filter: brightness(1.05); } .cta:active { transform: translateY(1px); }
    .card { margin-top:1.25rem; padding:1rem; border:1px solid #e5e7eb; border-radius:.5rem; background:#fafafa }
    input[type="text"] { padding:.55rem .6rem; border:1px solid #d1d5db; border-radius:.4rem; width:320px; }
    button[type="submit"] { margin-left:.5rem; padding:.55rem .8rem; border:0; background:#374151; color:#fff; border-radius:.4rem; }
    small code { background:#f6f8fa; padding:.15rem .35rem; border-radius:.25rem; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>XML Nube by Sacu Partner Tecnológico Tiendanube</h1>
    <p>Generá un feed compatible con Google Merchant. Instalá la app y luego accedé a tu enlace <small><code>/feed.xml?store_id=…</code></small>.</p>
    <!-- IMPORTANTE: target _top para romper el iframe de Tiendanube -->
    <a class="cta" href="${installUrl}" target="_top">Instalar en mi tienda</a>
    <div class="card">
      <form action="/dashboard" method="get">
        <label for="store_id"><strong>Ver mi feed:</strong></label><br/>
        <input id="store_id" name="store_id" type="text" placeholder="Ingresá tu store_id numérico" required />
        <button type="submit">Ir al panel</button>
      </form>
      <p style="margin:.6rem 0 0;color:#555">URL de producción: <code>${appUrl}</code></p>
    </div>
  </div>
</body>
</html>`);
});

/* =========================
   Panel por tienda
   ========================= */
app.get('/dashboard', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const store_id = req.query.store_id || cookies.store_id;
  if (!store_id) return res.redirect('/');

  const appUrl = process.env.APP_URL || 'https://tn-feed-app.vercel.app';
  const feedUrl = `${appUrl}/feed.xml?store_id=${store_id}`;
  const has = await hasToken(store_id);
  const installUrl = getInstallUrl();

  res.type('html').send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Mi Catálogo — Feed XML</title>
  <style>
    :root { --brand:${BRAND_PRIMARY}; --accent:${BRAND_ACCENT}; }
    body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial; margin:2rem; color:#222; }
    .wrap { max-width:880px; margin:0 auto; }
    .badge { font-size:.78rem; padding:.2rem .45rem; border-radius:.4rem; margin-left:.35rem }
    .ok { background:#e9f7ef; color:#1b5e20; border:1px solid #c8e6c9 }
    .warn { background:#fff3cd; color:#7c4a03; border:1px solid #ffecb5 }
    input[type="text"] { width:100%; padding:.55rem .6rem; border:1px solid #d1d5db; border-radius:.4rem; }
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
      ${has ? `
        <label for="url"><small>Copiá tu URL de catálogo:</small></label>
        <div class="row">
          <input id="url" type="text" readonly value="${feedUrl}" />
          <button class="btn" onclick="navigator.clipboard.writeText('${feedUrl}').then(()=>alert('Enlace copiado'))">Copiar</button>
          <a class="btn" href="${feedUrl}" target="_blank" style="background:#374151">Abrir</a>
        </div>
        <p class="muted" style="margin-top:.5rem">Este enlace es el que pegás en Google Merchant u otros destinos.</p>
      ` : `
        <p>Ingresá desde la <a href="/">landing</a> tu <code>store_id</code> o instalá la app.</p>
        <p style="margin-top:1rem">
          <a class="btn" href="${installUrl}" target="_top">Instalar en mi tienda</a>
        </p>
      `}
    </div>
  </div>
</body>
</html>`);
});

/* =========================
   OAuth callback: guarda token, setea cookie y registra webhook
   ========================= */
app.get('/install', (req, res) => {
  // si alguien entra directo desde fuera del admin
  res.redirect(getInstallUrl());
});

app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');
  try {
    const resp = await fetch(getTokenExchangeUrl(), {
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

    // Setea cookie store_id válida en iframe: SameSite=None; Secure
    const maxAge = 60 * 60 * 24 * 30; // 30 días
    res.setHeader(
      'Set-Cookie',
      `store_id=${storeId}; Path=/; Max-Age=${maxAge}; SameSite=None; Secure`
    );

    // Registrar webhook app/uninstalled
    try {
      const webhookUrl = `${process.env.APP_URL || 'https://tn-feed-app.vercel.app'}/webhook`;
      const ua = process.env.TN_USER_AGENT || 'feed-xml-by-sacu (contacto@sacudigital.com)';
      const whResp = await fetch(`https://api.tiendanube.com/v1/${storeId}/webhooks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': ua,
          'Authentication': `bearer ${access_token}`,
        },
        body: JSON.stringify({ event: 'app/uninstalled', url: webhookUrl }),
      });
      const whData = await whResp.json().catch(() => ({}));
      if (!whResp.ok) {
        console.error('[Webhook] Error registrando webhook app/uninstalled:', whData);
      } else {
        console.log('[Webhook] app/uninstalled registrado');
      }
    } catch (whErr) {
      console.error('[Webhook] Error registrando webhook:', whErr);
    }

    res.redirect(`/dashboard?store_id=${storeId}`);
  } catch (err) {
    console.error('[OAuth] Error callback:', err);
    res.status(500).send('Error processing OAuth callback');
  }
});

/* =========================
   Feed XML on-demand (dominio público robusto)
   ========================= */

function buildXmlFeed(products, storeDomain) {
  // Helper para extraer el valor localizado (es -> fallback)
  function getLocalized(val) {
    if (val === undefined || val === null) return '';
    if (typeof val === 'object') {
      if (val.es) return val.es;
      const keys = Object.keys(val);
      return keys.length > 0 ? val[keys[0]] : '';
    }
    return String(val);
  }

  const safeDomain = normalizeDomain(storeDomain) || 'invalid-domain';

  const items = products.map((p) => {
    const productId = p.id ? String(p.id) : getLocalized(p.handle);
    const title = getLocalized(p.name);
    const description = getLocalized(p.description) || title;
    const handleSlug = getLocalized(p.handle) || String(p.id);

    const link = productLink(safeDomain, handleSlug);

    const imageUrl =
      Array.isArray(p.images) && p.images.length > 0
        ? (p.images[0].src || p.images[0].url || '')
        : '';

    let price = '0.00';
    if (Array.isArray(p.variants) && p.variants.length > 0) {
      const variantPrice = p.variants[0].price || p.variants[0].promotional_price;
      if (variantPrice) price = String(variantPrice);
    }

    const currency = 'ARS';

    // in_stock si alguna variante tiene stock>0 o no gestiona stock
    let availability = 'out_of_stock';
    if (Array.isArray(p.variants) && p.variants.length > 0) {
      for (const v of p.variants) {
        if (!v.stock_management || (v.stock !== undefined && Number(v.stock) > 0)) {
          availability = 'in_stock';
          break;
        }
      }
    }

    let brandVal = '';
    if (p.brand) {
      if (typeof p.brand === 'object' && p.brand.name) {
        brandVal = getLocalized(p.brand.name);
      } else {
        brandVal = getLocalized(p.brand);
      }
    }
    if (!brandVal) brandVal = 'Media Naranja';

    return [
      '  <item>',
      `    <g:id>${productId}</g:id>`,
      `    <g:title><![CDATA[${title}]]></g:title>`,
      `    <g:description><![CDATA[${description}]]></g:description>`,
      `    <g:link>${link}</g:link>`,
      `    <g:image_link>${imageUrl}</g:image_link>`,
      `    <g:availability>${availability}</g:availability>`,
      `    <g:price>${price} ${currency}</g:price>`,
      '    <g:condition>new</g:condition>',
      `    <g:brand><![CDATA[${brandVal}]]></g:brand>`,
      '    <g:identifier_exists>false</g:identifier_exists>',
      '  </item>',
    ].join('\n');
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    '<channel>',
    '  <title>Feed de Productos Tiendanube</title>',
    `  <link>https://${safeDomain}/</link>`,
    '  <description>Feed generado desde la API de Tiendanube</description>',
    items.join('\n'),
    '</channel>',
    '</rss>',
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

    // NUEVO: dominio público robusto
    const storeDomain = await getPublicDomain(req, store_id, token);

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
   Webhook endpoint: app/uninstalled
   ========================= */
app.post('/webhook', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const hmacHeader =
      req.headers['x-linkedstore-hmac-sha256'] || req.headers['http_x_linkedstore_hmac_sha256'];
    const raw = JSON.stringify(req.body || {});
    const secret = process.env.TN_CLIENT_SECRET || '';
    const digest = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const verified = hmacHeader && hmacHeader === digest;

    if (!verified) {
      console.error('[Webhook] Firma inválida');
      return res.status(401).send('Invalid signature');
    }

    const { store_id, event } = req.body || {};
    if (event === 'app/uninstalled' && store_id) {
      await deleteToken(String(store_id));
      console.log(`[Webhook] app/uninstalled recibido. store_id=${store_id} -> token eliminado`);
    }
    return res.status(200).send('OK');
  } catch (e) {
    console.error('[Webhook] Error procesando webhook:', e);
    return res.status(500).send('Error');
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

  // útil para debug del dominio
  app.get('/debug/domain', async (req, res) => {
    const store_id = req.query.store_id;
    if (!store_id) return res.status(400).json({ error: 'missing store_id' });
    const token = await getToken(store_id);
    if (!token) return res.status(401).json({ error: 'no token' });
    const domain = await getPublicDomain(req, store_id, token);
    res.json({ store_id, domain });
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
