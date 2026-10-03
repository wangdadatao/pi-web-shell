import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadLocalImage, sniffImageMime } from "../src/server/localImage.ts";

// 1x1 transparent PNG (real bytes, so the whole pipeline runs on valid input).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\xff\x00,", "latin1");
const WEBP = Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 \x10\x00\x00\x00", "latin1");

describe("sniffImageMime", () => {
  it("recognizes png/jpeg/gif/webp by magic bytes", () => {
    assert.equal(sniffImageMime(PNG), "image/png");
    assert.equal(sniffImageMime(JPEG), "image/jpeg");
    assert.equal(sniffImageMime(GIF), "image/gif");
    assert.equal(sniffImageMime(WEBP), "image/webp");
  });

  it("rejects text and truncated headers regardless of extension", () => {
    assert.equal(sniffImageMime(Buffer.from("#!/bin/sh\nsecret")), null);
    assert.equal(sniffImageMime(Buffer.from("RIFF____MPEG")), null); // RIFF but not WEBP
    assert.equal(sniffImageMime(Buffer.alloc(0)), null);
    assert.equal(sniffImageMime(PNG.subarray(0, 4)), null); // truncated signature
  });
});

describe("loadLocalImage", () => {
  it("serves a real png with mime type and etag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-img-"));
    const file = join(dir, "pic.png");
    await writeFile(file, PNG);
    const result = await loadLocalImage(file);
    assert.ok(result.ok);
    assert.equal(result.mimeType, "image/png");
    assert.match(result.etag, /^"\d+-\d+"$/);
    assert.ok(result.buffer.equals(PNG));
  });

  it("sniffs content, not the extension", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-img-"));
    const disguised = join(dir, "totally-a-picture.png");
    await writeFile(disguised, "-----BEGIN RSA PRIVATE KEY-----\n...");
    const result = await loadLocalImage(disguised);
    assert.ok(!result.ok);
    assert.equal(result.status, 415);
  });

  it("rejects relative and empty paths", async () => {
    const relative = await loadLocalImage("images/pic.png");
    assert.ok(!relative.ok);
    assert.equal(relative.status, 400);
    const empty = await loadLocalImage("  ");
    assert.ok(!empty.ok);
    assert.equal(empty.status, 400);
  });

  it("returns 404 for missing files and directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-img-"));
    const missing = await loadLocalImage(join(dir, "nope.png"));
    assert.ok(!missing.ok);
    assert.equal(missing.status, 404);

    const inner = join(dir, "sub");
    await mkdir(inner);
    const asDirectory = await loadLocalImage(inner);
    assert.ok(!asDirectory.ok);
    assert.equal(asDirectory.status, 404);
  });
});
