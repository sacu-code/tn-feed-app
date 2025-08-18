const express = require('express');
// Determine the appropriate `fetch` implementation.  In modern Node.js
// runtimes (v18+), the global `fetch` API is available.  When running
// somewhere that does not provide a global fetch (e.g. older Node
// versions), fall back to dynamically importing the `node-fetch` package.
// We avoid using `require()` here because `node-fetch` is published as
// an ES module, and requiring it in a CommonJS context will throw
// `ERR_REQUIRE_ESM`.  The dynamic import resolves the default export
// correctly.  See https://github.com/node-fetch/node-fetch for details.
const fetch = (...args) => {
  // If a global fetch exists, use it directly.
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch(...args);
  }
  // Otherwise, lazily import node-fetch.  This returns a promise,
  // so callers must await the returned value just like the native
  // fetch.  If node-fetch is not installed, this will reject and
  // errors will be caught by the caller.
  return import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));
};

// Initialize Express app
const app = express();

// Initialize PostgreSQL connection pool. We use the DATABASE_URL
// environment variable provided by Railway/Vercel to connect to the
// database. If no DATABASE_URL is present (for example in local
// development), the pool will not be created and the app will fall
// back to in‑memory token storage. The table `tokens` must exist
// with columns id (serial primary key), store_id (text),
// access_token (text) and created_at (text or timestamp).
// Initialize PostgreSQL connection pool only if a DATABASE_URL is provided
// and the 'pg' module is available. We defer requiring 'pg' until
// runtime to avoid crashing the serverless function when the module
// isn't installed (e.g. on a fresh deploy). If the require fails
// or no DATABASE_URL is provided, the `pool` remains undefined and
// the app falls back to in-memory token storage.
let pool;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  } catch (err) {
    console.warn(
      'pg module not found or failed to initialize; falling back to in-memory token storage',
      err
    );
    pool = undefined;
  }
}

// In‑memory storage for access tokens by store ID. This will be
// used when no DATABASE_URL is defined. Tokens stored here will
// not survive process restarts or scale out to multiple instances.
const storeTokens = {};

/**
 * Persist the access token for a store. When a database is available
 * (pool is defined), this function inserts a new row into the
 * `tokens` table. Otherwise it falls back to in‑memory storage.
 *
 * @param {string} storeId
 * @param {string} accessToken
 */
async function saveToken(storeId, accessToken) {
  if (pool) {
    try {
      await pool.query(
        'INSERT INTO tokens (store_id, access_token, created_at) VALUES ($1, $2, NOW())',
        [storeId, accessToken]
      );
    } catch (err) {
      console.error('Error saving token to database:', err);
    }
  }
  // Always update the in‑memory store as well. This ensures
  // subsequent requests within the same process can use the token
  // without hitting the database.
  storeTokens[storeId] = accessToken;
}

/**
 * Retrieve the most recent access token for a store. If a database
 * is available the query will return the latest token; otherwise
 * the in‑memory store is used.
 *
 * @param {string} storeId
 * @returns {Promise<string|null>}
 */
async function getToken(storeId) {
  if (pool) {
    try {
      const result = await pool.query(
        'SELECT access_token FROM tokens WHERE store_id = $1 ORDER BY id DESC LIMIT 1',
        [storeId]
      );
      if (result.rows.length > 0) {
        return result.rows[0].access_token;
      }
    } catch (err) {
      console.error('Error retrieving token from database:', err);
    }
  }
  return storeTokens[storeId] || null;
}

/**
 * Helper to build the Tiendanube installation URL.
 *
 * Tiendanube apps are installed via a URL in the form
 *   https://www.tiendanube.com/apps/{APP_ID}/authorize?state={CSRF}
 * See the documentation for more details on the authorization flow:
 * https://tiendanube.github.io/api-documentation/authentication
 *
 * We do not include scopes here because they are defined in the app
 * configuration in the partner portal. The `state` parameter is used
 * to prevent CSRF attacks; here we generate a random value per
 * installation request. In a more complete implementation you would
 * persist and validate this state.
 */
