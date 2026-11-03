// Public: GET /image serves the current photo (the homepage displays it).
// Private: /upload is behind Cloudflare Access. This Worker also verifies the
// Access token itself and refuses requests when Access is not configured.

const IMAGE_KEY = "current-image";
const MAX_BYTES = 20 * 1024 * 1024;
const CERT_TTL_MS = 10 * 60 * 1000;

let certCache = { domain: "", expires: 0, keys: [] };

const text = (message, status) =>
  new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });

const decodeBase64Url = (value) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const decodeJson = (value) => JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));

async function loadCerts(env, force = false) {
  const now = Date.now();
  if (!force && certCache.domain === env.TEAM_DOMAIN && certCache.expires > now) {
    return certCache.keys;
  }
  const response = await fetch(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error("Could not load Access certificates");
  const { keys } = await response.json();
  certCache = { domain: env.TEAM_DOMAIN, expires: now + CERT_TTL_MS, keys };
  return keys;
}

async function verifyAccessToken(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader);
  const payload = decodeJson(encodedPayload);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unexpected token algorithm");

  let jwk = (await loadCerts(env)).find((key) => key.kid === header.kid);
  if (!jwk) jwk = (await loadCerts(env, true)).find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("Unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signedData = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeBase64Url(encodedSignature),
    signedData,
  );
  if (!valid) throw new Error("Bad signature");

  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== env.TEAM_DOMAIN) throw new Error("Wrong issuer");
  if (!audience.includes(env.POLICY_AUD)) throw new Error("Wrong audience");
  if (typeof payload.exp !== "number" || payload.exp <= now) throw new Error("Token expired");
  if (typeof payload.nbf === "number" && payload.nbf > now) throw new Error("Token not active");
  if (!payload.email) throw new Error("Token has no email");
  return payload;
}

function detectImageType(bytes) {
  const startsWith = (...values) => values.every((value, index) => bytes[index] === value);
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

async function serveImage(request, env) {
  const object = await env.IMAGES.get(IMAGE_KEY);
  if (!object) return text("No image yet", 404);

  const headers = new Headers();
  headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  headers.set("X-Content-Type-Options", "nosniff");
  if (request.headers.get("If-None-Match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

async function handleUpload(request, env) {
  if (request.headers.get("Origin") !== new URL(request.url).origin) {
    return text("Upload refused", 403);
  }
  const declaredSize = Number(request.headers.get("Content-Length") ?? 0);
  if (declaredSize > MAX_BYTES) return text("Image is larger than 20 MB", 413);

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length === 0) return text("No image received", 400);
  if (body.length > MAX_BYTES) return text("Image is larger than 20 MB", 413);

  const contentType = detectImageType(body);
  if (!contentType) return text("Use a JPEG, PNG, WebP or GIF image", 415);

  await env.IMAGES.put(IMAGE_KEY, body, { httpMetadata: { contentType } });
  return text("Uploaded", 200);
}

const uploadPage = (email) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Upload Image</title>
  <style>
    :root { color-scheme: light dark; --bg: #f7f5f2; --fg: #1c1b19; --muted: #6f6b65; }
    @media (prefers-color-scheme: dark) { :root { --bg: #161513; --fg: #f2efea; --muted: #a09b93; } }
    * { box-sizing: border-box; margin: 0; }
    body { min-height: 100svh; display: grid; place-content: center; gap: 1rem; padding: 1.5rem;
      background: var(--bg); color: var(--fg); font-family: Georgia, "Times New Roman", serif; text-align: center; }
    h1 { font-weight: 400; }
    p { color: var(--muted); overflow-wrap: anywhere; }
    input, button { font: inherit; max-width: 100%; }
    button { padding: .6rem 1.2rem; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Upload image</h1>
  <p>Signed in as ${escapeHtml(email)}. A new upload replaces the photo on the homepage.</p>
  <form id="form">
    <p><input id="file" type="file" accept="image/jpeg,image/png,image/webp,image/gif" required></p>
    <p><button type="submit">Upload</button></p>
  </form>
  <p id="status" role="status"></p>
  <script>
    const form = document.getElementById("form");
    const status = document.getElementById("status");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const file = document.getElementById("file").files[0];
      if (!file) return;
      status.textContent = "Uploading...";
      try {
        const response = await fetch("/upload", { method: "POST", body: file });
        if (response.ok) {
          status.innerHTML = 'Uploaded. <a href="/">View the homepage</a>';
          form.reset();
        } else {
          status.textContent = await response.text();
        }
      } catch {
        status.textContent = "Upload failed. Check your connection and try again.";
      }
    });
  </script>
</body>
</html>`;

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/image") {
      if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405);
      return serveImage(request, env);
    }

    if (pathname !== "/upload" && !pathname.startsWith("/upload/")) return text("Not found", 404);

    if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return text("Upload is not configured", 403);
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return text("Sign-in required", 403);

    let identity;
    try {
      identity = await verifyAccessToken(token, env);
    } catch {
      return text("Sign-in required", 403);
    }

    if (pathname !== "/upload") return text("Not found", 404);
    if (request.method === "GET") {
      return new Response(uploadPage(identity.email), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (request.method === "POST") return handleUpload(request, env);
    return text("Method not allowed", 405);
  },
};
