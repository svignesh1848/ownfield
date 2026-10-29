// Small-photo storage shared by audits and expenses. The app compresses photos on the phone (≈1280px JPEG),
// so the server only accepts small images (default 1 MB) to keep disk use low on small servers.
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import { bad } from "./catalog.js";
import { photoStore } from "./storage.js";

export const PHOTO_MAX = Number(process.env.PHOTO_MAX_BYTES || 1024 * 1024);
const MAGIC: [string, (b: Buffer) => boolean][] = [["image/jpeg", b => b[0] === 0xff && b[1] === 0xd8], ["image/png", b => b.subarray(0, 4).toString("hex") === "89504e47"],
  ["image/webp", b => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP"]];
export const smallUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: PHOTO_MAX, files: 1 } });

/** Validate and save (through the photo store: local disk or S3) an uploaded image; returns { file, mime, size }. */
export async function savePhoto(cid: number, f: Express.Multer.File | undefined, required = true) {
  if (!f) { if (required) throw bad("photo required"); return null; }
  const mime = MAGIC.find(([, ok]) => ok(f.buffer))?.[0]; if (!mime) throw bad("only JPEG, PNG or WebP images");
  const rel = path.join(String(cid), `${crypto.randomUUID()}.${mime.split("/")[1]}`);
  await photoStore().put(rel, f.buffer, mime);
  return { file: rel, mime, size: f.size };
}
export const readPhoto = (rel: string) => photoStore().get(rel);
/** Tiny valid PNG (1×1) used for labelled sample data. */
export const SAMPLE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPhfDwAEjAH/3h2P6wAAAABJRU5ErkJggg==", "base64");
