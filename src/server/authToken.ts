import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

// @project-doc docs/operations/security.md#auth_token
/**
 * One random token per install, reused across restarts.
 *
 * The file lives in the agent directory (not the session tree) and is forced
 * to mode 0600. The browser learns the value from the startup URL fragment,
 * which is never sent to the server and is not part of request logs.
 */
export const AUTH_TOKEN_FILENAME = "web-shell-token";

/** 32 bytes, base64url, no padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function authTokenPath(agentDir: string): string {
  return join(agentDir, AUTH_TOKEN_FILENAME);
}

export async function loadOrCreateAuthToken(agentDir: string): Promise<string> {
  await mkdir(agentDir, { recursive: true });
  const path = authTokenPath(agentDir);
  const existing = await readValidToken(path);
  if (existing) {
    await chmod(path, 0o600);
    return existing;
  }

  const token = randomBytes(32).toString("base64url");
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${token}\n`, "utf8");
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    return token;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    const raced = await readValidToken(path);
    if (raced) {
      await chmod(path, 0o600);
      return raced;
    }
    const handle = await open(path, "w", 0o600);
    try {
      await handle.writeFile(`${token}\n`, "utf8");
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    return token;
  }
}

async function readValidToken(path: string): Promise<string | null> {
  try {
    const text = (await readFile(path, "utf8")).trim();
    return TOKEN_PATTERN.test(text) ? text : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
