import { createHash } from "node:crypto";

export interface StoredImage {
  mimeType: string;
  buffer: Buffer;
  bytes: number;
  width: number | null;
  height: number | null;
}

/**
 * Content-addressed store for images embedded in a transcript.
 *
 * Session files keep images as base64 inside message content. Inlining those in
 * a stream snapshot meant a single screenshot-heavy session shipped ~27 MB to
 * the browser on every open, so instead we hand the client a content hash and
 * serve the bytes from here on demand. The hash doubles as an immutable cache
 * key, so revisiting a session reuses what the browser already has.
 */
export class ImageStore {
  private readonly images = new Map<string, StoredImage>();
  private readonly maxBytes: number;
  private totalBytes = 0;

  constructor(maxBytes = 256 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }

  /** Store the base64 payload and return its content hash. */
  put(base64: string, mimeType: string): string {
    const hash = createHash("sha1").update(base64).digest("hex");
    if (this.images.has(hash)) return hash;

    const buffer = Buffer.from(base64, "base64");
    const dimensions = readImageDimensions(buffer, mimeType);
    this.images.set(hash, {
      mimeType,
      buffer,
      bytes: buffer.length,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    });
    this.totalBytes += buffer.length;
    this.evict();
    return hash;
  }

  get(hash: string): StoredImage | undefined {
    return this.images.get(hash);
  }

  get size(): { count: number; bytes: number } {
    return { count: this.images.size, bytes: this.totalBytes };
  }

  /** Drop oldest entries first; insertion order is the eviction order. */
  private evict(): void {
    const limit = Math.max(this.maxBytes, 1);
    while (this.totalBytes > limit) {
      const oldest = this.images.keys().next();
      if (oldest.done) break;
      const entry = this.images.get(oldest.value);
      this.images.delete(oldest.value);
      if (entry) this.totalBytes -= entry.bytes;
    }
  }
}

const IMAGE_HASH_PATTERN = /^[0-9a-f]{40}$/;

export function isImageHash(value: string): boolean {
  return IMAGE_HASH_PATTERN.test(value);
}

/**
 * Replace every inline image with a hash reference, keeping the payload in the
 * store. Walks message content arrays; anything unrecognised is passed through.
 */
export function stripInlineImages(messages: unknown[], store: ImageStore): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    const record = message as Record<string, unknown>;
    if (!Array.isArray(record["content"])) return message;
    return { ...record, content: record["content"].map((block) => stripBlock(block, store)) };
  });
}

function stripBlock(block: unknown, store: ImageStore): unknown {
  if (!block || typeof block !== "object") return block;
  const record = block as Record<string, unknown>;
  if (record["type"] !== "image") return block;

  const data = record["data"];
  if (typeof data !== "string" || data === "") return block;

  const mimeType = typeof record["mimeType"] === "string" ? record["mimeType"] : "image/png";
  const hash = store.put(data, mimeType);
  const stored = store.get(hash);
  return {
    type: "image",
    hash,
    mimeType,
    width: stored?.width ?? null,
    height: stored?.height ?? null,
    bytes: stored?.bytes ?? null,
  };
}

interface Dimensions {
  width: number;
  height: number;
}

/**
 * Read image dimensions from the file header.
 *
 * Sizes let the client reserve layout space (and label tool-result images)
 * without decoding the whole image. Only the formats pi can produce are
 * handled; anything else returns null.
 */
function readImageDimensions(buffer: Buffer, mimeType: string): Dimensions | null {
  try {
    if (mimeType === "image/png" || buffer.subarray(1, 4).toString("latin1") === "PNG") {
      // 8-byte signature, 4-byte length, "IHDR", then width/height as uint32be.
      if (buffer.length < 24 || buffer.subarray(12, 16).toString("latin1") !== "IHDR") return null;
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }

    if (mimeType === "image/gif" || buffer.subarray(0, 3).toString("latin1") === "GIF") {
      if (buffer.length < 10) return null;
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }

    if (mimeType === "image/jpeg" || buffer[0] === 0xff) {
      return readJpegDimensions(buffer);
    }
  } catch {
    return null;
  }
  return null;
}

/** Walk JPEG segments to the frame header, which carries the dimensions. */
function readJpegDimensions(buffer: Buffer): Dimensions | null {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1] ?? 0;
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry the size.
    const isFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length <= 0) return null;
    offset += 2 + length;
  }
  return null;
}
