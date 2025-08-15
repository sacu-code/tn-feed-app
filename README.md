# Tiendanube Feed App

This project provides a simple **external Tiendanube app** that can generate
Google Merchant Center compatible XML feeds for any store that installs it.

The app implements the basic OAuth 2 authorization flow, stores the
resulting access token for each store in memory, and exposes a `/feed.xml`
endpoint that fetches products from the Tiendanube API and converts them
into the required XML format.

## Features

- **/install** – Redirects merchants to the Tiendanube authorization page for
  your app. They will be asked to grant the scopes configured in your app.
- **/oauth/callback** – Handles the redirect back from Tiendanube, exchanges
  the authorization code for an access token, stores it, and shows the feed
  URL for the merchant.
- **/feed.xml?store_id=XYZ** – Fetches products using the store’s access
  token and returns an XML feed with basic fields (title, description,
  price, image, etc.).

This is a starting point—you can extend it to handle product variants,
pagination, error handling, caching, and persistent token storage.

## Getting Started

1. **Create an app** in the Tiendanube Partner portal as an external app.
   - Set the Install URL to `https://<your-app>.vercel.app/install`.
   - Set the Redirect URL to `https://<your-app>.vercel.app/oauth/callback`.
   - Request at least the `read_products` scope.

2. **Deploy the project** on a platform like Vercel:
   - Connect this repository as a new project.
   - Configure the following environment variables:
     - `TN_CLIENT_ID` – obtained from your app in the Partner portal.
     - `TN_CLIENT_SECRET` – obtained from your app in the Partner portal.
     - `APP_URL` – the public URL of your Vercel deployment.
     - `API_VERSION` – optional, default `v1`.
     - `JWT_SECRET` – any random string.

3. **Install the app** on a test store by visiting the `/install` endpoint.
   After authorizing, the callback page will display the personalized
   `/feed.xml` URL for that store.

## Extending the feed

The `buildXmlFeed` function in `server.js` currently outputs one `<item>` per
product. To include product variants (such as color and size), iterate
through the `variants` array in each product and create a separate item for
each variation. You can also set `item_group_id` to the product ID to
associate variants under the same group.

## License

MIT