function getInstallUrl(state) {
  const appId = process.env.TN_CLIENT_ID;
  return `https://www.tiendanube.com/apps/${appId}/authorize?state=${state}`;
}

/**
 * Endpoint to start the installation process.
 *
 * When a merchant visits this URL, they are redirected to the
 * Tiendanube authorization page. Once they accept the scopes your
 * application requires, Tiendanube will redirect back to the
 * callback URL you configured in the Partner panel.
 */
app.get('/install', (req, res) => {
  // Generate a simple random state token.
  const state = Math.random().toString(36).substring(2, 15);
  const installUrl = getInstallUrl(state);
  res.redirect(installUrl);
});

/**
 * OAuth callback endpoint.
 *
 * Tiendanube redirects to this URL after the merchant has granted
 * authorization. The `code` query parameter contains a short‑lived
 * authorization code which must be exchanged for an access token.
 */
app.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query;

  // If there is no code, something went wrong.
  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

  try {
    // Exchange the authorization code for an access token.
    const response = await fetch('https://www.tiendanube.com/apps/authorize/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: process.env.TN_CLIENT_ID,
        client_secret: process.env.TN_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Error exchanging code for token:', data);
      return res.status(500).send('Failed to obtain access token');
    }

    const { access_token, user_id } = data;

    // Ensure the response contains the expected fields.  In some error
    // conditions Tiendanube returns a 200 status code with an error
    // object that does not include `user_id` or `access_token`.  When
    // either field is missing, log the entire response for debugging
    // and return an error to the client rather than throwing.  This
    // prevents `TypeError: Cannot read properties of undefined` when
    // attempting to call `.toString()` on an undefined value.
    if (!access_token || !user_id) {
      console.error('Invalid token response:', data);
      return res.status(500).send('Invalid token response from Tiendanube');
    }

    // Persist the access token for this store. This will save to
    // the database if available and update the in‑memory store.
    await saveToken(user_id.toString(), access_token);

    // Build a friendly message with the feed URL for this store.
    const feedUrl = `${process.env.APP_URL}/feed.xml?store_id=${user_id}`;
    res.send(
      `<h1>¡App instalada correctamente!</h1>` +
      `<p>Ahora podés acceder a tu feed en el siguiente enlace:</p>` +
      `<a href="${feedUrl}">${feedUrl}</a>`
    );
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send('Error processing OAuth callback');
  }
});

/**
 * Build a Google Merchant Center compatible XML feed from an array
 * of Tiendanube products. This function maps basic product fields
 * into the required `<item>` format. Variations (e.g. size, color)
 * are not yet handled individually. You can extend this function
 * later to iterate through `variants` and output each as a separate
 * item with an `item_group_id`.
 */
