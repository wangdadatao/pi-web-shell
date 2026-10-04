/**
 * UI assertions for the footer token-speed readout (run against an isolated server).
 *
 *   PI_SHELL_SESSIONS_DIR=/tmp/x PI_SHELL_PORT=4755 PI_SHELL_OPEN_BROWSER=0 \
 *     node src/server/index.ts &
 *   node scripts/ui-test-token-speed.ts http://127.0.0.1:4755/
 *
 * Feeds synthetic agent events through `piShellDebug.handleEvent`, so it needs no
 * model calls. Drives headless Chrome over CDP the same way the other ui-tests do.
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
 * The page-side driver. Every reading comes from `piShellDebug.state` so the
 * assertions do not depend on the 500ms render ticker; DOM text is checked once,
 * to prove the number actually reaches the footer.
 */
const DRIVE = `(async () => {
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	for (let i = 0; i < 40 && !window.piShellDebug; i += 1) await wait(100);
	const D = window.piShellDebug;
	const send = (event) => D.handleEvent(event);
	const shown = () => document.querySelector(".stat.speed")?.textContent?.trim() ?? null;
	const rateOf = (text) => Number((text ?? "").replace(/[^0-9.]/g, "")) || 0;
	const chunk = "x".repeat(20); // 20 ASCII chars ≈ 5 tokens
	const startMessage = () => send({ type: "message_start", message: { role: "assistant", content: [] } });
	const endMessage = (output) =>
		send({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: chunk.repeat(10) }], usage: { output } },
		});
	const stream = async (type, delta, usage = () => 0) => {
		for (let i = 0; i < 10; i += 1) {
			send({ type: "message_update", assistantMessageEvent: { type, delta }, usage: { output: usage(i + 1) } });
			await wait(100);
		}
	};
	const out = {};

	// 1) agent_start 后挂 2s 才有首个 delta:时钟不能在这段里走。
	const t0 = performance.now();
	send({ type: "agent_start" });
	await wait(2000);
	out.clockBeforeFirstDelta = D.state.streamStart;
	startMessage();
	out.afterMessageStart = { streamStart: D.state.streamStart, estimated: D.state.streamEstimatedTokens };
	await stream("text_delta", chunk);
	out.clockDelayMs = Math.round(D.state.streamStart - t0);
	out.firstEstimated = D.state.streamEstimatedTokens;
	await wait(600);
	out.firstShown = shown();
	endMessage(50);
	out.firstFrozen = D.state.lastSpeed;
	await wait(700);
	out.betweenMessages = shown();

	// 2) 第二条消息:计数按消息重置,显示也不该塌成「上一条 token 数 ÷ 整轮耗时」。
	startMessage();
	await stream("text_delta", chunk);
	out.secondEstimated = D.state.streamEstimatedTokens;
	await wait(600);
	out.secondShown = shown();
	endMessage(50);
	out.secondFrozen = D.state.lastSpeed;
	send({ type: "agent_settled" });
	await wait(700);
	out.settled = shown();

	// 3) 只产出工具参数的消息同样要有速度。
	send({ type: "agent_start" });
	startMessage();
	await stream("toolcall_delta", '{"path":"a"}');
	out.toolEstimated = D.state.streamEstimatedTokens;
	await wait(600);
	out.toolShown = shown();
	send({ type: "agent_settled" });

	// 4) provider 报了 usage.output 就用真实值,并且去掉 ≈ 前缀。
	send({ type: "agent_start" });
	startMessage();
	await stream("text_delta", chunk, (n) => n * 12);
	out.reportedTokens = D.state.streamReportedTokens;
	await wait(600);
	out.reportedShown = shown();
	send({ type: "agent_settled" });

	out.rate = { first: rateOf(out.firstFrozen), second: rateOf(out.secondFrozen) };
	return out;
})()`;

async function main(): Promise<void> {
	const chromeBin = await findChrome();
	const port = 9000 + Math.floor(Math.random() * 900);
	const profile = await mkdtemp(join(tmpdir(), "pi-ui-speed-"));
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

		// 1) 计时起点是首个 delta,不是 agent_start,也不是请求发出时。
		ok(out.clockBeforeFirstDelta === 0, "clock idle until the first delta");
		ok(out.afterMessageStart?.streamStart === 0 && out.afterMessageStart?.estimated === 0, "message_start resets the measurement");
		ok(Number(out.clockDelayMs) >= 1900, `first delta starts the clock, after ${out.clockDelayMs}ms of latency`);
		ok(Number(out.firstEstimated) > 40 && Number(out.firstEstimated) < 60, `10 text deltas ≈ ${out.firstEstimated} tokens`);

		// 2) 数字真的渲染出来了,并且 ≈ 前缀表示估算。
		ok(String(out.firstShown ?? "").includes("tok/s"), `footer shows a rate (${out.firstShown})`);

		// 3) 消息结束时用最终 usage 冻结,换成真实值(去掉 ≈)。
		ok(!String(out.firstFrozen ?? "").includes("≈"), `message_end freezes the reported count (${out.firstFrozen})`);
		ok(out.betweenMessages === `⚡ ${out.firstFrozen}`, "frozen rate stays on screen between messages");

		// 4) 第二条消息重新计时,而不是拿上一条的 token 数除以整轮耗时。
		ok(Number(out.secondEstimated) === Number(out.firstEstimated), "per-message counters reset on message_start");
		const first = Number(out.rate?.first ?? 0);
		const second = Number(out.rate?.second ?? 0);
		ok(
			first > 0 && second > first * 0.6,
			`second message keeps a comparable rate (${first} → ${second} tok/s)`,
		);
		ok(out.settled === `⚡ ${out.secondFrozen}`, "agent_settled keeps the last rate");

		// 5) 工具参数也是产出 token,不能因为消息里没有正文就丢掉速度。
		ok(Number(out.toolEstimated) > 0, `tool-call deltas count (${out.toolEstimated} tokens)`);
		ok(String(out.toolShown ?? "").includes("tok/s"), `tool-only message still shows a rate (${out.toolShown})`);

		// 6) provider 报 usage 时用真实值,并去掉 ≈ 前缀。
		ok(Number(out.reportedTokens) === 120, `reported usage wins (${out.reportedTokens} tokens)`);
		ok(!String(out.reportedShown ?? "").includes("≈"), `reported rate carries no ≈ (${out.reportedShown})`);

		ok(pageErrors.length === 0, `no page exceptions (got ${pageErrors.length}${pageErrors.length ? ": " + pageErrors[0] : ""})`);

		cdp.close();
	} finally {
		clearTimeout(hardTimeout);
		child.kill("SIGKILL");
	}

	if (failed) process.exit(1);
	console.log("all token-speed assertions passed");
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
