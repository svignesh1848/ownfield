// Photo storage (local + S3-compatible signing) and the low-disk / temp-cleanup helpers.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localStore, s3Store } from "../src/storage";
import { diskStatus, cleanTemp } from "../src/disk";

describe("photo storage", () => {
  it("local store saves and reads under UPLOAD_DIR, rejects path escapes", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "of-up-")); process.env.UPLOAD_DIR = d;
    const st = localStore(); await st.put("7/a.png", Buffer.from("hi"), "image/png");
    expect((await st.get("7/a.png")).toString()).toBe("hi");
    await expect(st.get("../etc/passwd")).rejects.toThrow();
  });
  it("s3 store sends signed PUT/GET to the bucket (custom endpoint)", async () => {
    const calls: any[] = [];
    const fake = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return new Response(init.method === "GET" ? "img" : "", { status: 200 }); }) as any;
    const st = s3Store({ bucket: "b", region: "auto", endpoint: "https://r2.example.com/", accessKeyId: "AK", secretAccessKey: "SK", prefix: "photos" }, fake);
    await st.put("3/x.jpg", Buffer.from("x"), "image/jpeg");
    expect((await st.get("3/x.jpg")).toString()).toBe("img");
    expect(calls[0].url).toBe("https://r2.example.com/b/photos/3/x.jpg");
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });
  it("s3 store uses virtual-host AWS URL without endpoint and surfaces errors", async () => {
    const st = s3Store({ bucket: "bk", region: "ap-south-1", accessKeyId: "A", secretAccessKey: "S" }, (async (u: any) => { expect(String(u)).toBe("https://bk.s3.ap-south-1.amazonaws.com/1/y.png"); return new Response("", { status: 403 }); }) as any);
    await expect(st.get("1/y.png")).rejects.toThrow(/403/);
  });
});

describe("disk", () => {
  it("reports free space and low flag", () => {
    const d = diskStatus(os.tmpdir())!; expect(d.freePct).toBeGreaterThanOrEqual(0); expect(typeof d.low).toBe("boolean");
  });
  it("cleans only old files in the temp folder, never uploads", () => {
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "of-up-")); process.env.UPLOAD_DIR = up;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "of-tmp-"));
    fs.writeFileSync(path.join(tmp, "old"), "x"); fs.writeFileSync(path.join(tmp, "new"), "x");
    const old = Date.now() / 1000 - 3 * 86400; fs.utimesSync(path.join(tmp, "old"), old, old);
    fs.writeFileSync(path.join(up, "photo.jpg"), "x"); fs.utimesSync(path.join(up, "photo.jpg"), old, old);
    expect(cleanTemp(86400_000, tmp)).toBe(1);
    expect(fs.existsSync(path.join(tmp, "new"))).toBe(true);
    expect(cleanTemp(0, up)).toBe(0); // upload folder is refused
    expect(fs.existsSync(path.join(up, "photo.jpg"))).toBe(true);
  });
});
