# Ayelet Cohen Photography

Site for ayeletcohenphotography.com, served by Cloudflare Workers. Hebrew pages are at
the site root and English pages are under `/en`.

- `src/render.js`: public pages, rendered on the server for search engines.
- `src/content.js`: services and default Hebrew and English text.
- `src/index.js`: routes, site data, contact form and the protected `/config` API.
- `src/config-page.js`: the private settings page.
- `public/assets/site.css`: site styles.
- Settings and photos are stored in the `ayeletcohenphotography-images` R2 bucket.
- `/config` is protected by the Cloudflare Access application "Upload image".
  Manage allowed emails in that application's policy, not in this repo.
- The contact form needs Email Routing on the domain and a verified destination
  address, which is set on the settings page.

Run `npm test` for the Worker tests. Pushing to `main` deploys the site.
