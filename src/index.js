import { configPage } from "./config-page.js";

// Public: /api/site and /photos/<id> supply the homepage.
// Private: /config is behind Cloudflare Access. This Worker also verifies the
// Access token itself and refuses requests when Access is not configured.

const SITE_KEY = "site.json";
const LEGACY_IMAGE_KEY = "current-image";
const MAIN_HOST = "ayeletcohenphotography.com";
const WWW_HOST = `www.${MAIN_HOST}`;
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

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PHOTO_ROUTE = new RegExp(`^/photos/(${UUID_PATTERN})$`);
const API_ALBUM_ROUTE = new RegExp(`^/config/api/albums/(${UUID_PATTERN})$`);
const API_ALBUM_PHOTOS_ROUTE = new RegExp(`^/config/api/albums/(${UUID_PATTERN})/photos$`);
const API_PHOTO_ROUTE = new RegExp(`^/config/api/photos/(${UUID_PATTERN})$`);

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const photoKey = (id) => `photos/${id}`;

async function saveSite(env, site) {
  await env.IMAGES.put(SITE_KEY, JSON.stringify(site), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function loadSite(env) {
  const stored = await env.IMAGES.get(SITE_KEY);
  if (stored) return stored.json();

  const site = { phone: "", instagram: "", albums: [] };
  const legacy = await env.IMAGES.get(LEGACY_IMAGE_KEY);
  if (legacy) {
    const photoId = crypto.randomUUID();
    await env.IMAGES.put(photoKey(photoId), await legacy.arrayBuffer(), {
      httpMetadata: legacy.httpMetadata,
    });
    site.albums.push({ id: crypto.randomUUID(), name: "Photos", photos: [photoId] });
    await saveSite(env, site);
    await env.IMAGES.delete(LEGACY_IMAGE_KEY);
  }
  return site;
}

function normalizePhone(value) {
  const phone = String(value ?? "").trim();
  if (phone === "") return "";
  return /^\+?[0-9][0-9\s()-]{5,24}$/.test(phone) ? phone : null;
}

function normalizeInstagram(value) {
  const input = String(value ?? "").trim();
  if (input === "") return "";

  let handle = input.replace(/^@/, "");
  if (input.includes("/")) {
    let url;
    try {
      url = new URL(input.includes("://") ? input : `https://${input}`);
    } catch {
      return null;
    }
    if (!["instagram.com", "www.instagram.com"].includes(url.hostname.toLowerCase())) return null;
    handle = url.pathname.split("/").filter(Boolean)[0] ?? "";
  }
  return /^[A-Za-z0-9._]{1,30}$/.test(handle) ? `https://www.instagram.com/${handle}/` : null;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function servePhoto(request, env, id) {
  const object = await env.IMAGES.get(photoKey(id));
  if (!object) return text("Not found", 404);

  const headers = new Headers();
  headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");
  if (request.headers.get("If-None-Match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

async function updateProfile(request, env) {
  const input = await readJson(request);
  if (!input) return text("Invalid request", 400);
  const phone = normalizePhone(input.phone);
  if (phone === null) return text("Enter a valid phone number", 400);
  const instagram = normalizeInstagram(input.instagram);
  if (instagram === null) return text("Enter an Instagram username or instagram.com link", 400);

  const site = await loadSite(env);
  site.phone = phone;
  site.instagram = instagram;
  await saveSite(env, site);
  return json(site);
}

async function createAlbum(request, env) {
  const input = await readJson(request);
  const name = String(input?.name ?? "").trim();
  if (name === "" || name.length > 60) return text("Album name must be 1 to 60 characters", 400);

  const site = await loadSite(env);
  site.albums.push({ id: crypto.randomUUID(), name, photos: [] });
  await saveSite(env, site);
  return json(site, 201);
}

async function deleteAlbum(env, albumId) {
  const site = await loadSite(env);
  const album = site.albums.find((item) => item.id === albumId);
  if (!album) return text("Album not found", 404);

  site.albums = site.albums.filter((item) => item.id !== albumId);
  await saveSite(env, site);
  await Promise.all(album.photos.map((id) => env.IMAGES.delete(photoKey(id))));
  return json(site);
}

async function addPhoto(request, env, albumId) {
  const declaredSize = Number(request.headers.get("Content-Length") ?? 0);
  if (declaredSize > MAX_BYTES) return text("Photo is larger than 20 MB", 413);

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length === 0) return text("No photo received", 400);
  if (body.length > MAX_BYTES) return text("Photo is larger than 20 MB", 413);

  const contentType = detectImageType(body);
  if (!contentType) return text("Use a JPEG, PNG, WebP or GIF image", 415);

  const site = await loadSite(env);
  const album = site.albums.find((item) => item.id === albumId);
  if (!album) return text("Album not found", 404);

  const photoId = crypto.randomUUID();
  await env.IMAGES.put(photoKey(photoId), body, { httpMetadata: { contentType } });
  album.photos.push(photoId);
  await saveSite(env, site);
  return json(site, 201);
}

async function deletePhoto(env, photoId) {
  const site = await loadSite(env);
  const album = site.albums.find((item) => item.photos.includes(photoId));
  if (!album) return text("Photo not found", 404);

  album.photos = album.photos.filter((id) => id !== photoId);
  await saveSite(env, site);
  await env.IMAGES.delete(photoKey(photoId));
  return json(site);
}

async function handleConfig(request, env, identity, pathname) {
  const { method } = request;
  if (pathname === "/config") {
    if (method !== "GET") return text("Method not allowed", 405);
    return new Response(configPage(identity.email), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  if (method !== "GET" && request.headers.get("Origin") !== new URL(request.url).origin) {
    return text("Request refused", 403);
  }

  if (pathname === "/config/api/profile" && method === "PUT") return updateProfile(request, env);
  if (pathname === "/config/api/albums" && method === "POST") return createAlbum(request, env);

  const albumMatch = pathname.match(API_ALBUM_ROUTE);
  if (albumMatch && method === "DELETE") return deleteAlbum(env, albumMatch[1]);

  const albumPhotosMatch = pathname.match(API_ALBUM_PHOTOS_ROUTE);
  if (albumPhotosMatch && method === "POST") return addPhoto(request, env, albumPhotosMatch[1]);

  const photoMatch = pathname.match(API_PHOTO_ROUTE);
  if (photoMatch && method === "DELETE") return deletePhoto(env, photoMatch[1]);

  return text("Not found", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const readOnly = request.method === "GET" || request.method === "HEAD";

    if (pathname === "/api/site") {
      if (!readOnly) return text("Method not allowed", 405);
      return json(await loadSite(env));
    }

    const photoMatch = pathname.match(PHOTO_ROUTE);
    if (photoMatch) {
      if (!readOnly) return text("Method not allowed", 405);
      return servePhoto(request, env, photoMatch[1]);
    }

    if (pathname === "/upload" || pathname.startsWith("/upload/")) {
      return Response.redirect(`https://${MAIN_HOST}/config`, 302);
    }

    if (pathname !== "/config" && !pathname.startsWith("/config/")) return text("Not found", 404);

    // Access protects the main domain, so sign-in always happens there.
    if (url.hostname === WWW_HOST) {
      return Response.redirect(`https://${MAIN_HOST}${pathname}`, 302);
    }

    if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return text("Config is not available", 403);
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return text("Sign-in required", 403);

    let identity;
    try {
      identity = await verifyAccessToken(token, env);
    } catch {
      return text("Sign-in required", 403);
    }

    return handleConfig(request, env, identity, pathname);
  },
};