function buildXmlFeed(products, storeDomain) {
  // Helper to convert values that may be localized objects into strings. If
  // `value` is an object (for example, `{ es: 'Título', en: 'Title' }`), the
  // first string or number property is returned. Otherwise the value is
  // converted to a string. This prevents `[object Object]` from appearing in
  // the generated XML.
  function toStringValue(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string' || typeof value === 'number') {
      return value.toString();
    }
    if (typeof value === 'object') {
      for (const key in value) {
        const val = value[key];
        if (typeof val === 'string' || typeof val === 'number') {
          return val.toString();
        }
      }
      return JSON.stringify(value);
    }
    return String(value);
  }

  const itemsXml = products
    .map((product) => {
      // Use slug as ID. Fallback to product ID if slug missing.
      const productId = toStringValue(product.handle) || toStringValue(product.id);
      // Use the first image as the main image link.
      const imageUrl =
        product.images && product.images.length > 0 ? toStringValue(product.images[0].src) : '';
      // Price: use the first variant price; convert to required format with ARS currency.
      let price = '0.00 ARS';
      if (product.variants && product.variants.length > 0) {
        const p = product.variants[0].price;
        price = `${toStringValue(p)} ARS`;
      }
      // Availability: if product is enabled and at least one variant is in stock.
      const availableVariant =
        product.variants && product.variants.find((v) => v.available);
      const availability = availableVariant ? 'in_stock' : 'out_of_stock';
      // Title and description: handle localized objects.
      const title = toStringValue(product.name);
      const description = toStringValue(product.description) || title;
      // Brand: fallback to 'Media Naranja' if missing.
      const brand = toStringValue(product.brand) || 'Media Naranja';
      const handle = toStringValue(product.handle);
      // Build item XML string.
      return (
        `    <item>\n` +
        `      <g:id>${productId}</g:id>\n` +
        `      <g:title><![CDATA[${title}]]></g:title>\n` +
        `      <g:description><![CDATA[${description}]]></g:description>\n` +
        `      <g:link>https://${storeDomain}/productos/${handle}</g:link>\n` +
        `      <g:image_link>${imageUrl}</g:image_link>\n` +
        `      <g:availability>${availability}</g:availability>\n` +
        `      <g:price>${price}</g:price>\n` +
        `      <g:condition>new</g:condition>\n` +
        `      <g:brand><![CDATA[${brand}]]></g:brand>\n` +
        `      <g:identifier_exists>false</g:identifier_exists>\n` +
        `    </item>`
      );
    })
    .join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n` +
    `  <channel>\n` +
    `    <title>Feed de Productos Tiendanube</title>\n` +
    `    <link>https://${storeDomain}</link>\n` +
    `    <description>Feed generado desde la API de Tiendanube</description>\n` +
    itemsXml +
    `\n  </channel>\n` +
    `</rss>`
  );
}

/**
 * Endpoint that returns the product feed in XML format.
 *
 * Requires a `store_id` query parameter, which must match a
 * previously installed store with a saved access token. It fetches
 * products from the Tiendanube API and constructs the XML feed.
 */
app.get('/feed.xml', async (req, res) => {
  const { store_id } = req.query;

  if (!store_id) {
    return res.status(400).send('Missing store_id');
  }

  // Retrieve the saved token for this store. If none is found,
  // the app has not been installed or the token has expired.
  const accessToken = await getToken(store_id.toString());
  if (!accessToken) {
    return res.status(401).send('Store not authorized. Please install the app first.');
  }

  try {
    // Fetch products from the Tiendanube API. If your app needs more
    // than 30 products, you should implement pagination.
    const apiVersion = process.env.API_VERSION || 'v1';
    const productUrl = `https://api.tiendanube.com/${apiVersion}/${store_id}/products`; 
    // According to Tiendanube's API documentation, requests must include an
    // `Authentication` header (not `Authorization`) with the format
    // `bearer ACCESS_TOKEN`. The API will return a 401 Unauthorized or
    // `Invalid access token` if this header is missing or malformed.
    // Additionally, we send a `User-Agent` header identifying our app and
    // an `Accept` header requesting JSON. See docs:【537677115026469†L70-L109】.
    const resp = await fetch(productUrl, {
      headers: {
        Authentication: `bearer ${accessToken}`,
        'User-Agent': 'TN Feed App (hola@medianaranja.store)',
        Accept: 'application/json',
      },
    });
    const products = await resp.json();

    if (!Array.isArray(products)) {
      console.error('Unexpected products response:', products);
      return res.status(500).send('Error fetching products');
    }

    // Attempt to get the store domain from the first product's permalink.
    let storeDomain = '';
    if (products.length > 0 && products[0].permalink) {
      try {
        const url = new URL(products[0].permalink);
        storeDomain = url.hostname;
      } catch (err) {
        storeDomain = `${store_id}.com`; // fallback
      }
    }
    // Build XML feed.
    const feedXml = buildXmlFeed(products, storeDomain);
    res.set('Content-Type', 'application/xml');
    res.send(feedXml);
  } catch (err) {
    console.error('Error generating feed:', err);
    res.status(500).send('Error generating feed');
  }
});

// Start the server in development. In a Vercel environment this
// function is used as a Serverless function, but running locally
// allows you to test the app. The port can be set via the
// PORT environment variable or defaults to 3000.
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;