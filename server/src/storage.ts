// Pluggable photo storage. Default: local disk (UPLOAD_DIR). Optional: any S3-compatible bucket
// (AWS S3, Cloudflare R2, MinIO, Wasabi…) when PHOTO_STORAGE=s3. No SDK — plain HTTPS with AWS Signature V4.
//   PHOTO_STORAGE=s3, S3_BUCKET, S3_REGION (default us-east-1), S3_ENDPOINT (optional, e.g. https://<id>.r2.cloudflarestorage.com),
//   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_PREFIX (optional key prefix).
// Reads fall back to local disk, so photos saved before switching to S3 keep working.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

export interface PhotoStore { name: string; put(key: string, body: Buffer, mime: string): Promise<void>; get(key: string): Promise<Buffer>; }

const canWrite = (d: string) => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } };
/** Where local photos go. UPLOAD_DIR wins. Otherwise ./uploads, but only if the app may write there: on servers the
 *  release folder is often read-only for the service user (and replaced on every deploy), which made every photo
 *  upload fail. Then photos go to <home of the service user>/uploads, which is writable and survives deploys. */
export function resolveUploadDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), home = os.homedir(), writable = canWrite) {
  if (env.UPLOAD_DIR) return env.UPLOAD_DIR;
  const local = path.resolve(cwd, "uploads");
  if (fs.existsSync(local) ? writable(local) : writable(cwd)) return local;
  return path.join(home, "uploads");
}
let warned = false;
export const uploadDir = () => {
  const d = resolveUploadDir();
  if (!process.env.UPLOAD_DIR && !warned && d !== path.resolve(process.cwd(), "uploads")) { warned = true; console.warn(`photos: ./uploads is not writable, saving photos in ${d} (set UPLOAD_DIR to choose)`); }
  return d;
};
const safe = (key: string) => { const k = path.normalize(key); if (k.startsWith("..") || path.isAbsolute(k)) throw new Error("bad photo key"); return k; };

export const localStore = (): PhotoStore => ({
  name: "local",
  async put(key, body) { const f = path.join(uploadDir(), safe(key)); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); },
  async get(key) { return fs.readFileSync(path.join(uploadDir(), safe(key))); },
});

const hmac = (k: Buffer | string, s: string) => crypto.createHmac("sha256", k).update(s).digest();
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

export function s3Store(o: { bucket: string; region: string; endpoint?: string; accessKeyId: string; secretAccessKey: string; prefix?: string }, fetchFn: typeof fetch = fetch): PhotoStore {
  const base = o.endpoint ? `${o.endpoint.replace(/\/$/, "")}/${o.bucket}` : `https://${o.bucket}.s3.${o.region}.amazonaws.com`;
  const keyOf = (k: string) => (o.prefix ? o.prefix.replace(/\/$/, "") + "/" : "") + safe(k).split(path.sep).join("/");
  async function req(method: string, key: string, body?: Buffer, mime?: string) {
    const url = new URL(`${base}/${keyOf(key).split("/").map(encodeURIComponent).join("/")}`);
    const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, ""), day = now.slice(0, 8);
    const hash = sha(body ?? ""), h: Record<string, string> = { host: url.host, "x-amz-content-sha256": hash, "x-amz-date": now };
    if (mime) h["content-type"] = mime;
    const names = Object.keys(h).sort(), scope = `${day}/${o.region}/s3/aws4_request`;
    const creq = [method, url.pathname, "", ...names.map(n => `${n}:${h[n]}`), "", names.join(";"), hash].join("\n");
    const sts = ["AWS4-HMAC-SHA256", now, scope, sha(creq)].join("\n");
    const kS = hmac(hmac(hmac(hmac("AWS4" + o.secretAccessKey, day), o.region), "s3"), "aws4_request");
    const auth = `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${hmac(kS, sts).toString("hex")}`;
    const { host: _h, ...send } = h;
    const r = await fetchFn(url, { method, headers: { ...send, authorization: auth }, body: body as any });
    if (!r.ok) throw Object.assign(new Error(`S3 ${method} failed: ${r.status}`), { status: r.status });
    return r;
  }
  return { name: "s3", async put(k, b, m) { await req("PUT", k, b, m); }, async get(k) { return Buffer.from(await (await req("GET", k)).arrayBuffer()); } };
}

let store: PhotoStore | null = null;
export function photoStore(): PhotoStore {
  if (store) return store;
  const e = process.env;
  if ((e.PHOTO_STORAGE || "local") === "s3") {
    if (!e.S3_BUCKET || !e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY) { console.error("PHOTO_STORAGE=s3 but S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY missing — using local disk"); return store = localStore(); }
    const s3 = s3Store({ bucket: e.S3_BUCKET, region: e.S3_REGION || "us-east-1", endpoint: e.S3_ENDPOINT, accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY, prefix: e.S3_PREFIX });
    const local = localStore();
    return store = { name: "s3", put: s3.put, async get(k) { try { return await s3.get(k); } catch (err) { try { return await local.get(k); } catch { throw err; } } } };
  }
  return store = localStore();
}
export const setPhotoStore = (s: PhotoStore | null) => { store = s; };
