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
  // En producción usa solo DATABASE_URL (Neon/Vercel la proveen)
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
      const { rows } = await pool.query('SELECT 1 FROM tokens WHERE store_id = $1 LIMIT 1', [
        storeId,
      ]);
      return rows.length > 0;
    } catch (e) {
      console.error('[DB] hasToken error:', e);
    }
  }
  return !!storeTokens[storeId];
}

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
   Config / Env
   ========================= */
const BRAND_PRIMARY = process.env.BRAND_PRIMARY || '#0f6fff';
const BRAND_ACCENT = process.env.BRAND_ACCENT || '#00b2ff';
const LOGO_URL = process.env.LOGO_URL || 'https://www.sacudigital.com/apps-sacu/feedxml/logo.png';

// Cache feed (in-memory per instancia)
const FEED_CACHE_TTL_SECONDS = Number(process.env.FEED_CACHE_TTL_SECONDS || '300'); // 5m default
const VARIANT_MODE = (process.env.VARIANT_MODE || 'split').toLowerCase(); // split | first
// Defaults de marca
const DEFAULT_BRAND = process.env.DEFAULT_BRAND || ''; // fallback global (si no se detecta marca)
const BRAND_MAP = process.env.BRAND_MAP || ''; // "2307236:Los Locos,6467092:VRX"

/* =========================
   Helpers Tiendanube
   ========================= */

function getInstallUrl(state = '') {
  const appId = process.env.TN_CLIENT_ID;
  const baseUrl = `https://www.tiendanube.com/apps/${appId}/authorize`;
  return state ? `${baseUrl}?state=${state}` : baseUrl;
}

function getTokenExchangeUrl() {
  return 'https://www.tiendanube.com/apps/authorize/token';
}

/* =========================
   Normalización / seguridad XML
   ========================= */

function normalizeDomain(val) {
  if (!val) return null;
  if (typeof val === 'string') return val.trim().replace(/^https?:\/\//i, '').replace(/\/+$/g, '');
  if (typeof val === 'number') return String(val);

  if (typeof val === 'object') {
    if (val.domain) return normalizeDomain(val.domain);
    if (val.url) return normalizeDomain(val.url);
    if (val.name) return normalizeDomain(val.name);
    if (val.host) return normalizeDomain(val.host);
    if (val.es) return normalizeDomain(val.es);
    const s = String(val);
    if (s === '[object Object]') return null;
    return normalizeDomain(s);
  }
  return null;
}

function isLikelyHost(h) {
  if (!h) return false;
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(h);
}

function pickBestDomain(domains) {
  const list = (domains || []).map(normalizeDomain).filter(Boolean);
  if (!list.length) return null;
  const custom = list.find((d) => !/\.tiendanube\.com$/i.test(d));
  return custom || list[0];
}

function resolveDomainOverrides(req, storeId) {
  const q = normalizeDomain(req.query.domain);
  if (q && isLikelyHost(q) && !/\.tiendanube\.com$/i.test(q)) return q;

  const mapStr = process.env.DOMAINS_MAP || '';
  if (mapStr) {
    const pairs = mapStr.split(',').map((s) => s.trim()).filter(Boolean);
    const hit = pairs.find((p) => p.startsWith(String(storeId) + ':'));
    if (hit) {
      const val = hit.split(':').slice(1).join(':');
      const host = normalizeDomain(val);
      if (host && isLikelyHost(host)) return host;
    }
  }
  return null;
}

function productLink(storeDomain, handle) {
  const host = normalizeDomain(storeDomain) || 'invalid-domain';
  return `https://${host}/productos/${handle}/?utm_source=xml`;
}

function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function safeCdata(s) {
  // Evita romper CDATA con "]]>"
  return String(s || '').replace(/\]\]>/g, ']]]]><![CDATA[>');
}

function getLocalized(val) {
  if (val === undefined || val === null) return '';
  if (typeof val === 'object') {
    if (val.es) return val.es;
    const keys = Object.keys(val);
    return keys.length > 0 ? val[keys[0]] : '';
  }
  return String(val);
}

