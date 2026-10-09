/**
 * UI assertions for the "background session finished" notice (M2.20).
 *
 *   PI_SHELL_SESSIONS_DIR=/tmp/x PI_SHELL_PORT=4755 PI_SHELL_OPEN_BROWSER=0 \
 *     node src/server/index.ts &
 *   node scripts/ui-test-notify.ts http://127.0.0.1:4755/
 *
 * The signal itself is server-side (`/api/events` activity frames, covered by
 * test/sessionRegistry.test.ts). This script drives the consumer: it seeds two
 * fake sessions and calls `piShellDebug.applyActivity` with each `reason`, then
 * asserts what the user actually sees — toast text, the `(n)` title badge, and
 * the three cases that must stay silent (the session on screen, the idle
 * reaper's `retired`, and a finish the user asked for by clicking stop).
 *
 * Headless Chrome over CDP, same zero-dependency approach as the other
 * ui-tests. Exits non-zero on the first failed assertion.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
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

const DRIVE = `(async () => {
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	for (let i = 0; i < 40 && !window.piShellDebug; i += 1) await wait(100);
	const D = window.piShellDebug;
	const out = {};
	const now = new Date().toISOString();
	const mk = (name) => ({ path: "/tmp/" + name + ".jsonl", cwd: "/tmp", title: name, running: false, pending: false, updatedAt: now });

	const A = mk("Alpha");
	const B = mk("Beta");
	const C = mk("Gamma");
	const E = mk("Delta");
	const F = mk("Epsilon");
	D.state.sessions = [A, B, C, E, F];
	D.state.folders = [{ cwd: "/tmp" }];
	D.state.cwd = "/tmp";
	D.state.path = B.path;
	D.state.unreadDone.clear();
	D.state.abortedPaths.clear();
	D.state.extension.title = null;
	D.state.defaultTitle = "pi-web-shell";
	document.title = "pi-web-shell";
	document.getElementById("ui-toasts").innerHTML = "";

	const toasts = () => [...document.querySelectorAll("#ui-toasts .toast")].map((n) => n.textContent);

	// 1. A background run starts: the dot flips, nothing is announced.
	D.applyActivity(A.path, true, "started");
	await wait(30);
	out.startedRunning = A.running;
	out.startedToasts = toasts().length;

	// 2. It finishes while another session is open: toast + (1) title badge.
	D.applyActivity(A.path, false, "settled");
	await wait(30);
	out.settledRunning = A.running;
	out.settledToasts = toasts();
	out.settledBadge = document.title;
	out.settledUnread = D.state.unreadDone.has(A.path);

	// 3. The session on screen finishing is not news — the user watched it.
	D.applyActivity(B.path, true, "started");
	await wait(30);
	D.applyActivity(B.path, false, "settled");
	await wait(30);
	out.currentToasts = toasts().length;
	out.currentUnread = D.state.unreadDone.has(B.path);

	// 4. The idle reaper is housekeeping, never a notification.
	D.applyActivity(C.path, true, "started");
	await wait(30);
	D.applyActivity(C.path, false, "retired");
	await wait(30);
	out.retiredToasts = toasts().length;
	out.retiredUnread = D.state.unreadDone.has(C.path);

	// 5. A crash is announced, worded differently from a clean finish.
	D.applyActivity(E.path, true, "started");
	await wait(30);
	D.applyActivity(E.path, false, "exited");
	await wait(30);
	out.exitedToasts = toasts().length;
	out.exitedText = toasts().at(-1);
	out.exitedBadge = document.title;

	// 6. A finish the user asked for (stop clicked) is suppressed.
	D.applyActivity(F.path, true, "started");
	await wait(30);
	D.markAborted(F.path);
	D.applyActivity(F.path, false, "settled");
	await wait(30);
	out.abortToasts = toasts().length;
	out.abortUnread = D.state.unreadDone.has(F.path);

	// 7. A new run clears that session's stale badge.
	out.beforeRestartBadge = document.title;
	D.applyActivity(E.path, true, "started");
	await wait(30);
	out.afterRestartBadge = document.title;

	// 8. Clicking the toast opens the session and acknowledges its badge.
	document.querySelector("#ui-toasts .toast").click();
	await wait(120);
	out.clickedPath = D.state.path;
	out.clickedUnread = D.state.unreadDone.has(A.path);
	out.clickedToasts = toasts();

	// 9. An extension's setTitle and the badge share document.title.
	const G = mk("Zeta");
	D.state.sessions.push(G);
	D.applyActivity(G.path, true, "started");
	await wait(30);
	D.applyActivity(G.path, false, "settled");
	await wait(30);
	D.state.extension.title = "Busy";
	D.applyActivity(A.path, true, "started");
	await wait(30);
	out.combinedTitle = document.title;

	return out;
})()`;

async function main(): Promise<void> {
	const chromeBin = await findChrome();
	const port = 9000 + Math.floor(Math.random() * 900);
	const profile = await mkdtemp(join(tmpdir(), "pi-ui-notify-"));
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

		ok(out.startedRunning === true, "a starting run flips the sidebar dot");
		ok(out.startedToasts === 0, "a starting run announces nothing");
		ok(out.settledRunning === false, "a finished run clears the dot");
		ok(
			Array.isArray(out.settledToasts) && out.settledToasts.length === 1 && /Alpha/.test(out.settledToasts[0]),
			`a background finish shows one toast naming the session (${JSON.stringify(out.settledToasts)})`,
		);
		ok(out.settledBadge === "(1) pi-web-shell", `the title gains a (1) badge (${out.settledBadge})`);
		ok(out.settledUnread === true, "the finished session is marked unread");

		ok(out.currentToasts === 1, "the session on screen does not notify");
		ok(out.currentUnread === false, "the session on screen is not marked unread");

		ok(out.retiredToasts === 1, "the idle reaper stays silent");
		ok(out.retiredUnread === false, "the idle reaper leaves no unread mark");

		ok(out.exitedToasts === 2, "a crashed run is announced");
		ok(/Delta/.test(out.exitedText) && /异常结束|ended unexpectedly/.test(out.exitedText), `the crash toast is worded as a failure (${out.exitedText})`);
		ok(out.exitedBadge === "(2) pi-web-shell", `both finishes are counted in the title (${out.exitedBadge})`);

		ok(out.abortToasts === 2, "a stop the user clicked is not announced");
		ok(out.abortUnread === false, "an aborted run leaves no unread mark");

		ok(out.beforeRestartBadge === "(2) pi-web-shell", `badge before the rerun is (2) (${out.beforeRestartBadge})`);
		ok(out.afterRestartBadge === "(1) pi-web-shell", `starting again clears that session's badge (${out.afterRestartBadge})`);

		ok(out.clickedPath === "/tmp/Alpha.jsonl", "clicking the toast opens that session");
		ok(out.clickedUnread === false, "opening the session acknowledges the badge");
		ok(Array.isArray(out.clickedToasts) && out.clickedToasts.length === 1, `the clicked toast is removed (${JSON.stringify(out.clickedToasts)})`);

		ok(out.combinedTitle === "(1) Busy \u00b7 pi-web-shell", `extension title and badge combine (${out.combinedTitle})`);

		ok(pageErrors.length === 0, `no page exceptions (got ${pageErrors.length}${pageErrors.length ? ": " + pageErrors[0] : ""})`);

		cdp.close();
	} finally {
		clearTimeout(hardTimeout);
		child.kill("SIGKILL");
	}

	if (failed) process.exit(1);
	console.log("all background-notification assertions passed");
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
