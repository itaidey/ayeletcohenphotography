import { SERVICES, COPY } from "./content.js";
import { configPage } from "./config-page.js";
import { renderPage, renderSitemap } from "./render.js";

// Public pages are rendered here from site.json in Hebrew and English.
// Private: /config is behind Cloudflare Access. This Worker also verifies the
// Access token itself and refuses requests when Access is not configured.

const SITE_KEY = "site.json";
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
const PHOTO_ROUTE = new RegExp(`^/photos/(${UUID_PATTERN})(/thumb)?$`);
const API_PHOTO_ROUTE = new RegExp(`^/config/api/photos/(${UUID_PATTERN})(?:/(thumb|cover|move))?$`);
const SLOTS = { hero: "heroPhoto", portrait: "portraitPhoto" };
const SLUGS = SERVICES.map((service) => service.slug);
const TEXT_KEYS = Object.keys(COPY.he.defaults);
const MAX_TEXT = 5000;
const CONTACT_FROM = `website@${MAIN_HOST}`;
const MAX_MESSAGES_PER_DAY = 50;
const SECURITY_POLICY = [
  "default-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self'",
  "script-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const photoKey = (id) => `photos/${id}`;
const thumbKey = (id) => `photos/${id}/thumb`;

function emptySite() {
  return {
    version: 2,
    phone: "",
    instagram: "",
    facebook: "",
    contactEmail: "",
    heroPhoto: null,
    portraitPhoto: null,
    text: { he: {}, en: {} },
    services: Object.fromEntries(SLUGS.map((slug) => [slug, { photos: [], text: { he: "", en: "" } }])),
    unsorted: [],
  };
}

async function saveSite(env, site) {
  await env.IMAGES.put(SITE_KEY, JSON.stringify(site), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function loadSite(env) {
  const stored = await env.IMAGES.get(SITE_KEY);
  if (!stored) return emptySite();
  const data = await stored.json();
  if (data.version === 2) return data;

  // Earlier sites kept photos in free-form albums. Keep them for sorting in /config.
  const site = emptySite();
  site.phone = data.phone ?? "";
  site.instagram = data.instagram ?? "";
  site.unsorted = (data.albums ?? []).flatMap((album) => album.photos);
  await saveSite(env, site);
  return site;
}

function normalizePhone(value) {
  const phone = String(value ?? "").trim();
  if (phone === "") return "";
  return /^\+?[0-9][0-9\s()-]{5,24}$/.test(phone) ? phone : null;
}

function normalizeSocial(value, domain) {
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
    const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
    if (host !== domain) return null;
    handle = url.pathname.split("/").filter(Boolean)[0] ?? "";
  }
  return /^[A-Za-z0-9._-]{1,60}$/.test(handle) ? `https://www.${domain}/${handle}/` : null;
}

function normalizeEmail(value) {
  const email = String(value ?? "").trim();
  if (email === "") return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function servePhoto(request, env, id, thumb) {
  const object = (thumb && (await env.IMAGES.get(thumbKey(id)))) || (await env.IMAGES.get(photoKey(id)));
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

async function readImage(request) {
  const declaredSize = Number(request.headers.get("Content-Length") ?? 0);
  if (declaredSize > MAX_BYTES) return { error: text("Photo is larger than 20 MB", 413) };

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length === 0) return { error: text("No photo received", 400) };
  if (body.length > MAX_BYTES) return { error: text("Photo is larger than 20 MB", 413) };

  const contentType = detectImageType(body);
  if (!contentType) return { error: text("Use a JPEG, PNG, WebP or GIF image", 415) };
  return { body, contentType };
}

async function storePhoto(request, env) {
  const image = await readImage(request);
  if (image.error) return image;
  const id = crypto.randomUUID();
  await env.IMAGES.put(photoKey(id), image.body, { httpMetadata: { contentType: image.contentType } });
  return { id };
}

const removePhotoFiles = (env, id) =>
  Promise.all([env.IMAGES.delete(photoKey(id)), env.IMAGES.delete(thumbKey(id))]);

function photoList(site, id) {
  if (site.unsorted.includes(id)) return { owner: site, key: "unsorted" };
  const service = Object.values(site.services).find((item) => item.photos.includes(id));
  return service ? { owner: service, key: "photos" } : null;
}

const hasPhoto = (site, id) =>
  Boolean(photoList(site, id)) || Object.values(SLOTS).some((field) => site[field] === id);

async function updateSettings(request, env) {
  const input = await readJson(request);
  if (!input) return text("Invalid request", 400);
  const phone = normalizePhone(input.phone);
  if (phone === null) return text("Enter a valid phone number", 400);
  const instagram = normalizeSocial(input.instagram, "instagram.com");
  if (instagram === null) return text("Enter an Instagram username or instagram.com link", 400);
  const facebook = normalizeSocial(input.facebook, "facebook.com");
  if (facebook === null) return text("Enter a Facebook page name or facebook.com link", 400);
  const contactEmail = normalizeEmail(input.contactEmail);
  if (contactEmail === null) return text("Enter a valid email address", 400);

  const site = await loadSite(env);
  Object.assign(site, { phone, instagram, facebook, contactEmail });
  await saveSite(env, site);
  return json(site);
}

function cleanText(value) {
  const textValue = String(value ?? "").trim();
  return textValue.length <= MAX_TEXT ? textValue : null;
}

async function updateText(request, env) {
  const input = await readJson(request);
  if (!input) return text("Invalid request", 400);
  const site = await loadSite(env);
  for (const language of ["he", "en"]) {
    for (const key of TEXT_KEYS) {
      const value = cleanText(input[language]?.[key]);
      if (value === null) return text("Text is too long", 400);
      site.text[language][key] = value;
    }
  }
  await saveSite(env, site);
  return json(site);
}

async function updateServiceText(request, env, slug) {
  const input = await readJson(request);
  const he = cleanText(input?.he);
  const en = cleanText(input?.en);
  if (he === null || en === null) return text("Text is too long", 400);
  const site = await loadSite(env);
  site.services[slug].text = { he, en };
  await saveSite(env, site);
  return json(site);
}

async function addServicePhoto(request, env, slug) {
  const stored = await storePhoto(request, env);
  if (stored.error) return stored.error;
  const site = await loadSite(env);
  site.services[slug].photos.push(stored.id);
  await saveSite(env, site);
  return json({ ...site, photoId: stored.id }, 201);
}

async function setSlot(request, env, field) {
  const stored = await storePhoto(request, env);
  if (stored.error) return stored.error;
  const site = await loadSite(env);
  const previous = site[field];
  site[field] = stored.id;
  await saveSite(env, site);
  if (previous) await removePhotoFiles(env, previous);
  return json({ ...site, photoId: stored.id }, 201);
}

async function clearSlot(env, field) {
  const site = await loadSite(env);
  const previous = site[field];
  site[field] = null;
  await saveSite(env, site);
  if (previous) await removePhotoFiles(env, previous);
  return json(site);
}

async function addThumb(request, env, id) {
  const image = await readImage(request);
  if (image.error) return image.error;
  const site = await loadSite(env);
  if (!hasPhoto(site, id)) return text("Photo not found", 404);
  await env.IMAGES.put(thumbKey(id), image.body, { httpMetadata: { contentType: image.contentType } });
  return json(site);
}

async function makeCover(env, id) {
  const site = await loadSite(env);
  const list = photoList(site, id);
  if (!list) return text("Photo not found", 404);
  list.owner[list.key] = [id, ...list.owner[list.key].filter((item) => item !== id)];
  await saveSite(env, site);
  return json(site);
}

async function movePhoto(request, env, id) {
  const input = await readJson(request);
  if (!SLUGS.includes(input?.service)) return text("Choose a service", 400);
  const site = await loadSite(env);
  const list = photoList(site, id);
  if (!list) return text("Photo not found", 404);
  list.owner[list.key] = list.owner[list.key].filter((item) => item !== id);
  site.services[input.service].photos.push(id);
  await saveSite(env, site);
  return json(site);
}

async function deletePhoto(env, id) {
  const site = await loadSite(env);
  const list = photoList(site, id);
  if (!list) return text("Photo not found", 404);
  list.owner[list.key] = list.owner[list.key].filter((item) => item !== id);
  await saveSite(env, site);
  await removePhotoFiles(env, id);
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

  if (pathname === "/config/api/site" && method === "GET") return json(await loadSite(env));

  if (method !== "GET" && request.headers.get("Origin") !== new URL(request.url).origin) {
    return text("Request refused", 403);
  }

  if (pathname === "/config/api/settings" && method === "PUT") return updateSettings(request, env);
  if (pathname === "/config/api/text" && method === "PUT") return updateText(request, env);

  const service = pathname.match(/^\/config\/api\/services\/([a-z]+)\/(text|photos)$/);
  if (service && SLUGS.includes(service[1])) {
    if (service[2] === "text" && method === "PUT") return updateServiceText(request, env, service[1]);
    if (service[2] === "photos" && method === "POST") return addServicePhoto(request, env, service[1]);
  }

  const slot = pathname.match(/^\/config\/api\/slots\/(hero|portrait)$/);
  if (slot && method === "POST") return setSlot(request, env, SLOTS[slot[1]]);
  if (slot && method === "DELETE") return clearSlot(env, SLOTS[slot[1]]);

  const photo = pathname.match(API_PHOTO_ROUTE);
  if (photo) {
    const [, id, action] = photo;
    if (!action && method === "DELETE") return deletePhoto(env, id);
    if (action === "thumb" && method === "PUT") return addThumb(request, env, id);
    if (action === "cover" && method === "POST") return makeCover(env, id);
    if (action === "move" && method === "POST") return movePhoto(request, env, id);
  }

  return text("Not found", 404);
}

async function underDailyLimit(env) {
  const key = `contact-count/${new Date().toISOString().slice(0, 10)}`;
  const stored = await env.IMAGES.get(key);
  const count = stored ? Number((await stored.json()).count) : 0;
  if (count >= MAX_MESSAGES_PER_DAY) return false;
  await env.IMAGES.put(key, JSON.stringify({ count: count + 1 }));
  return true;
}

async function handleContact(request, env, language) {
  const prefix = language === "en" ? "/en" : "";
  const finish = (result) =>
    new Response(null, { status: 303, headers: { Location: `${prefix}/contact?${result}#form` } });

  const form = await request.formData().catch(() => null);
  if (!form) return finish("error=missing");
  const field = (name, limit) => String(form.get(name) ?? "").trim().slice(0, limit);
  const name = field("name", 100).replace(/[\r\n]+/g, " ");
  const phone = field("phone", 30);
  const email = field("email", 254);
  const service = field("service", 40);
  const message = field("message", 3000);

  const submittedAt = Number(form.get("started"));
  const tooFast = !submittedAt || Date.now() - submittedAt < 3000;
  if (field("website", 100) !== "" || tooFast) return finish("sent=1");

  if (!name || !message || (!phone && !email)) return finish("error=missing");
  if (email && normalizeEmail(email) === null) return finish("error=email");

  const site = await loadSite(env);
  if (!env.EMAIL || !site.contactEmail || !(await underDailyLimit(env))) return finish("error=send");

  const serviceName = SERVICES.find((item) => item.slug === service)?.he.name ?? "לא צוין";
  const lines = [`שם: ${name}`, `טלפון: ${phone || "-"}`, `מייל: ${email || "-"}`, `תחום: ${serviceName}`, "", message];
  try {
    await env.EMAIL.send({
      to: site.contactEmail,
      from: { email: CONTACT_FROM, name: "האתר של איילת כהן" },
      subject: `פנייה חדשה מהאתר: ${name}`,
      text: lines.join("\n"),
      ...(email ? { replyTo: email } : {}),
    });
  } catch {
    return finish("error=send");
  }
  return finish("sent=1");
}

const ROBOTS = `User-agent: *\nDisallow: /config\nSitemap: https://${MAIN_HOST}/sitemap.xml\n`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const readOnly = request.method === "GET" || request.method === "HEAD";

    const photoMatch = pathname.match(PHOTO_ROUTE);
    if (photoMatch) {
      if (!readOnly) return text("Method not allowed", 405);
      return servePhoto(request, env, photoMatch[1], Boolean(photoMatch[2]));
    }

    if (pathname === "/upload" || pathname.startsWith("/upload/")) {
      return Response.redirect(`https://${MAIN_HOST}/config`, 302);
    }

    if (pathname === "/config" || pathname.startsWith("/config/")) {
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
    }

    if (pathname === "/robots.txt") return new Response(ROBOTS, { headers: { "Content-Type": "text/plain" } });
    if (pathname === "/sitemap.xml") {
      return new Response(renderSitemap(), { headers: { "Content-Type": "application/xml; charset=utf-8" } });
    }

    const language = pathname === "/en" || pathname.startsWith("/en/") ? "en" : "he";
    const route = (language === "en" ? pathname.slice(3) : pathname).replace(/\/$/, "") || "/";

    if (route === "/contact" && request.method === "POST") return handleContact(request, env, language);
    if (!readOnly) return text("Method not allowed", 405);

    const site = await loadSite(env);
    const page = renderPage({ route, language, url, site, canEmail: Boolean(env.EMAIL && site.contactEmail) });
    return new Response(request.method === "HEAD" ? null : page.html, {
      status: page.status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=0, must-revalidate",
        "Content-Security-Policy": SECURITY_POLICY,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      },
    });
  },
};