/* =========================
   Marca: lógica correcta
   ========================= */

function resolveBrandOverride(storeId) {
  const mapStr = BRAND_MAP || '';
  if (!mapStr) return '';
  const pairs = mapStr.split(',').map((s) => s.trim()).filter(Boolean);
  const hit = pairs.find((p) => p.startsWith(String(storeId) + ':'));
  if (!hit) return '';
  return hit.split(':').slice(1).join(':').trim();
}

// Heurística de marca por producto/variant:
// 1) override por tienda (BRAND_MAP)
// 2) brand del producto (p.brand / p.brand.name / p.brand.es)
// 3) vendor / manufacturer / attributes relacionados
// 4) DEFAULT_BRAND (si existe)
// 5) string vacío (y el tag <g:brand> NO se emite)
function getBrandForProduct(storeId, p) {
  const override = resolveBrandOverride(storeId);
  if (override) return override;

  let brandVal = '';
  if (p?.brand) {
    if (typeof p.brand === 'object' && p.brand.name) brandVal = getLocalized(p.brand.name);
    else brandVal = getLocalized(p.brand);
  }

  if (!brandVal && p?.vendor) brandVal = getLocalized(p.vendor);
  if (!brandVal && p?.manufacturer) brandVal = getLocalized(p.manufacturer);

  // A veces viene como "attributes" o "properties"
  if (!brandVal && p?.attributes && typeof p.attributes === 'object') {
    const possible = p.attributes.brand || p.attributes.marca;
    if (possible) brandVal = getLocalized(possible);
  }

  brandVal = String(brandVal || '').trim();

  if (!brandVal && DEFAULT_BRAND) brandVal = DEFAULT_BRAND.trim();
  return brandVal || '';
}

/* =========================
   API Tiendanube
   ========================= */

async function tnFetch(storeId, token, path) {
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
   Dominio público: query -> DOMAINS_MAP -> /domains -> /store -> fallback
   ========================= */
async function getPublicDomain(req, storeId, token) {
  const override = resolveDomainOverrides(req, storeId);
  if (override) return override;

  // /domains
  try {
    const arr = await tnFetch(storeId, token, '/domains');
    const domains = Array.isArray(arr) ? arr.map((d) => normalizeDomain(d?.domain ?? d)) : [];
    const pick = pickBestDomain(domains);
    if (pick) return pick;
  } catch (_) {}

  // /store
  try {
    const store = await tnFetch(storeId, token, '/store');
    const domainsFromStore =
      Array.isArray(store?.domains) ? store.domains : Array.isArray(store?.domain) ? store.domain : null;

    const pick =
      pickBestDomain(domainsFromStore) ||
      normalizeDomain(store?.original_domain) ||
      normalizeDomain(store?.store_domain);

    if (pick && isLikelyHost(pick)) return pick;
  } catch (_) {}

  return `${storeId}.tiendanube.com`;
}

/* =========================
   Cookies
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
   Landing + Dashboard (igual que antes)
   ========================= */
app.get('/', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sid = req.query.store_id || cookies.store_id;

  if (sid && (await hasToken(sid))) {
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
   OAuth callback (FIX CRÍTICO: usar store_id real)
   ========================= */
app.get('/install', (_req, res) => res.redirect(getInstallUrl()));

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

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('[OAuth] Error intercambiando code:', data);
      return res.status(500).send('Failed to obtain access token');
    }

    // FIX: usar store_id (no user_id)
    const { access_token, store_id } = data;

    if (!access_token || !store_id) {
      console.error('[OAuth] Respuesta inválida (missing access_token/store_id):', data);
      return res.status(500).send('Invalid token response from Tiendanube');
    }

    const storeId = String(store_id);
    await saveToken(storeId, access_token);

    const maxAge = 60 * 60 * 24 * 30; // 30 días
    res.setHeader('Set-Cookie', `store_id=${storeId}; Path=/; Max-Age=${maxAge}; SameSite=None; Secure`);

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
      if (!whResp.ok) console.error('[Webhook] Error registrando webhook app/uninstalled:', whData);
      else console.log('[Webhook] app/uninstalled registrado');
    } catch (whErr) {
      console.error('[Webhook] Error registrando webhook:', whErr);
    }

    return res.redirect(`/dashboard?store_id=${storeId}`);
  } catch (err) {
    console.error('[OAuth] Error callback:', err);
    return res.status(500).send('Error processing OAuth callback');
  }
});

