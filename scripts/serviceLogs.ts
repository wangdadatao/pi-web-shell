import { chmodSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// @project-doc docs/operations/macos_service.md#service_logs

export const SERVICE_LOG_NAMES = ["stdout.log", "stderr.log"] as const;

/**
 * LaunchAgent logs must not be world-readable.
 * The directory is 0700 and each log is a regular file at 0600.
 * A symlink is removed (the target is not chmod'd) and replaced with a regular file.
 */
export function ensurePrivateLogFiles(logDir: string): void {
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(logDir, 0o700);
  for (const name of SERVICE_LOG_NAMES) {
    ensurePrivateFile(join(logDir, name));
  }
}

function ensurePrivateFile(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${path} is not a regular file; refusing to chmod it`);
  }
  chmodSync(path, 0o600);
}
