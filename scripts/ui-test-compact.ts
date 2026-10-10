/**
 * UI assertions for the built-in `/compact` (POST /api/compact).
 *
 *   PI_SHELL_SESSIONS_DIR=/tmp/x PI_SHELL_PORT=0 PI_SHELL_OPEN_BROWSER=0 \
 *     node src/server/index.ts &
 *   node scripts/ui-test-compact.ts http://127.0.0.1:<port>/
 *
 * pi's `prompt` RPC does not execute built-in TUI commands, so the shell owns
 * `/compact`: it appends the command to the composer menu, intercepts it in
 * `sendMessage` (before it can become a chat message), and reports the outcome
 * from the `compaction_*` stream events. The server route's own branches
 * (404 / 409 running / 409 concurrent / timeout / failure) are pinned by
 * test/httpServerCompact.test.ts — this script guards the browser contract.
 *
 * Headless Chrome over CDP, same zero-dependency approach as the other
 * ui-tests. Exits non-zero on the first failed assertion.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? null;

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
		this.handlers.set(method, list);
		list.push(handler);
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
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`cdp timeout: ${method}`)), 30000);
			this.pending.set(id, (value) => {
				clearTimeout(timer);
				resolve(value as T);
			});
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	close(): void {
		this.socket.close();
	}
}

async function findChrome(): Promise<string> {
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

const DRIVE = `(async () => {
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	for (let i = 0; i < 40 && !window.piShellDebug; i += 1) await wait(100);
	const D = window.piShellDebug;
	const out = {};

	// Stub the network: capture compact bodies, watch for stray prompts, and
	// answer commands/models quietly. /api/commands deliberately does NOT list
	// compact — the shell must append it itself.
	const compactBodies = [];
	const promptBodies = [];
	let compactResponse = { ok: true };
	const realFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const url = String(input);
		if (url.includes("/api/compact")) {
			compactBodies.push(JSON.parse(init.body));
			return new Response(JSON.stringify(compactResponse), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		}
		if (url.includes("/api/prompt")) {
			promptBodies.push(JSON.parse(init.body));
			return new Response(JSON.stringify({ ok: true }), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		}
		if (url.includes("/api/commands")) {
			return new Response(JSON.stringify({ commands: [{ name: "probe", description: "probe cmd", source: "extension" }] }), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		}
		if (url.includes("/api/models")) {
			return new Response(JSON.stringify({ models: [], thinkingLevels: [] }), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		}
		return realFetch(input, init);
	};

	D.state.path = "/tmp/session.jsonl";
	D.state.cwd = "/tmp";
	document.getElementById("messages").innerHTML = "";
	document.getElementById("ui-toasts").innerHTML = "";

	// The snapshot handler fetches the session's commands; the merge must add
	// the builtin without dropping what pi reported.
	D.handleSnapshot({ messages: [], state: {}, stats: null, ui: null });
	await wait(300);
	out.commandNames = D.state.commands.map((c) => c.name);
	out.compactSource = (D.state.commands.find((c) => c.name === "compact") || {}).source;

	const input = document.getElementById("input");
	const pressEnter = () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	const notices = () => [...document.querySelectorAll("#messages .msg")].map((n) => n.textContent).join("|");

	// Typing "/" offers the builtin next to pi's own command.
	input.value = "/";
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await wait(100);
	out.menuVisible = !document.getElementById("command-menu").hidden;
	out.menuText = document.getElementById("command-list").textContent;

	// Exact command + Enter: goes to /api/compact, never to the model, and
	// leaves no user bubble behind.
	input.value = "/compact";
	input.dispatchEvent(new Event("input", { bubbles: true }));
	pressEnter();
	await wait(200);
	out.firstBody = compactBodies[0] ?? null;
	out.promptCalls = promptBodies.length;
	out.inputAfter = input.value;
	out.userBubbles = document.querySelectorAll("#messages .msg.user").length;
	out.noticeAfterFirst = notices();

	// "/compact <instructions>" passes the rest through.
	input.value = "/compact 重点保留 RPA 结论";
	input.dispatchEvent(new Event("input", { bubbles: true }));
	pressEnter();
	await wait(200);
	out.secondBody = compactBodies[1] ?? null;

	// A server-side timeout is not a failure: the notice says "still running".
	compactResponse = { ok: true, pending: true };
	input.value = "/compact";
	input.dispatchEvent(new Event("input", { bubbles: true }));
	pressEnter();
	await wait(200);
	out.pendingNotice = notices();

	// Stream events are the outcome source: start announces, a willRetry end
	// stays silent, the real end reports done, and an in-flight compaction
	// suppresses the duplicate start notice.
	D.state.compacting = false;
	const countMsgs = () => document.querySelectorAll("#messages .msg").length;
	const beforeStart = countMsgs();
	D.handleEvent({ type: "compaction_start", reason: "manual" });
	out.startNoticed = countMsgs() === beforeStart + 1;

	const beforeRetry = countMsgs();
	D.handleEvent({ type: "compaction_end", aborted: false, willRetry: true });
	out.retrySilent = countMsgs() === beforeRetry;

	D.handleEvent({ type: "compaction_end", aborted: false, willRetry: false });
	out.doneNotice = notices();

	D.state.compacting = true;
	const beforeSuppressed = countMsgs();
	D.handleEvent({ type: "compaction_start", reason: "manual" });
	out.suppressedStart = countMsgs() === beforeSuppressed;
	D.state.compacting = false;

	D.handleEvent({ type: "compaction_end", aborted: false, willRetry: false, errorMessage: "boom" });
	out.errorNotice = [...document.querySelectorAll("#messages .msg.error")].map((n) => n.textContent).join("|");

	return out;
})()`;

async function main(): Promise<void> {
	const chromeBin = await findChrome();
	const port = 9000 + Math.floor(Math.random() * 900);
	const profile = await mkdtemp(join(tmpdir(), "pi-ui-compact-"));
	const child: ChildProcess = spawn(
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

		ok(out.commandNames.includes("probe"), `pi's commands survive the merge (${out.commandNames})`);
		ok(out.commandNames.includes("compact"), `builtin /compact is offered (${out.commandNames})`);
		ok(out.compactSource === "builtin", `builtin badge source (${out.compactSource})`);
		ok(out.menuVisible && String(out.menuText).includes("/compact"), "typing / lists /compact in the menu");
		ok(out.firstBody?.path === "/tmp/session.jsonl", `compact body carries the session path (${JSON.stringify(out.firstBody)})`);
		ok(out.firstBody?.customInstructions === undefined, "bare /compact sends no instructions");
		ok(out.promptCalls === 0, `no prompt reached the model (${out.promptCalls})`);
		ok(out.inputAfter === "", "composer cleared after the command");
		ok(out.userBubbles === 0, `no user bubble was added (${out.userBubbles})`);
		ok(String(out.noticeAfterFirst).includes("正在压缩"), `start notice shown (${out.noticeAfterFirst})`);
		ok(out.secondBody?.customInstructions === "重点保留 RPA 结论", `instructions pass through (${JSON.stringify(out.secondBody)})`);
		ok(String(out.pendingNotice).includes("仍在进行"), "a server timeout reads as still-running");
		ok(out.startNoticed === true, "compaction_start adds exactly one notice");
		ok(out.retrySilent === true, "a willRetry end stays silent (no flash of done)");
		ok(String(out.doneNotice).includes("上下文已压缩"), "the final end reports done");
		ok(out.suppressedStart === true, "in-flight compaction suppresses the duplicate start notice");
		ok(String(out.errorNotice).includes("boom"), `event errors surface (${out.errorNotice})`);
		ok(pageErrors.length === 0, `no page exceptions (got ${pageErrors.length})`);

		cdp.close();
	} finally {
		clearTimeout(hardTimeout);
		child.kill("SIGKILL");
	}

	console.log(failed ? "\n❌ some assertions failed" : "\n✅ all green");
	process.exit(failed ? 1 : 0);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
