import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { loadConfig } from "./config.ts";
import { SessionIndex } from "./sessionIndex.ts";
import { SessionRegistry } from "./sessionRegistry.ts";
import { createApp } from "./httpServer.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const index = new SessionIndex(config.sessionsDir);
  const registry = new SessionRegistry(config);
  const server = createApp({ config, index, registry });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `port ${config.port} is already in use.\n` +
              `  If the LaunchAgent is running, use \`npm run service:restart\` instead of \`npm start\`,\n` +
              `  or check with \`npm run service:status\`.`,
          ),
        );
      } else {
        reject(error);
      }
    });
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address() as AddressInfo;
  const url = `http://${config.host}:${address.port}/`;

  process.stdout.write(
    [
      "",
      "  pi-web-shell running",
      `  → ${url}`,
      `  sessions: ${config.sessionsDir}`,
      `  pi binary: ${config.piBin}`,
      "",
    ].join("\n") + "\n",
  );

  if (config.openBrowser) openBrowser(url);

  const shutdown = async (signal: string) => {
    process.stdout.write(`\n[pi-shell] ${signal} received, shutting down...\n`);
    server.close();
    await registry.disposeAll();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Opening the browser is best-effort.
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[pi-shell] fatal: ${message}\n`);
  if (process.env["PI_SHELL_DEBUG"] && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});