/* =========================
   Feed: soporte multi-variant + sale_price + cache + métricas
   ========================= */

// Métricas por tienda (en memoria)
const storeMetrics = new Map(); // store_id -> metrics
function getMetrics(storeId) {
  const sid = String(storeId);
  if (!storeMetrics.has(sid)) {
    storeMetrics.set(sid, {
      store_id: sid,
      feed_requests: 0,
      feed_cache_hits: 0,
      feed_304: 0,
      feed_errors: 0,
      last_error: null,
      last_generated_at: null,
      last_generation_ms: null,
      last_products_count: null,
      last_items_count: null,
      last_domain: null,
    });
  }
  return storeMetrics.get(sid);
}

// Cache por tienda
const feedCache = new Map(); // store_id -> { xml, etag, expiresAt, generatedAt }
function getCached(storeId) {
  const sid = String(storeId);
  const c = feedCache.get(sid);
  if (!c) return null;
  if (Date.now() > c.expiresAt) {
    feedCache.delete(sid);
    return null;
  }
  return c;
}
function setCached(storeId, xml) {
  const sid = String(storeId);
  const etag = crypto.createHash('sha1').update(xml).digest('hex');
  const now = Date.now();
  const ttlMs = Math.max(0, FEED_CACHE_TTL_SECONDS) * 1000;
  feedCache.set(sid, {
    xml,
    etag,
    generatedAt: now,
    expiresAt: now + ttlMs,
  });
  return { etag };
}

function toMoney(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // Google acepta "14999.00 ARS"; Tiendanube suele devolver string ya, pero normalizamos a 2 decimales
  return n.toFixed(2);
}

function normalizeText(s) {
  return String(s || '').trim();
}

function chooseImage(p, v) {
  // Preferir imagen del variant si existiera, sino primera del producto
  // Tiendanube: a veces variant.image_id apunta a images[].id
  const imgs = Array.isArray(p?.images) ? p.images : [];
  if (v && v.image_id && imgs.length) {
    const hit = imgs.find((im) => String(im.id) === String(v.image_id));
    if (hit) return hit.src || hit.url || '';
  }
  if (imgs.length) return imgs[0].src || imgs[0].url || '';
  return '';
}

// Devuelve items ya “aplanados” según modo de variantes
function flattenItems(products) {
  const items = [];
  for (const p of products) {
    const productId = p?.id != null ? String(p.id) : normalizeText(getLocalized(p?.handle));
    const titleBase = normalizeText(getLocalized(p?.name));
    const descBase = normalizeText(getLocalized(p?.description)) || titleBase;
    const handleSlug = normalizeText(getLocalized(p?.handle)) || productId;

    const variants = Array.isArray(p?.variants) ? p.variants : [];
    if (!variants.length) {
      items.push({
        item_id: productId,
        title: titleBase,
        description: descBase,
        handleSlug,
        image_link: chooseImage(p, null),
        price: null,
        sale_price: null,
        availability: 'out_of_stock',
        rawProduct: p,
        rawVariant: null,
      });
      continue;
    }

    if (VARIANT_MODE === 'first') {
      const v = variants[0];
      items.push(buildItemFromVariant(p, v, productId, titleBase, descBase, handleSlug));
    } else {
      // split: 1 item por variante (recomendado para Merchant)
      for (const v of variants) {
        items.push(buildItemFromVariant(p, v, productId, titleBase, descBase, handleSlug));
      }
    }
  }
  return items;
}

