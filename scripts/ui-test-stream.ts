/**
 * UI assertions for live (streaming) Markdown rendering.
 *
 *   PI_SHELL_SESSIONS_DIR=/tmp/x PI_SHELL_PORT=4755 PI_SHELL_OPEN_BROWSER=0 \
 *     node src/server/index.ts &
 *   node scripts/ui-test-stream.ts http://127.0.0.1:4755/
 *
 * Feeds synthetic agent events through `piShellDebug.handleEvent`, so it needs no
 * model calls and never touches a real session. Proves that formatting appears
 * while the reply is still streaming, that an open code fence stays literal, and
 * that `text_end` collapses the incremental DOM into the normal render.
 * Exits non-zero on the first failed assertion.
 */

import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:4711/";

const CHROME_CANDIDATES = [
	process.env.CHROME_BIN,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter((v): v is string => Boolean(v));

class Cdp {
	private readonly socket: WebSocket;
	private nextId = 1;
	private readonly pending = new Map<number, (v: unknown) => void>();
	private readonly handlers = new Map<string, Array<(params: unknown) => void>>();

	constructor(socket: WebSocket) {
		this.socket = socket;
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as {
				id?: number;
				method?: string;
				params?: unknown;
				result?: unknown;
				error?: { message?: string };
			};
			if (message.method) {
				for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
			}
			if (message.id === undefined) return;
			const resolve = this.pending.get(message.id);
			if (!resolve) return;
			this.pending.delete(message.id);
			if (message.error) throw new Error(message.error.message ?? "cdp error");
			resolve(message.result);
		});
	}

	on(method: string, handler: (params: unknown) => void): void {
		const list = this.handlers.get(method) ?? [];
		list.push(handler);
		this.handlers.set(method, list);
	}

	static async connect(url: string): Promise<Cdp> {
		const socket = new WebSocket(url);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
		});
		return new Cdp(socket);
	}

	send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve) => {
			this.pending.set(id, resolve as (v: unknown) => void);
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	close(): void {
		this.socket.close();
	}
}

async function findChrome(): Promise<string> {
	const { access } = await import("node:fs/promises");
	for (const candidate of CHROME_CANDIDATES) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// try next
		}
	}
	throw new Error("Chrome not found; set CHROME_BIN");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (res.ok) return;
		} catch {
			// not up yet
		}
		await sleep(150);
	}
	throw new Error("Chrome DevTools endpoint did not come up");
}

let failed = false;
function ok(cond: unknown, label: string): boolean {
	const pass = Boolean(cond);
	console.log(`${pass ? "PASS" : "FAIL"}: ${label}`);
	if (!pass) failed = true;
	return pass;
}

/**
 * The page-side driver. Renders are batched into an animation frame, so each
 * step waits for one before reading the DOM. The fence characters are built
 * with `String.fromCharCode(96)` to keep the outer template literal readable.
 */
const DRIVE = `(async () => {
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	for (let i = 0; i < 40 && !window.piShellDebug; i += 1) await wait(100);
	const D = window.piShellDebug;
	const send = (event) => D.handleEvent(event);
	const delta = (text) => send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
	const frame = () => wait(150);
	const tick = String.fromCharCode(96);
	const fence = tick + tick + tick;
	const count = (sel) => document.querySelectorAll(sel).length;
	const out = {};

	send({ type: "agent_start" });
	send({ type: "message_start", message: { role: "assistant", content: [] } });

	// A heading is committed by the blank line and shows mid-stream.
	delta("# Hello\\n\\n");
	await frame();
	out.heading = count(".live-text .live-md h1");
	out.headingText = document.querySelector(".live-text h1")?.textContent ?? null;

	// A half-typed ** is not bold yet; it becomes bold when closed.
	delta("world **bo");
	await frame();
	out.partialStrong = count(".live-text strong");
	delta("ld**\\n\\n");
	await frame();
	out.strong = count(".live-text strong");

	// An open fence stays literal rather than swallowing the rest.
	delta(fence + "js\\nconst x = 1;\\n");
	await frame();
	out.openFencePlain = Boolean(document.querySelector(".live-text .live-tail.plain"));
	out.openFenceCode = count(".live-text .code-block");

	// Closing it commits a highlighted code block.
	delta(fence + "\\n\\n");
	await frame();
	out.closedFenceCode = count(".live-text .code-block");
	out.closedFencePlain = Boolean(document.querySelector(".live-text .live-tail.plain"));

	// A loose list stays one list, so ordered numbering does not restart.
	delta("1. one\\n\\n");
	await frame();
	delta("2. two\\n\\n");
	await frame();
	out.listItems = count(".live-text .live-md ol li");

	// text_end replaces the scaffolding with the authoritative full render.
	const full = "# Hello\\n\\nworld **bold**\\n\\n" + fence + "js\\nconst x = 1;\\n" + fence + "\\n\\n1. one\\n\\n2. two\\n";
	send({ type: "message_update", assistantMessageEvent: { type: "text_end", content: full } });
	await frame();
	out.afterEndChunks = count(".live-text .live-chunk");
	out.afterEndMd = count(".live-text .md");
	out.afterEndH1 = count(".live-text h1");
	out.afterEndOl = count(".live-text ol li");

	return out;
})()`;

