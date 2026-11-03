# Ayelet Cohen Photography

Site for ayeletcohenphotography.com, served by Cloudflare Workers.

- `public/index.html`: the homepage, which displays the current photo.
- `src/index.js`: serves `/image` publicly and `/upload` to signed-in users.
- Photos are stored in the `ayeletcohenphotography-images` R2 bucket.
- `/upload` is protected by the Cloudflare Access application "Upload image".
  Manage allowed emails in that application's policy, not in this repo.

Run `npm test` for the Worker tests. Pushing to `main` deploys the site.
