// Small-photo storage shared by audits and expenses. The app compresses photos on the phone (≈1280px JPEG),
// so the server only accepts small images (default 1 MB) to keep disk use low on small servers.
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { bad } from "./catalog.js";

export const PHOTO_MAX = Number(process.env.PHOTO_MAX_BYTES || 1024 * 1024);
const MAGIC: [string, (b: Buffer) => boolean][] = [["image/jpeg", b => b[0] === 0xff && b[1] === 0xd8], ["image/png", b => b.subarray(0, 4).toString("hex") === "89504e47"],
  ["image/webp", b => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP"]];
export const smallUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: PHOTO_MAX, files: 1 } });
const dir = () => process.env.UPLOAD_DIR || path.resolve(process.cwd(), "uploads");

/** Validate and save an uploaded image; returns { file, mime, size }. */
export function savePhoto(cid: number, f: Express.Multer.File | undefined, required = true) {
  if (!f) { if (required) throw bad("photo required"); return null; }
  const mime = MAGIC.find(([, ok]) => ok(f.buffer))?.[0]; if (!mime) throw bad("only JPEG, PNG or WebP images");
  const rel = path.join(String(cid), `${crypto.randomUUID()}.${mime.split("/")[1]}`);
  fs.mkdirSync(path.join(dir(), String(cid)), { recursive: true }); fs.writeFileSync(path.join(dir(), rel), f.buffer);
  return { file: rel, mime, size: f.size };
}
export const readPhoto = (rel: string) => fs.readFileSync(path.join(dir(), rel));
/** Tiny valid PNG (1×1) used for labelled sample data. */
export const SAMPLE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPhfDwAEjAH/3h2P6wAAAABJRU5ErkJggg==", "base64");
