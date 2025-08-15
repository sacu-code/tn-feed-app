const express = require('express');
const fetch = require('node-fetch');

// Initialize Express app
const app = express();

// In‑memory storage for access tokens by store ID. In a production
// environment you should persist these tokens in a database so
// they survive restarts and can be shared across instances.
const storeTokens = {};

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

    // Store the access token associated with the store ID.
    storeTokens[user_id] = access_token;

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
  const itemsXml = products
    .map((product) => {
      // Use slug as ID. Fallback to product ID if slug missing.
      const productId = product.handle || product.id;
      // Use the first image as the main image link.
      const imageUrl = product.images && product.images.length > 0 ? product.images[0].src : '';
      // Price: use the first variant price; convert to required format with ARS currency.
      let price = '0.00 ARS';
      if (product.variants && product.variants.length > 0) {
        const p = product.variants[0].price;
        price = `${p} ARS`;
      }
      // Availability: if product is enabled and at least one variant is in stock.
      const availableVariant = product.variants.find((v) => v.available);
      const availability = availableVariant ? 'in_stock' : 'out_of_stock';
      // Build item XML string.
      return (
        `    <item>\n` +
        `      <g:id>${productId}</g:id>\n` +
        `      <g:title><![CDATA[${product.name}]]></g:title>\n` +
        `      <g:description><![CDATA[${product.description || product.name}]]></g:description>\n` +
        `      <g:link>https://${storeDomain}/productos/${product.handle}</g:link>\n` +
        `      <g:image_link>${imageUrl}</g:image_link>\n` +
        `      <g:availability>${availability}</g:availability>\n` +
        `      <g:price>${price}</g:price>\n` +
        `      <g:condition>new</g:condition>\n` +
        `      <g:brand><![CDATA[${product.brand || 'Media Naranja'}]]></g:brand>\n` +
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

  const accessToken = storeTokens[store_id];
  if (!accessToken) {
    return res.status(401).send('Store not authorized. Please install the app first.');
  }

  try {
    // Fetch products from the Tiendanube API. If your app needs more
    // than 30 products, you should implement pagination.
    const apiVersion = process.env.API_VERSION || 'v1';
    const productUrl = `https://api.tiendanube.com/${apiVersion}/${store_id}/products`; 
    const resp = await fetch(productUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'TN Feed App (contacto@example.com)',
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