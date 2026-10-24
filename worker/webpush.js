/* Web Push（RFC 8291 aes128gcm ＋ RFC 8292 VAPID），只用 WebCrypto，可在 Cloudflare Worker 與 Node 22 執行。
 * 用法：
 *   const vapid = await ensureVapid(kv)            // KV 內沒有金鑰就自動產生（JWK）並存起來
 *   await sendPush(subscription, JSON.stringify(payload), vapid, { ttl: 3600, urgency: 'high' })
 */
const te = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const concat = (...parts) => { const n = parts.reduce((a, p) => a + p.byteLength, 0); const out = new Uint8Array(n); let o = 0; parts.forEach(p => { out.set(new Uint8Array(p), o); o += p.byteLength; }); return out; };

export async function generateVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey), priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey); // 65 bytes，給瀏覽器 applicationServerKey 用
  return { publicKey: b64u(raw), jwkPublic: pub, jwkPrivate: priv };
}

export async function ensureVapid(kv) {
  let v = kv ? JSON.parse((await kv.get('vapid')) || 'null') : null;
  if (!v) { v = await generateVapid(); if (kv) await kv.put('vapid', JSON.stringify(v)); }
  return v;
}

async function vapidHeader(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject || 'mailto:noreply@example.com' })));
  const key = await crypto.subtle.importKey('jwk', vapid.jwkPrivate, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(`${header}.${claims}`)); // 64 bytes r||s，正是 JWS 要的格式
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** 加密 payload（字串或 Uint8Array）成 aes128gcm body */
export async function encrypt(subscription, payload) {
  const uaPub = unb64u(subscription.keys.p256dh), auth = unb64u(subscription.keys.auth);
  const data = typeof payload === 'string' ? te.encode(payload) : payload;
  const asKey = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', asKey.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKey.privateKey, 256));
  const keyInfo = concat(te.encode('WebPush: info\0'), uaPub, asPub);
  const ikm = await hkdf(auth, ecdh, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const padded = concat(data, new Uint8Array([2])); // 最後一筆記錄的分隔符
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, padded));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

/** 送出推播；回傳 {ok, status, gone}（gone＝訂閱已失效，應刪除） */
export async function sendPush(subscription, payload, vapid, opts) {
  const o = opts || {};
  const body = await encrypt(subscription, payload);
  const r = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'aes128gcm', 'ttl': String(o.ttl != null ? o.ttl : 3600), 'urgency': o.urgency || 'normal', 'authorization': await vapidHeader(subscription.endpoint, vapid, o.subject) },
    body,
  });
  return { ok: r.ok, status: r.status, gone: r.status === 404 || r.status === 410 };
}
