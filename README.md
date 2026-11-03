# Ayelet Cohen Photography

Site for ayeletcohenphotography.com, served by Cloudflare Workers.

- `public/index.html`: the public homepage, built from `/api/site`.
- `src/index.js`: public site data and photos, plus the protected `/config` API.
- `src/config-page.js`: the private settings page.
- Settings and photos are stored in the `ayeletcohenphotography-images` R2 bucket.
- `/config` is protected by the Cloudflare Access application "Upload image".
  Manage allowed emails in that application's policy, not in this repo.

Run `npm test` for the Worker tests. Pushing to `main` deploys the site.
