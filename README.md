# Body & Soul CRM Backend

Receives Meta (Facebook/Instagram) Lead Ads automatically and stores them so the CRM can sync.

## Quick Deploy (recommended free options)

### Option A — Render.com (easiest)
1. Push this folder to a GitHub repo (or use Render's direct deploy).
2. Create a new **Web Service** on Render.
3. Set environment variables:
   - `META_VERIFY_TOKEN` = any secret string you choose (e.g. `bodyandsoul_crm_verify`)
   - `META_PAGE_ACCESS_TOKEN` = your Meta Page Access Token (see below)
4. Deploy. Render gives you a public URL like `https://body-soul-crm.onrender.com`

### Option B — Railway.app
Same idea. Create project → Deploy from GitHub or upload → add the two environment variables.

## Meta App Setup (one-time)

1. Go to [developers.facebook.com](https://developers.facebook.com) → Create App → type **Business**.
2. Add the **Webhooks** product.
3. In Webhooks, subscribe to the **Page** object.
4. Callback URL: `https://YOUR-BACKEND-URL/webhook/meta`
5. Verify Token: the same value you set in `META_VERIFY_TOKEN`.
6. Subscribe to the `leadgen` field.
7. Generate a **Page Access Token** (in the Graph API Explorer or Business Settings) with `leads_retrieval` and `pages_manage_metadata` permissions, then put it in `META_PAGE_ACCESS_TOKEN`.

Once connected, every new Meta lead form submission will automatically appear in the CRM (the frontend syncs every 30 seconds or on refresh).

## Local testing
```bash
npm install
META_VERIFY_TOKEN=test META_PAGE_ACCESS_TOKEN=your_token node server.js
```
Use ngrok to expose it publicly for Meta: `ngrok http 3000`