function buildItemFromVariant(p, v, productId, titleBase, descBase, handleSlug) {
  const variantId = v?.id != null ? String(v.id) : '';
  const item_id = variantId ? `${productId}-${variantId}` : productId;

  // Título: base + nombre variante (si aporta)
  const variantName = normalizeText(getLocalized(v?.name));
  const title = variantName && variantName.toLowerCase() !== 'default'
    ? `${titleBase} - ${variantName}`
    : titleBase;

  // Precio regular y promo
  const regular = toMoney(v?.price);
  const promo = toMoney(v?.promotional_price);

  let price = regular;
  let sale_price = null;

  if (regular && promo) {
    // si promo < regular => sale_price
    const r = Number(regular);
    const pnum = Number(promo);
    if (Number.isFinite(r) && Number.isFinite(pnum) && pnum > 0 && pnum < r) {
      price = regular;
      sale_price = promo;
    } else {
      // si promo no es menor, ignoramos sale_price
      sale_price = null;
    }
  }

  // Stock / disponibilidad
  let availability = 'out_of_stock';
  if (!v?.stock_management) {
    availability = 'in_stock';
  } else {
    const st = v?.stock;
    if (st !== undefined && st !== null && Number(st) > 0) availability = 'in_stock';
  }

  return {
    item_id,
    title,
    description: descBase,
    handleSlug,
    image_link: chooseImage(p, v),
    price,
    sale_price,
    availability,
    rawProduct: p,
    rawVariant: v,
  };
}

function buildXmlFeed({ items, storeDomain, storeId }) {
  const safeDomain = normalizeDomain(storeDomain) || 'invalid-domain';
  const currency = 'ARS';

  const lines = [];
  for (const it of items) {
    const p = it.rawProduct || {};
    const brandVal = getBrandForProduct(storeId, p);

    // Por seguridad: si no hay price, no emitimos item (Merchant lo suele rechazar)
    // Si querés incluirlos igual, comentá este if.
    if (!it.price) continue;

    const link = productLink(safeDomain, it.handleSlug);

    lines.push('  <item>');
    lines.push(`    <g:id>${xmlEscape(it.item_id)}</g:id>`);
    lines.push(`    <g:title><![CDATA[${safeCdata(it.title)}]]></g:title>`);
    lines.push(`    <g:description><![CDATA[${safeCdata(it.description)}]]></g:description>`);
    lines.push(`    <g:link>${xmlEscape(link)}</g:link>`);

    if (it.image_link) lines.push(`    <g:image_link>${xmlEscape(it.image_link)}</g:image_link>`);
    lines.push(`    <g:availability>${xmlEscape(it.availability)}</g:availability>`);

    lines.push(`    <g:price>${xmlEscape(it.price)} ${currency}</g:price>`);

    // ✅ g:sale_price (si corresponde)
    if (it.sale_price) {
      lines.push(`    <g:sale_price>${xmlEscape(it.sale_price)} ${currency}</g:sale_price>`);
    }

    lines.push('    <g:condition>new</g:condition>');

    // ✅ brand “correcto”: si está vacío, no lo mandamos (evita "Media Naranja" para todos)
    if (brandVal) lines.push(`    <g:brand><![CDATA[${safeCdata(brandVal)}]]></g:brand>`);

    // Si en algún momento querés GTIN/MPN reales, esto hay que hacerlo configurable
    lines.push('    <g:identifier_exists>false</g:identifier_exists>');
    lines.push('  </item>');
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    '<channel>',
    '  <title>Feed de Productos Tiendanube</title>',
    `  <link>https://${xmlEscape(safeDomain)}/</link>`,
    '  <description>Feed generado desde la API de Tiendanube</description>',
    lines.join('\n'),
    '</channel>',
    '</rss>',
  ].join('\n');
}

