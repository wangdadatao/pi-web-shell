import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/** Refuse absurdly large files: model-generated images are a few MB at most. */
const MAX_LOCAL_IMAGE_BYTES = 64 * 1024 * 1024;

export type LocalImageResult =
  | { ok: true; buffer: Buffer; mimeType: string; etag: string }
  | { ok: false; status: 400 | 404 | 413 | 415; error: string };

/**
 * Load an image from an absolute filesystem path, for the `/api/local-image`
 * endpoint that backs local images in assistant Markdown (`![alt](/abs/x.png)`).
 *
 * The type is decided by magic bytes, never by extension: that is what keeps
 * this endpoint from turning into an arbitrary-file read. Only actual
 * PNG/JPEG/GIF/WEBP bytes can ever leave the process, and the server itself
 * only listens on 127.0.0.1.
 */
export async function loadLocalImage(rawPath: string): Promise<LocalImageResult> {
  const requested = rawPath.trim();
  if (requested === "" || !isAbsolute(requested)) {
    return { ok: false, status: 400, error: "path must be absolute" };
  }

  let resolved: string;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    resolved = await realpath(resolve(requested));
    info = await stat(resolved);
  } catch {
    return { ok: false, status: 404, error: "file not found" };
  }
  if (!info.isFile()) return { ok: false, status: 404, error: "not a file" };
  if (info.size > MAX_LOCAL_IMAGE_BYTES) {
    return { ok: false, status: 413, error: `image too large (${info.size} bytes)` };
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(resolved);
  } catch {
    return { ok: false, status: 404, error: "file not found" };
  }

  const mimeType = sniffImageMime(buffer);
  if (!mimeType) return { ok: false, status: 415, error: "not an image (png/jpeg/gif/webp)" };

  return {
    ok: true,
    buffer,
    mimeType,
    // mtime+size is enough for a local file: cheap to compute, changes on rewrite.
    etag: `"${info.size}-${Math.round(info.mtimeMs)}"`,
  };
}

/** Identify an image by its leading bytes. Extensions prove nothing. */
export function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 24 && buffer.subarray(0, 8).toString("latin1") === "\x89PNG\r\n\x1a\n") {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString("latin1") === "GIF89a") {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}
