import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Canonical key for a session path: symlinks resolved as far up the chain as
 * possible.
 *
 * macOS commonly has symlinked roots (/tmp → /private/tmp). Without
 * normalizing, the same session could be registered twice under two keys —
 * two subprocesses writing one file. For a file that does not exist yet (a
 * reserved-but-unwritten session), the deepest existing ancestor is resolved
 * instead, so the key stays stable before and after the file lands.
 */
export function normalizeSessionKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path; // filesystem root
    try {
      return join(realpathSync(parent), basename(path));
    } catch {
      return resolve(path);
    }
  }
}
