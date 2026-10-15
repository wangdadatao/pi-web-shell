// @project-doc docs/operations/security.md#host_header
/**
 * Host-header validation against DNS rebinding.
 *
 * DNS rebinding (a domain whose A record flips to 127.0.0.1 after the page
 * loaded) would otherwise present a non-loopback name in Host while talking
 * to a loopback socket. Checking that Host is actually a loopback name
 * closes that hole.
 *
 * Only enforced when the bind address is loopback. Binding to a LAN address
 * is an explicit opt-out of that check, because LAN clients legitimately
 * send the LAN address in Host. Token and Origin checks still apply there;
 * this function does not decide those.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackBind(bindHost: string): boolean {
  return bindHost === "localhost" || bindHost === "::1" || bindHost.startsWith("127.");
}

/** Strip an optional `:port` suffix, keeping IPv6 brackets intact. */
function stripPort(host: string): string {
  return host.replace(/:\d+$/, "");
}

export function isHostAllowed(hostHeader: string | undefined, bindHost: string): boolean {
  if (!isLoopbackBind(bindHost)) return true;
  if (!hostHeader) return false;
  const host = stripPort(hostHeader.trim().toLowerCase());
  return LOOPBACK_HOSTS.has(host);
}
