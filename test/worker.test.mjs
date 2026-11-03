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
const publicSite = async (e) => (await get("/api/site", e)).json();
async function albumWithPhoto(e) {
  const created = await (await api(e, "POST", "/config/api/albums", { name: "Weddings" })).json();
  const album = created.albums.at(-1);
  const updated = await (await api(e, "POST", `/config/api/albums/${album.id}/photos`, png)).json();
  return { albumId: album.id, photoId: updated.albums.at(-1).photos[0] };
}

test("config page needs a valid token and escapes the email", async () => {
  const e = env();
  assert.equal((await get("/config", e)).status, 403);
  const ok = await get("/config", e, await token({ email: "<b>@x" }));
  assert.equal(ok.status, 200);
  assert.doesNotMatch(await ok.text(), /<b>@x/);
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
    assert.equal((await api(e, "POST", "/config/api/albums", { name: "x" }, { auth: await build() })).status, 403);
    assert.equal(e.IMAGES.items.size, 0);
  });
}
test("every API route refuses a missing token, garbage token and missing config", async () => {
  const e = env();
  const id = crypto.randomUUID();
  for (const [method, path, body] of [
    ["PUT", "/config/api/profile", {}],
    ["POST", "/config/api/albums", { name: "x" }],
    ["DELETE", `/config/api/albums/${id}`],
    ["POST", `/config/api/albums/${id}/photos`, png],
    ["DELETE", `/config/api/photos/${id}`],
  ]) {
    assert.equal((await api(e, method, path, body, { auth: null })).status, 403, path);
    assert.equal((await api(e, method, path, body, { auth: "a.b.c" })).status, 403, path);
  }
  const unset = { IMAGES: bucket(), TEAM_DOMAIN: "", POLICY_AUD: "" };
  assert.equal((await api(unset, "POST", "/config/api/albums", { name: "x" })).status, 403);
  assert.equal(e.IMAGES.items.size, 0);
});
test("cross-site writes are refused", async () => {
  const e = env();
  assert.equal((await api(e, "POST", "/config/api/albums", { name: "x" }, { origin: "https://evil.example" })).status, 403);
  assert.equal(e.IMAGES.items.size, 0);
});
test("contact details are validated and normalized", async () => {
  const e = env();
  const save = (phone, instagram) => api(e, "PUT", "/config/api/profile", { phone, instagram });
  assert.equal((await save("not a phone", "")).status, 400);
  assert.equal((await save("", "https://evil.example/x")).status, 400);
  assert.equal((await save("", "javascript:alert(1)")).status, 400);
  for (const input of ["ayelet.photo", "@ayelet.photo", "instagram.com/ayelet.photo", "https://www.instagram.com/ayelet.photo/?hl=he"]) {
    assert.equal((await save("050-123-4567", input)).status, 200, input);
    const site = await publicSite(e);
    assert.equal(site.instagram, "https://www.instagram.com/ayelet.photo/");
    assert.equal(site.phone, "050-123-4567");
  }
  assert.equal((await save("", "")).status, 200);
  assert.equal((await publicSite(e)).phone, "");
});
test("album names are validated", async () => {
  const e = env();
  assert.equal((await api(e, "POST", "/config/api/albums", { name: "  " })).status, 400);
  assert.equal((await api(e, "POST", "/config/api/albums", { name: "x".repeat(61) })).status, 400);
  assert.equal((await api(e, "POST", "/config/api/albums", "not json")).status, 400);
});
test("photos are checked before storing", async () => {
  const e = env();
  const { albumId } = await albumWithPhoto(e);
  const add = (body) => api(e, "POST", `/config/api/albums/${albumId}/photos`, body);
  assert.equal((await add(new TextEncoder().encode("<svg onload=alert(1)>"))).status, 415);
  assert.equal((await add(new Uint8Array(0))).status, 400);
  assert.equal((await add(new Uint8Array(20 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await api(e, "POST", `/config/api/albums/${crypto.randomUUID()}/photos`, png)).status, 404);
  assert.equal((await publicSite(e)).albums[0].photos.length, 1);
});
test("uploaded photos are public with safe headers and revalidate", async () => {
  const e = env();
  const { photoId } = await albumWithPhoto(e);
  const r = await get(`/photos/${photoId}`, e);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Content-Type"), "image/png");
  assert.equal(r.headers.get("X-Content-Type-Options"), "nosniff");
  const again = await worker.fetch(new Request(`${SITE}/photos/${photoId}`, { headers: { "If-None-Match": '"e1"' } }), e);
  assert.equal(again.status, 304);
  assert.equal((await worker.fetch(new Request(`${SITE}/photos/${photoId}`, { method: "POST", body: png }), e)).status, 405);
  assert.equal((await worker.fetch(new Request(`${SITE}/api/site`, { method: "POST", body: "{}" }), e)).status, 405);
  assert.equal((await get("/photos/site.json", e)).status, 404);
});
test("deleting a photo removes it from the site and storage", async () => {
  const e = env();
  const { photoId } = await albumWithPhoto(e);
  assert.equal((await api(e, "DELETE", `/config/api/photos/${photoId}`)).status, 200);
  assert.deepEqual((await publicSite(e)).albums[0].photos, []);
  assert.equal(e.IMAGES.items.has(`photos/${photoId}`), false);
  assert.equal((await get(`/photos/${photoId}`, e)).status, 404);
  assert.equal((await api(e, "DELETE", `/config/api/photos/${photoId}`)).status, 404);
});
test("deleting an album removes its photos only", async () => {
  const e = env();
  const first = await albumWithPhoto(e);
  const second = await albumWithPhoto(e);
  assert.equal((await api(e, "DELETE", `/config/api/albums/${first.albumId}`)).status, 200);
  const site = await publicSite(e);
  assert.deepEqual(site.albums.map((a) => a.id), [second.albumId]);
  assert.equal(e.IMAGES.items.has(`photos/${first.photoId}`), false);
  assert.equal(e.IMAGES.items.has(`photos/${second.photoId}`), true);
});
test("the existing uploaded photo moves into a Photos album", async () => {
  const e = env();
  await e.IMAGES.put("current-image", png, { httpMetadata: { contentType: "image/png" } });
  const site = await publicSite(e);
  assert.equal(site.albums[0].name, "Photos");
  const id = site.albums[0].photos[0];
  assert.equal((await get(`/photos/${id}`, e)).headers.get("Content-Type"), "image/png");
  assert.equal(e.IMAGES.items.has("current-image"), false);
  assert.deepEqual((await publicSite(e)).albums[0].photos, [id]);
});
test("old upload links and www go to config on the main domain", async () => {
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
  const write = new Request(`${WWW}/config/api/albums`, { method: "POST", body: "{}", redirect: "manual" });
  assert.equal((await worker.fetch(write, e)).status, 302);
  assert.equal(e.IMAGES.items.size, 0);
  assert.equal((await worker.fetch(new Request(`${WWW}/api/site`), e)).status, 200);
});
test("unknown routes stay closed", async () => {
  const e = env();
  assert.equal((await get("/config/other", e)).status, 403);
  assert.equal((await get("/config/other", e, await token())).status, 404);
  assert.equal((await get("/image", e)).status, 404);
});
test("certificates are cached", async () => {
  const e = env();
  const t = await token();
  await get("/config", e, t);
  const before = certFetches;
  await get("/config", e, t);
  assert.equal(certFetches, before);
});
