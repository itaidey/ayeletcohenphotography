import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const TEAM_DOMAIN = "https://team.cloudflareaccess.com";
const POLICY_AUD = "test-aud";
const SITE = "https://ayeletcohenphotography.com";
const WWW = "https://www.ayeletcohenphotography.com";
const algorithm = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const pair = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
const other = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
let certFetches = 0;
globalThis.fetch = async (url) => {
  assert.equal(String(url), `${TEAM_DOMAIN}/cdn-cgi/access/certs`);
  certFetches++;
  return Response.json({ keys: [publicJwk] });
};

const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
async function token(claims = {}, { key = pair.privateKey, header = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64(JSON.stringify({ alg: "RS256", kid: "k1", ...header }));
  const p = b64(JSON.stringify({ iss: TEAM_DOMAIN, aud: [POLICY_AUD], exp: now + 600, email: "a@example.com", ...claims }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64(new Uint8Array(sig))}`;
}
function bucket() {
  const items = new Map();
  return {
    items,
    async get(k) {
      const v = items.get(k);
      if (!v) return null;
      const bytes = () => (typeof v.body === "string" ? new TextEncoder().encode(v.body) : v.body);
      return {
        body: new Blob([bytes()]).stream(),
        httpEtag: '"e1"',
        httpMetadata: v.httpMetadata,
        json: async () => JSON.parse(new TextDecoder().decode(bytes())),
        arrayBuffer: async () => bytes().buffer,
      };
    },
    async put(k, body, o) { items.set(k, { body, httpMetadata: o?.httpMetadata }); },
    async delete(k) { items.delete(k); },
  };
}
const env = (images = bucket()) => ({ IMAGES: images, TEAM_DOMAIN, POLICY_AUD });
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
async function api(e, method, path, body, { auth, origin = SITE, headers = {} } = {}) {
  const t = auth === undefined ? await token() : auth;
  const isJson = body !== undefined && !(body instanceof Uint8Array);
  return worker.fetch(new Request(`${SITE}${path}`, {
    method,
    body: isJson ? JSON.stringify(body) : body,
    headers: { Origin: origin, ...(t ? { "Cf-Access-Jwt-Assertion": t } : {}), ...headers },
  }), e);
}
const get = (path, e, t) => worker.fetch(new Request(`${SITE}${path}`, { headers: t ? { "Cf-Access-Jwt-Assertion": t } : {} }), e);
const getSite = async (e) => (await get("/config/api/site", e, await token())).json();
const html = async (path, e) => (await get(path, e)).text();
const contact = (e, fields, path = "/contact") => worker.fetch(new Request(`${SITE}${path}`, {
  method: "POST",
  body: new URLSearchParams({ started: String(Date.now() - 10000), ...fields }),
  redirect: "manual",
}), e);
async function addPhoto(e, slug = "family") {
  return (await (await api(e, "POST", `/config/api/services/${slug}/photos`, png)).json()).photoId;
}

test("config page needs a valid token and escapes the email", async () => {
  const e = env();
  assert.equal((await get("/config", e)).status, 403);
  const ok = await get("/config", e, await token({ email: "<b>@x" }));
  assert.equal(ok.status, 200);
  const page = await ok.text();
  assert.doesNotMatch(page, /<b>@x/);
  assert.match(page, /noindex/);
});
for (const [name, build] of [
  ["expired", () => token({ exp: 1 })],
  ["wrong audience", () => token({ aud: ["other"] })],
  ["wrong issuer", () => token({ iss: "https://evil.example" })],
  ["no email", () => token({ email: "" })],
  ["future nbf", () => token({ nbf: Math.floor(Date.now() / 1000) + 600 })],
  ["forged signature", () => token({}, { key: other.privateKey })],
  ["wrong algorithm", () => token({}, { header: { alg: "none" } })],
  ["unknown key", () => token({}, { header: { kid: "nope" } })],
]) {
  test(`rejects token: ${name}`, async () => {
    const e = env();
    assert.equal((await api(e, "PUT", "/config/api/settings", {}, { auth: await build() })).status, 403);
    assert.equal(e.IMAGES.items.size, 0);
  });
}
test("every API route refuses a missing token, garbage token and missing config", async () => {
  const e = env();
  const id = crypto.randomUUID();
  for (const [method, path, body] of [
    ["GET", "/config/api/site"],
    ["PUT", "/config/api/settings", {}],
    ["PUT", "/config/api/text", {}],
    ["PUT", "/config/api/services/family/text", {}],
    ["POST", "/config/api/services/family/photos", png],
    ["POST", "/config/api/slots/hero", png],
    ["DELETE", "/config/api/slots/hero"],
    ["PUT", `/config/api/photos/${id}/thumb`, png],
    ["POST", `/config/api/photos/${id}/cover`],
    ["POST", `/config/api/photos/${id}/move`, {}],
    ["DELETE", `/config/api/photos/${id}`],
  ]) {
    assert.equal((await api(e, method, path, body, { auth: null })).status, 403, path);
    assert.equal((await api(e, method, path, body, { auth: "a.b.c" })).status, 403, path);
  }
  const unset = { IMAGES: bucket(), TEAM_DOMAIN: "", POLICY_AUD: "" };
  assert.equal((await api(unset, "PUT", "/config/api/settings", {})).status, 403);
  assert.equal(e.IMAGES.items.size, 0);
});
test("cross-site writes are refused", async () => {
  const e = env();
  assert.equal((await api(e, "PUT", "/config/api/settings", { phone: "" }, { origin: "https://evil.example" })).status, 403);
  assert.equal(e.IMAGES.items.size, 0);
});
test("the old site data moves across without losing anything", async () => {
  const e = env();
  const id = crypto.randomUUID();
  await e.IMAGES.put("site.json", JSON.stringify({ phone: "054-882-3866", instagram: "https://www.instagram.com/a/", albums: [{ id: "x", name: "Photos", photos: [id] }] }));
  const site = await getSite(e);
  assert.equal(site.version, 2);
  assert.equal(site.phone, "054-882-3866");
  assert.deepEqual(site.unsorted, [id]);
  assert.match(await html("/gallery", e), new RegExp(id));
  assert.equal(JSON.parse(e.IMAGES.items.get("site.json").body).version, 2);
});
test("contact details are validated and normalized", async () => {
  const e = env();
  const save = (fields) => api(e, "PUT", "/config/api/settings", fields);
  assert.equal((await save({ phone: "not a phone" })).status, 400);
  assert.equal((await save({ instagram: "https://evil.example/x" })).status, 400);
  assert.equal((await save({ instagram: "javascript:alert(1)" })).status, 400);
  assert.equal((await save({ facebook: "https://evil.example/x" })).status, 400);
  assert.equal((await save({ contactEmail: "nope" })).status, 400);
  assert.equal((await save({ phone: "050-123-4567", instagram: "@ayelet.photo", facebook: "facebook.com/ayelet", contactEmail: "a@b.co" })).status, 200);
  const site = await getSite(e);
  assert.equal(site.instagram, "https://www.instagram.com/ayelet.photo/");
  assert.equal(site.facebook, "https://www.facebook.com/ayelet/");
  const page = await html("/", e);
  assert.match(page, /https:\/\/wa\.me\/972501234567/);
  assert.match(page, /facebook\.com\/ayelet/);
  assert.doesNotMatch(page, /a@b\.co/);
  assert.equal((await get("/api/site", e)).status, 404);
});
test("the footer shows WhatsApp and Instagram icons beside their links", async () => {
  const e = env();
  await api(e, "PUT", "/config/api/settings", { phone: "050-123-4567", instagram: "@ayelet" });
  const footer = (await html("/", e)).split('class="site-footer"')[1];
  assert.match(footer, /wa\.me\/972501234567"[^>]*><svg class="icon"/);
  assert.match(footer, /instagram\.com\/ayelet\/"[^>]*><svg class="icon"/);
});
test("all pages render in both languages with search tags", async () => {
  const e = env();
  for (const route of ["", "/about", "/services", "/gallery", "/contact", "/services/weddings", "/services/business"]) {
    const he = await get(route || "/", e);
    assert.equal(he.status, 200, route);
    assert.match(he.headers.get("Content-Security-Policy"), /script-src 'none'/);
    const hebrew = await he.text();
    assert.match(hebrew, /<html lang="he" dir="rtl">/);
    assert.match(hebrew, /hreflang="en"/);
    const english = await html(`/en${route}`, e);
    assert.match(english, /<html lang="en" dir="ltr">/);
    assert.match(english, /rel="canonical"/);
  }
  assert.match(await html("/services/newborn", e), /צילומי ניו בורן/);
  assert.match(await html("/en/services/newborn", e), /Newborn photography/);
  assert.equal((await get("/services/unknown", e)).status, 404);
  assert.equal((await get("/en/nothing", e)).status, 404);
  assert.doesNotMatch(await html("/en/services", e), /₪|NIS|price/i);
});
test("saved text replaces the defaults and is escaped", async () => {
  const e = env();
  await api(e, "PUT", "/config/api/text", { he: { heroTitle: "<script>x</script>" }, en: { about: "First\n\nSecond" } });
  assert.doesNotMatch(await html("/", e), /<script>x/);
  assert.match(await html("/en/about", e), /<p>First<\/p><p>Second<\/p>/);
  await api(e, "PUT", "/config/api/services/family/text", { he: "טקסט שלי", en: "" });
  assert.match(await html("/services/family", e), /טקסט שלי/);
  assert.match(await html("/en/services/family", e), /Relaxed, natural/);
  assert.equal((await api(e, "PUT", "/config/api/text", { he: { about: "x".repeat(5001) } })).status, 400);
});
test("photos are checked before storing and unknown services are refused", async () => {
  const e = env();
  const add = (body) => api(e, "POST", "/config/api/services/family/photos", body);
  assert.equal((await add(new TextEncoder().encode("<svg onload=alert(1)>"))).status, 415);
  assert.equal((await add(new Uint8Array(0))).status, 400);
  assert.equal((await add(new Uint8Array(20 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await api(e, "POST", "/config/api/services/nope/photos", png)).status, 404);
  assert.equal(e.IMAGES.items.size, 0);
});
test("photos show on pages, with thumbnails and safe headers", async () => {
  const e = env();
  const id = await addPhoto(e, "weddings");
  assert.match(await html("/services/weddings", e), new RegExp(`/photos/${id}/thumb`));
  assert.match(await html("/gallery", e), new RegExp(id));
  assert.match(await html("/", e), new RegExp(id));
  const fallback = await get(`/photos/${id}/thumb`, e);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal((await api(e, "PUT", `/config/api/photos/${id}/thumb`, png)).status, 200);
  assert.equal(e.IMAGES.items.has(`photos/${id}/thumb`), true);
  const again = await worker.fetch(new Request(`${SITE}/photos/${id}`, { headers: { "If-None-Match": '"e1"' } }), e);
  assert.equal(again.status, 304);
  assert.equal((await worker.fetch(new Request(`${SITE}/photos/${id}`, { method: "POST", body: png }), e)).status, 405);
  assert.equal((await get("/photos/site.json", e)).status, 404);
  assert.equal((await api(e, "PUT", `/config/api/photos/${crypto.randomUUID()}/thumb`, png)).status, 404);
});
test("cover, move and delete keep the site and storage in step", async () => {
  const e = env();
  const first = await addPhoto(e);
  const second = await addPhoto(e);
  await api(e, "PUT", `/config/api/photos/${second}/thumb`, png);
  await api(e, "POST", `/config/api/photos/${second}/cover`);
  assert.deepEqual((await getSite(e)).services.family.photos, [second, first]);
  assert.equal((await api(e, "POST", `/config/api/photos/${first}/move`, { service: "nope" })).status, 400);
  await api(e, "POST", `/config/api/photos/${first}/move`, { service: "events" });
  let site = await getSite(e);
  assert.deepEqual(site.services.family.photos, [second]);
  assert.deepEqual(site.services.events.photos, [first]);
  assert.equal((await api(e, "DELETE", `/config/api/photos/${second}`)).status, 200);
  assert.equal(e.IMAGES.items.has(`photos/${second}`), false);
  assert.equal(e.IMAGES.items.has(`photos/${second}/thumb`), false);
  assert.equal((await get(`/photos/${second}`, e)).status, 404);
  assert.equal((await api(e, "DELETE", `/config/api/photos/${second}`)).status, 404);
});
test("homepage and portrait photos replace and delete their old files", async () => {
  const e = env();
  const first = (await (await api(e, "POST", "/config/api/slots/hero", png)).json()).photoId;
  const second = (await (await api(e, "POST", "/config/api/slots/hero", png)).json()).photoId;
  assert.equal(e.IMAGES.items.has(`photos/${first}`), false);
  assert.match(await html("/", e), new RegExp(`/photos/${second}`));
  assert.equal((await api(e, "PUT", `/config/api/photos/${second}/thumb`, png)).status, 200);
  await api(e, "DELETE", "/config/api/slots/hero");
  assert.equal(e.IMAGES.items.has(`photos/${second}`), false);
  assert.equal((await getSite(e)).heroPhoto, null);
});
function mail() {
  const sent = [];
  return { sent, async send(message) { sent.push(message); return { messageId: "1" }; } };
}
async function contactEnv() {
  const e = { ...env(), EMAIL: mail() };
  await api(e, "PUT", "/config/api/settings", { contactEmail: "owner@example.com" });
  return e;
}
test("the contact form emails the saved address", async () => {
  const e = await contactEnv();
  const r = await contact(e, { name: "Dana\r\nBcc: x@y.z", phone: "0501234567", email: "d@e.co", service: "newborn", message: "שלום" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("Location"), "/contact?sent=1#form");
  assert.equal(e.EMAIL.sent.length, 1);
  const [message] = e.EMAIL.sent;
  assert.equal(message.to, "owner@example.com");
  assert.equal(message.from.email, "website@ayeletcohenphotography.com");
  assert.equal(message.replyTo, "d@e.co");
  assert.doesNotMatch(message.subject, /[\r\n]/);
  assert.match(message.text, /ניו בורן/);
  assert.match(await html("/contact?sent=1", e), /ההודעה נשלחה/);
});
test("the form only shows when email can be sent", async () => {
  assert.doesNotMatch(await html("/contact", env()), /<form/);
  assert.match(await html("/contact", await contactEnv()), /<form/);
  const noBinding = await contactEnv();
  delete noBinding.EMAIL;
  assert.doesNotMatch(await html("/contact", noBinding), /<form/);
});
test("the contact form validates input and traps bots", async () => {
  const e = await contactEnv();
  assert.match((await contact(e, { name: "a", message: "b" })).headers.get("Location"), /error=missing/);
  assert.match((await contact(e, { name: "a", email: "bad", message: "b" })).headers.get("Location"), /error=email/);
  assert.match((await contact(e, { name: "a", phone: "1", message: "b", website: "x" })).headers.get("Location"), /sent=1/);
  assert.match((await contact(e, { name: "a", phone: "1", message: "b", started: String(Date.now()) })).headers.get("Location"), /sent=1/);
  assert.equal(e.EMAIL.sent.length, 0);
  assert.match((await contact(e, { name: "a", message: "b" }, "/en/contact")).headers.get("Location"), /^\/en\/contact/);
});
test("the contact form reports a failure when email cannot be sent", async () => {
  const noAddress = { ...env(), EMAIL: mail() };
  assert.match((await contact(noAddress, { name: "a", phone: "1", message: "b" })).headers.get("Location"), /error=send/);
  const e = await contactEnv();
  e.EMAIL = { async send() { throw new Error("no"); } };
  assert.match((await contact(e, { name: "a", phone: "1", message: "b" })).headers.get("Location"), /error=send/);
  const noBinding = await contactEnv();
  delete noBinding.EMAIL;
  assert.match((await contact(noBinding, { name: "a", phone: "1", message: "b" })).headers.get("Location"), /error=send/);
});
test("the contact form stops after the daily limit", async () => {
  const e = await contactEnv();
  await e.IMAGES.put(`contact-count/${new Date().toISOString().slice(0, 10)}`, JSON.stringify({ count: 50 }));
  assert.match((await contact(e, { name: "a", phone: "1", message: "b" })).headers.get("Location"), /error=send/);
  assert.equal(e.EMAIL.sent.length, 0);
});
test("old links, www and robots behave", async () => {
  const e = env();
  for (const [from, to] of [
    [`${SITE}/upload`, `${SITE}/config`],
    [`${WWW}/upload`, `${SITE}/config`],
    [`${WWW}/config`, `${SITE}/config`],
  ]) {
    const r = await worker.fetch(new Request(from, { redirect: "manual" }), e);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("Location"), to);
  }
  const write = new Request(`${WWW}/config/api/settings`, { method: "PUT", body: "{}", redirect: "manual" });
  assert.equal((await worker.fetch(write, e)).status, 302);
  assert.equal(e.IMAGES.items.size, 0);
  assert.match(await (await worker.fetch(new Request(`${WWW}/about`), e)).text(), /rel="canonical" href="https:\/\/ayeletcohenphotography\.com\/about"/);
  assert.match(await html("/robots.txt", e), /Disallow: \/config/);
  const map = await html("/sitemap.xml", e);
  assert.match(map, /\/en\/services\/weddings/);
  assert.doesNotMatch(map, /config/);
  assert.equal((await worker.fetch(new Request(`${SITE}/about`, { method: "POST" }), e)).status, 405);
  assert.equal((await get("/config/other", e)).status, 403);
  assert.equal((await get("/config/other", e, await token())).status, 404);
});
test("certificates are cached", async () => {
  const e = env();
  const t = await token();
  await get("/config", e, t);
  const before = certFetches;
  await get("/config", e, t);
  assert.equal(certFetches, before);
});
