import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const TEAM_DOMAIN = "https://team.cloudflareaccess.com";
const POLICY_AUD = "test-aud";
const SITE = "https://ayeletcohenphotography.com";
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);
const other = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);
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
      return v ? { body: v.body, httpEtag: '"e1"', httpMetadata: v.httpMetadata } : null;
    },
    async put(k, body, o) { items.set(k, { body, httpMetadata: o.httpMetadata }); },
  };
}
const env = (images = bucket()) => ({ IMAGES: images, TEAM_DOMAIN, POLICY_AUD });
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const post = (t, body = png, headers = {}) => new Request(`${SITE}/upload`, {
  method: "POST", body, headers: { Origin: SITE, ...(t ? { "Cf-Access-Jwt-Assertion": t } : {}), ...headers },
});
const get = (path, t) => new Request(`${SITE}${path}`, { headers: t ? { "Cf-Access-Jwt-Assertion": t } : {} });

test("upload page needs a valid token", async () => {
  assert.equal((await worker.fetch(get("/upload"), env())).status, 403);
  const ok = await worker.fetch(get("/upload", await token()), env());
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /a@example\.com/);
});
test("escapes the email in the page", async () => {
  const r = await worker.fetch(get("/upload", await token({ email: "<b>@x" })), env());
  assert.doesNotMatch(await r.text(), /<b>@x/);
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
    const images = bucket();
    const r = await worker.fetch(post(await build()), env(images));
    assert.equal(r.status, 403);
    assert.equal(images.items.size, 0);
  });
}
test("rejects garbage tokens and missing config", async () => {
  assert.equal((await worker.fetch(post("a.b.c"), env())).status, 403);
  assert.equal((await worker.fetch(post("x"), env())).status, 403);
  const t = await token();
  assert.equal((await worker.fetch(post(t), { IMAGES: bucket(), TEAM_DOMAIN: "", POLICY_AUD: "" })).status, 403);
});
test("no token cannot upload", async () => {
  const images = bucket();
  assert.equal((await worker.fetch(post(null), env(images))).status, 403);
  assert.equal(images.items.size, 0);
});
test("cross-site upload refused", async () => {
  const images = bucket();
  const r = await worker.fetch(post(await token(), png, { Origin: "https://evil.example" }), env(images));
  assert.equal(r.status, 403);
  assert.equal(images.items.size, 0);
});
test("rejects non-images, SVG, empty and oversize", async () => {
  const t = await token();
  assert.equal((await worker.fetch(post(t, new TextEncoder().encode("<svg onload=alert(1)>")), env())).status, 415);
  assert.equal((await worker.fetch(post(t, new Uint8Array(0)), env())).status, 400);
  assert.equal((await worker.fetch(post(t, new Uint8Array(20 * 1024 * 1024 + 1)), env())).status, 413);
});
test("upload then public image, with revalidation", async () => {
  const images = bucket();
  assert.equal((await worker.fetch(get("/image"), env(images))).status, 404);
  assert.equal((await worker.fetch(post(await token()), env(images))).status, 200);
  images.items.get("current-image").body = png;
  const r = await worker.fetch(get("/image"), env(images));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Content-Type"), "image/png");
  assert.equal(r.headers.get("X-Content-Type-Options"), "nosniff");
  const again = new Request(`${SITE}/image`, { headers: { "If-None-Match": '"e1"' } });
  assert.equal((await worker.fetch(again, env(images))).status, 304);
});
test("image is read-only and subpaths stay protected", async () => {
  assert.equal((await worker.fetch(new Request(`${SITE}/image`, { method: "POST", body: png }), env())).status, 405);
  assert.equal((await worker.fetch(get("/upload/x"), env())).status, 403);
  assert.equal((await worker.fetch(get("/upload/x", await token()), env())).status, 404);
});
test("certificates are cached", async () => {
  const before = certFetches;
  const t = await token();
  await worker.fetch(get("/upload", t), env());
  await worker.fetch(get("/upload", t), env());
  assert.equal(certFetches - before, 0);
});
