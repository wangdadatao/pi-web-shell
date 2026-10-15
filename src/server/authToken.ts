import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

// @project-doc docs/operations/security.md#auth_token
/**
 * One random token per install, reused across restarts.
 *
 * The file lives in the agent directory (not the session tree) and is forced
 * to mode 0600. It must be a regular file: symlinks are refused so a chmod or
 * rewrite cannot follow them. A corrupt file is replaced by writing a temp
 * file in the same directory and renaming it over the path.
 *
 * The browser learns the value from the startup URL fragment when stdout is a
 * terminal. That fragment is never sent to the server.
 */
export const AUTH_TOKEN_FILENAME = "web-shell-token";

/** 32 bytes, base64url, no padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A token-file problem the operator can fix by changing permissions or removing the path. */
export class AuthTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthTokenError";
  }
}

export function authTokenPath(agentDir: string): string {
  return join(agentDir, AUTH_TOKEN_FILENAME);
}

export async function loadOrCreateAuthToken(agentDir: string): Promise<string> {
  await mkdir(agentDir, { recursive: true });
  const path = authTokenPath(agentDir);
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await readExisting(path);
    if (existing === "missing") {
      const created = await createExclusive(path);
      if (created) return created;
      continue;
    }
    if (existing !== "corrupt") {
      await tightenRegularFile(path);
      return existing;
    }
    return replaceCorrupt(path);
  }
  throw new AuthTokenError(
    `could not create the auth token file at ${path} after repeated attempts. Remove the path and start again.`,
  );
}

async function readExisting(path: string): Promise<string | "missing" | "corrupt"> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    throw new AuthTokenError(unreadableMessage(path, error as NodeJS.ErrnoException));
  }
  if (info.isSymbolicLink()) throw new AuthTokenError(symlinkMessage(path));
  if (!info.isFile()) throw new AuthTokenError(notFileMessage(path));
  try {
    const text = (await readFile(path, "utf8")).trim();
    return TOKEN_PATTERN.test(text) ? text : "corrupt";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    throw new AuthTokenError(unreadableMessage(path, error as NodeJS.ErrnoException));
  }
}

async function createExclusive(path: string): Promise<string | null> {
  const token = randomBytes(32).toString("base64url");
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return null;
    throw new AuthTokenError(unreadableMessage(path, error as NodeJS.ErrnoException));
  }
  try {
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  return token;
}

/**
 * Publish a new token by renaming a temp file over `path`.
 * `rename` replaces the directory entry and does not follow a symlink.
 * A symlink observed via lstat is refused before that rename.
 */
async function replaceCorrupt(path: string): Promise<string> {
  await assertRegularFile(path);
  const token = randomBytes(32).toString("base64url");
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.chmod(0o600);
  } catch (error) {
    await handle.close();
    await rm(tmp, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await assertRegularFile(path);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  await tightenRegularFile(path);
  return token;
}

async function assertRegularFile(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new AuthTokenError(
        `the auth token file at ${path} disappeared while it was being replaced. Start again.`,
      );
    }
    throw new AuthTokenError(unreadableMessage(path, error as NodeJS.ErrnoException));
  }
  if (info.isSymbolicLink()) throw new AuthTokenError(symlinkMessage(path));
  if (!info.isFile()) throw new AuthTokenError(notFileMessage(path));
}

/** fchmod a regular file. O_NOFOLLOW means a symlink swapped in underneath is not chmod'd. */
async function tightenRegularFile(path: string): Promise<void> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EPERM") throw new AuthTokenError(symlinkMessage(path));
    throw new AuthTokenError(unreadableMessage(path, error as NodeJS.ErrnoException));
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new AuthTokenError(notFileMessage(path));
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

function symlinkMessage(path: string): string {
  return (
    `refusing to use ${path}: it is a symbolic link. ` +
    `The link target was not read or modified. Remove the link and start again so a regular token file can be created.`
  );
}

function notFileMessage(path: string): string {
  return (
    `${path} exists but is not a regular file. ` +
    `Remove it and start again so pi-web-shell can create the token file.`
  );
}

function unreadableMessage(path: string, error: NodeJS.ErrnoException): string {
  const why = error.code ?? error.message;
  return (
    `cannot read the auth token file at ${path} (${why}). ` +
    `It must be a regular file this user can read. ` +
    `Fix its permissions (chmod 600) or remove it and start again so a new token can be created.`
  );
}
