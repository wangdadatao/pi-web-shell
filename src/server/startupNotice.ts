import { isLoopbackBind } from "./hostCheck.ts";

// @project-doc docs/operations/security.md#auth_token
// @project-doc docs/operations/security.md#host_header

export function appOrigin(host: string, port: number): string {
  const formatted = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formatted}:${port}/`;
}

export function tokenizedUrl(host: string, port: number, token: string): string {
  return `${appOrigin(host, port)}#token=${encodeURIComponent(token)}`;
}

/**
 * Startup lines for stdout.
 *
 * `revealToken` is for an interactive terminal only. Logs and pipes must get
 * the bare origin plus where to read the token file, never the token itself.
 */
export function formatStartupBanner(input: {
  host: string;
  port: number;
  sessionsDir: string;
  piBin: string;
  authToken: string;
  tokenPath: string;
  revealToken: boolean;
}): string {
  const url = input.revealToken
    ? tokenizedUrl(input.host, input.port, input.authToken)
    : appOrigin(input.host, input.port);
  const lines = ["", "  pi-web-shell running", `  → ${url}`];
  if (!input.revealToken) {
    lines.push(
      "  access token omitted (stdout is not a terminal, so it is not written to logs).",
      `  read ${input.tokenPath} and open the address above with #token=<file contents>.`,
    );
  }
  lines.push(`  sessions: ${input.sessionsDir}`, `  pi binary: ${input.piBin}`, "");
  return lines.join("\n") + "\n";
}

/** stderr warning when the bind address is not loopback. Null on loopback. */
export function nonLoopbackWarning(host: string): string | null {
  if (isLoopbackBind(host)) return null;
  return (
    [
      "",
      `WARNING: pi-web-shell is listening on ${host}, which is not a loopback address.`,
      "         The server speaks plaintext HTTP. On a LAN (or any shared network) anyone",
      "         who can see the packets can read the access token and API traffic.",
      "         Bind to 127.0.0.1 unless you mean to expose this process.",
      "",
    ].join("\n") + "\n"
  );
}
