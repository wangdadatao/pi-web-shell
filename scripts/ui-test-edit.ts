/**
 * UI assertions for inline "edit / delete and resend" on user messages (M2.21).
 *
 *   PI_SHELL_SESSIONS_DIR=/tmp/x PI_SHELL_PORT=4755 PI_SHELL_OPEN_BROWSER=0 \
 *     node src/server/index.ts &
 *   node scripts/ui-test-edit.ts http://127.0.0.1:4755/
 *
 * The rewrite itself is pi's `fork` RPC (covered by test/treeView.test.ts for
 * the id resolution, and by pi's own tests for the fork). What this script
 * pins is the browser contract: bubbles carry `from-end` counts (not ids),
 * clicking edits prefills the composer while deleting does not, a running
 * session is aborted and awaited first, and the fork body is what the server
 * expects.
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

	// Stub the network: capture fork bodies, answer commands/models quietly.
	const forked = [];
	const aborted = [];
	const realFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const url = String(input);
		if (url.includes("/api/fork")) {
			const body = JSON.parse(init.body);
			forked.push(body);
			return new Response(JSON.stringify({ ok: true, cancelled: false, text: "TEXT-" + body.fromEnd }), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		}
		if (url.includes("/api/abort")) {
			aborted.push(JSON.parse(init.body));
			// The real stop arrives as an agent_settled event a moment later.
			setTimeout(() => D.handleEvent({ type: "agent_settled" }), 10);
			return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
		}
		if (url.includes("/api/commands") || url.includes("/api/models")) {
			return new Response(JSON.stringify({ commands: [], models: [], thinkingLevels: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
		}
		return realFetch(input, init);
	};

	D.state.path = "/tmp/session.jsonl";
	D.state.cwd = "/tmp";
	document.getElementById("ui-toasts").innerHTML = "";

	// Capture clipboard writes (localhost is a secure context, so this is the path taken).
	let copied = null;
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: async (t) => { copied = t; } },
	});

	// Two user turns: "first wrong" then "second".
	D.handleSnapshot({
		messages: [
			{ role: "user", content: "first wrong", timestamp: Date.parse("2026-10-09T09:00:00Z") },
			// Two assistant messages in one turn (a tool-heavy turn looks like this):
			// the footer must total 100+340, not just the last message's 340.
			{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.parse("2026-10-09T09:00:05Z"), usage: { input: 1200, output: 100 } },
			{ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: Date.parse("2026-10-09T09:00:12Z"), usage: { input: 800, output: 340 } },
			{ role: "user", content: "second", timestamp: Date.parse("2026-10-09T09:01:00Z") },
		],
		state: {}, stats: null, ui: null,
	});
	await wait(150);

	const bubbles = [...document.querySelectorAll("#messages .msg.user")];
	out.bubbleCount = bubbles.length;
	out.actionCount = document.querySelectorAll("#messages .msg.user .msg-act").length;
	out.copyCount = document.querySelectorAll("#messages .msg.user [data-copy=message]").length;
	out.actionLabels = [...document.querySelectorAll("#messages .msg.user .msg-act")].map((n) => n.textContent).join("");

	// Duration formatting boundaries (119.6s must not round to 1m60s).
	out.dur119 = D.fmtDuration(119600);
	out.dur120 = D.fmtDuration(120000);
	out.dur594 = D.fmtDuration(59400);

	// Metadata: send time on user bubbles; reply stats on the last reply.
	out.userTime = document.querySelector("#messages .msg.user .msg-time")?.textContent ?? null;
	out.assistantMeta = document.querySelector("#messages .msg.assistant.is-last .msg-meta")?.textContent ?? null;
	out.assistantCopyCount = document.querySelectorAll("#messages .msg.assistant .msg-actions [data-copy=message]").length;
	out.headCopyGone = document.querySelectorAll("#messages .msg.assistant .msg-head [data-copy]").length;
	document.querySelector("#messages .msg.assistant .msg-actions [data-copy=message]").click();
	await wait(150);
	out.assistantCopied = copied;

	// Placement: out of flow (no bubble height) and outside the bubble, left.
	const b0 = bubbles[0];
	const a0 = b0.querySelector(".msg-actions");
	const br = b0.getBoundingClientRect();
	const ar = a0.getBoundingClientRect();
	const mr = document.getElementById("messages").getBoundingClientRect();
	out.actionsPosition = getComputedStyle(a0).position;
	out.actionsBelow = ar.top >= br.bottom - 0.5;
	out.actionsRightAligned = Math.abs(ar.right - br.right) <= 2;
	out.actionsWithinMessages = ar.left >= mr.left - 1 && ar.right <= mr.right + 1;

	// 0. Copy is icon-only (no "copy" text) and writes the visible prose.
	bubbles[0].querySelector("[data-copy=message]").click();
	await wait(150);
	out.copied = copied;
	out.copyFeedback = bubbles[0].querySelector("[data-copy=message]").textContent;

	// 1. Edit the FIRST message (oldest): from-end is 1, composer gets its text.
	const input = document.getElementById("input");
	bubbles[0].querySelector("[data-msg-action=edit]").click();
	await wait(250);
	out.editBody = forked[0] ?? null;
	out.composerAfterEdit = input.value;

	// 2. Delete the newest: from-end 0, composer must stay empty.
	input.value = "";
	bubbles[1].querySelector("[data-msg-action=delete]").click();
	await wait(250);
	out.deleteBody = forked[1] ?? null;
	out.composerAfterDelete = input.value;

	// 3. A running session is stopped first (abort body captured, then settle).
	D.state.streaming = true;
	const third = { role: "user", content: "third" };
	D.handleSnapshot({
		messages: [
			{ role: "user", content: "first wrong" },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "second" },
			third,
		],
		state: {}, stats: null, ui: null,
	});
	await wait(150);
	const live = [...document.querySelectorAll("#messages .msg.user")].at(-1);
	D.state.streaming = true;
	live.querySelector("[data-msg-action=delete]").click();
	await wait(250);
	out.abortBody = aborted[0] ?? null;
	out.thirdBody = forked[2] ?? null;
	out.streamingAfter = D.state.streaming;

	// 3b. A from-end index must be recomputed at click time: clicking the
	// oldest of three now counts 2 back, not the 1 baked in when it rendered.
	const oldest = [...document.querySelectorAll("#messages .msg.user")][0];
	oldest.querySelector("[data-msg-action=edit]").click();
	await wait(250);
	out.staleBody = forked[3] ?? null;

	// 4. A message with an image warns that images are not restored.
	D.handleSnapshot({
		messages: [
			{ role: "user", content: [{ type: "text", text: "with pic" }, { type: "image", data: "aGk=", mimeType: "image/png" }] },
		],
		state: {}, stats: null, ui: null,
	});
	await wait(150);
	const imgBubble = document.querySelector("#messages .msg.user");
	imgBubble.querySelector("[data-msg-action=edit]").click();
	await wait(250);
	out.notices = [...document.querySelectorAll("#messages .msg.notice")].map((n) => n.textContent).join(" | ");

	return out;
})()`;

async function main(): Promise<void> {
	const chromeBin = await findChrome();
	const port = 9000 + Math.floor(Math.random() * 900);
	const profile = await mkdtemp(join(tmpdir(), "pi-ui-edit-"));
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

		ok(out.bubbleCount === 2, `one bubble per user message (${out.bubbleCount})`);
		ok(out.actionCount === 6, `each bubble offers edit + delete + copy (${out.actionCount})`);
		ok(out.copyCount === 2, `copy button present on every bubble (${out.copyCount})`);
		ok(!/[\u4e00-\u9fff]/.test(out.actionLabels), `the row is icon-only, no text (${out.actionLabels})`);
		ok(out.copied === "first wrong", `copy writes the visible message text (${JSON.stringify(out.copied)})`);
		ok(out.copyFeedback === "\u2713", `the icon button flashes a check, not text (${out.copyFeedback})`);

		ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(out.userTime ?? ""), `user row shows the send time (${out.userTime})`);
		ok(out.assistantCopyCount === 2, `every reply's copy moved below its bubble (${out.assistantCopyCount})`);
		ok(out.headCopyGone === 0, "and is gone from the bubble head");
		ok(/\u2191 2\.0k \u2193 440/.test(out.assistantMeta ?? ""), `reply stats show ↑input ↓output summed over the whole turn (${out.assistantMeta})`);
		ok(/12\.0s/.test(out.assistantMeta ?? ""), `reply stats show the reply duration (${out.assistantMeta})`);
		ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(out.assistantMeta ?? ""), `reply stats show the end time (${out.assistantMeta})`);
		ok(out.dur119 === "2m00s", `119.6s rounds to 2m00s, not 1m60s (${out.dur119})`);
		ok(out.dur120 === "2m00s", `120s is 2m00s (${out.dur120})`);
		ok(out.dur594 === "59.4s", `59.4s stays in seconds (${out.dur594})`);
		ok(out.assistantCopied === "ok", `the reply's copy button copies its prose (${JSON.stringify(out.assistantCopied)})`);
		ok(out.actionsPosition === "absolute", `actions are out of flow, so they add no bubble height (${out.actionsPosition})`);
		ok(out.actionsBelow === true, "actions sit below the bubble, outside it");
		ok(out.actionsRightAligned === true, "actions align with the bubble's right edge");
		ok(out.actionsWithinMessages === true, "actions stay inside the transcript column");

		ok(out.editBody && out.editBody.fromEnd === 1, `edit sends the from-end index (${JSON.stringify(out.editBody)})`);
		ok(out.editBody && out.editBody.path === "/tmp/session.jsonl", "fork body carries the session path");
		ok(out.composerAfterEdit === "TEXT-1", `edit prefills the composer with the forked text (${out.composerAfterEdit})`);

		ok(out.deleteBody && out.deleteBody.fromEnd === 0, `delete sends the from-end index (${JSON.stringify(out.deleteBody)})`);
		ok(out.composerAfterDelete === "", "delete does not prefill the composer");

		ok(out.abortBody && out.abortBody.path === "/tmp/session.jsonl", "a running session is aborted before forking");
		ok(out.thirdBody && out.thirdBody.fromEnd === 0, `fork happens after the run settles (${JSON.stringify(out.thirdBody)})`);
		ok(out.streamingAfter === false, "the session is idle afterwards");
		ok(out.staleBody && out.staleBody.fromEnd === 2, `an old bubble recounts at click time (${JSON.stringify(out.staleBody)})`);

		ok(/图片|image/i.test(out.notices), `an image message warns images are not restored (${out.notices})`);

		ok(pageErrors.length === 0, `no page exceptions (got ${pageErrors.length}${pageErrors.length ? ": " + pageErrors[0] : ""})`);

		cdp.close();
	} finally {
		clearTimeout(hardTimeout);
		child.kill("SIGKILL");
	}

	if (failed) process.exit(1);
	console.log("all edit/delete-resend assertions passed");
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
