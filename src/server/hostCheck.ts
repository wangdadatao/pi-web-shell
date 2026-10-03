/**
 * Host-header validation against DNS rebinding.
 *
 * The server binds to loopback and has no authentication: any web page can
 * try to talk to it. Same-origin policy normally stops a remote page from
 * reading responses, but DNS rebinding (a domain whose A record flips to
 * 127.0.0.1 after the page loaded) defeats that. Checking that the Host
 * header is actually a loopback name closes the hole: a rebound domain would
 * arrive with its own name in Host.
 *
 * Only enforced when the bind address is loopback — binding to a LAN address
 * is an explicit opt-out of the local-only threat model, and LAN clients
 * would legitimately send the LAN address in Host.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopbackBind(bindHost: string): boolean {
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