app.get('/feed.xml', async (req, res) => {
  const { store_id } = req.query;
  if (!store_id) return res.status(400).send('Missing store_id');

  const sid = String(store_id);
  const m = getMetrics(sid);
  m.feed_requests += 1;

  try {
    const token = await getToken(sid);
    if (!token) return res.status(401).send('No hay token. Instala la app primero para esta tienda.');

    // 1) Cache
    const cached = getCached(sid);
    if (cached) {
      const ifNoneMatch = (req.headers['if-none-match'] || '').replace(/"/g, '');
      if (ifNoneMatch && ifNoneMatch === cached.etag) {
        m.feed_304 += 1;
        res.status(304).end();
        return;
      }

      m.feed_cache_hits += 1;
      res.setHeader('Content-Type', 'text/xml; charset=utf-8');
      res.setHeader('Cache-Control', `public, max-age=${FEED_CACHE_TTL_SECONDS}`);
      res.setHeader('ETag', `"${cached.etag}"`);
      res.send(cached.xml);
      return;
    }

    // 2) Generar
    const t0 = Date.now();
    const storeDomain = await getPublicDomain(req, sid, token);
    const products = await fetchAllProducts(sid, token);
    const flat = flattenItems(products);

    const xml = buildXmlFeed({
      items: flat,
      storeDomain,
      storeId: sid,
    });

    const { etag } = setCached(sid, xml);

    const ms = Date.now() - t0;
    m.last_generated_at = new Date().toISOString();
    m.last_generation_ms = ms;
    m.last_products_count = Array.isArray(products) ? products.length : null;
    m.last_items_count = flat.length;
    m.last_domain = storeDomain;

    // 3) Responder
    const ifNoneMatch = (req.headers['if-none-match'] || '').replace(/"/g, '');
    if (ifNoneMatch && ifNoneMatch === etag) {
      m.feed_304 += 1;
      res.status(304).end();
      return;
    }

    res.setHeader('Content-Type', 'text/xml; charset=utf-8');
    res.setHeader('Cache-Control', `public, max-age=${FEED_CACHE_TTL_SECONDS}`);
    res.setHeader('ETag', `"${etag}"`);
    res.send(xml);
  } catch (err) {
    m.feed_errors += 1;
    m.last_error = String(err?.message || err);
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
      if (!pool) {
        return res.json({ rows: Object.keys(storeTokens).map((s) => ({ store_id: s })) });
      }
      const { rows } = await pool.query(
        'SELECT store_id, created_at FROM tokens ORDER BY created_at DESC LIMIT 200'
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/debug/domain', async (req, res) => {
    const store_id = req.query.store_id;
    if (!store_id) return res.status(400).json({ error: 'missing store_id' });
    const token = await getToken(String(store_id));
    if (!token) return res.status(401).json({ error: 'no token' });
    const domain = await getPublicDomain(req, String(store_id), token);
    res.json({ store_id: String(store_id), domain });
  });

  // ✅ Métricas por tienda
  app.get('/debug/metrics', async (req, res) => {
    const store_id = req.query.store_id;
    if (store_id) return res.json(getMetrics(String(store_id)));
    // lista todas (útil para operar)
    return res.json({ stores: Array.from(storeMetrics.values()) });
  });

  // ✅ Cache status
  app.get('/debug/cache', async (req, res) => {
    const store_id = req.query.store_id;
    if (!store_id) {
      return res.json({
        ttl_seconds: FEED_CACHE_TTL_SECONDS,
        entries: Array.from(feedCache.entries()).map(([sid, c]) => ({
          store_id: sid,
          etag: c.etag,
          expires_in_ms: Math.max(0, c.expiresAt - Date.now()),
        })),
      });
    }
    const c = getCached(String(store_id));
    if (!c) return res.json({ store_id: String(store_id), cached: false });
    return res.json({
      store_id: String(store_id),
      cached: true,
      etag: c.etag,
      expires_in_ms: Math.max(0, c.expiresAt - Date.now()),
    });
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