async function main(): Promise<void> {
	const chromeBin = await findChrome();
	const port = 9000 + Math.floor(Math.random() * 900);
	const profile = await mkdtemp(join(tmpdir(), "pi-ui-stream-"));
	const child = spawn(
		chromeBin,
		[
			"--headless=new",
			"--disable-gpu",
			"--no-sandbox",
			"--no-first-run",
			"--no-default-browser-check",
			"--hide-scrollbars",
			`--user-data-dir=${profile}`,
			`--remote-debugging-port=${port}`,
			"about:blank",
		],
		{ stdio: "ignore", detached: false },
	);

	const hardTimeout = setTimeout(() => {
		child.kill("SIGKILL");
		process.stderr.write("ui-test timed out after 60s\n");
		process.exit(1);
	}, 60_000);

	try {
		await waitForPort(port);
		const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
			type: string;
			webSocketDebuggerUrl?: string;
		}>;
		const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
		if (!page?.webSocketDebuggerUrl) throw new Error("no page target");

		const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
		const pageErrors: string[] = [];
		await cdp.send("Runtime.enable");
		cdp.on("Runtime.exceptionThrown", (params) => {
			const details = (params as { exceptionDetails?: { text?: string; exception?: { description?: string } } })
				.exceptionDetails;
			pageErrors.push(details?.exception?.description ?? details?.text ?? "unknown exception");
		});
		await cdp.send("Page.enable");
		await cdp.send("Emulation.setDeviceMetricsOverride", {
			width: 1440,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await cdp.send("Page.navigate", { url: BASE });
		await sleep(2500);

		const result = await cdp.send<{ result: { value?: Record<string, unknown> }; exceptionDetails?: { text?: string } }>(
			"Runtime.evaluate",
			{ expression: DRIVE, returnByValue: true, awaitPromise: true },
		);
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "driver threw");
		const out = result.result.value as Record<string, any>;

		ok(out.heading === 1, `heading renders mid-stream (${out.heading})`);
		ok(out.headingText === "Hello", `heading text is formatted (${out.headingText})`);
		ok(out.partialStrong === 0, "half-typed ** is not bold yet");
		ok(Number(out.strong) >= 1, "bold appears as soon as ** closes, still streaming");
		ok(out.openFencePlain === true, "an open fence is shown literally");
		ok(out.openFenceCode === 0, "an open fence does not create a code block yet");
		ok(Number(out.closedFenceCode) >= 1, "closing the fence commits a highlighted code block");
		ok(out.closedFencePlain === false, "the committed fence is no longer the live tail");
		ok(out.listItems === 2, `a loose list keeps both items (${out.listItems})`);
		ok(out.afterEndChunks === 0, "text_end drops the incremental scaffolding");
		ok(out.afterEndMd === 1, "text_end leaves a single .md block");
		ok(out.afterEndH1 === 1 && out.afterEndOl === 2, "text_end renders the authoritative Markdown");

		ok(pageErrors.length === 0, `no page exceptions (got ${pageErrors.length}${pageErrors.length ? ": " + pageErrors[0] : ""})`);

		cdp.close();
	} finally {
		clearTimeout(hardTimeout);
		child.kill("SIGKILL");
	}

	if (failed) process.exit(1);
	console.log("all streaming-markdown assertions passed");
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
