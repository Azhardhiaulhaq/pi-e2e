/**
 * pi-e2e — end-to-end testing tools for pi.
 *
 * Project-agnostic: every project describes its services in `.pi/e2e.json`
 * (searched upward from the session cwd). See README.md for the schema.
 *
 * Tools:
 *   e2e_stack  start/stop/inspect local services (backend, frontend, workers, ...)
 *   browser    drive headless Chromium (desktop or emulated mobile device)
 *   mobile     drive an Android device/emulator (adb) or iOS simulator (simctl)
 * Command:
 *   /e2e up|down|status|logs <service>|setup
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Browser, BrowserContext, Page } from "playwright";
import {
	captureFromText,
	credUsers,
	type CredentialsCfg,
	describeCreds,
	expandTemplate,
	hasSecrets,
	redact,
	redactDeep,
	registerAll,
	removeCred,
	renameCred,
	resolveSecret,
	saveCred,
} from "../lib/credentials.ts";
import { askSecret } from "../lib/secret-prompt.ts";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

// ───────────────────────── config ─────────────────────────

interface ServiceCfg {
	cwd?: string;
	command: string;
	port: number;
	host?: string;
	health?: string;
	env?: Record<string, string>;
	dependsOn?: string[];
	startupTimeoutSec?: number;
}
interface AuthCfg {
	path: string;
	/** selector → value. Values: "{{email|username}}" / "{{password}}" (from the chosen user), "$CRED:user.field", "$ENV:NAME" */
	fields: Record<string, string>;
	submit: string;
	successSelector?: string;
	/** user to log in as when `browser login` gets no `user` */
	defaultUser?: string;
}
interface E2EConfig {
	artifactsDir?: string;
	keepRunning?: boolean;
	/** Named test users. Values should be "$ENV:NAME"; secrets can also live in the private store (/e2e cred add). */
	credentials?: CredentialsCfg;
	/** Replace credentials typed in chat with $CRED references (default true) */
	captureCredentials?: boolean;
	services: Record<string, ServiceCfg>;
	browser?: { baseUrl?: string; viewport?: [number, number]; device?: string; auth?: AuthCfg };
	mobile?: {
		platform?: "android" | "ios";
		android?: { adb?: string; serial?: string; package?: string; activity?: string; reversePorts?: boolean };
		ios?: { device?: string; bundleId?: string };
	};
}
interface Loaded {
	root: string;
	file: string;
	mtime: number;
	cfg: E2EConfig;
}

let loaded: Loaded | undefined;

function findConfig(cwd: string): string | undefined {
	let dir = path.resolve(cwd);
	for (;;) {
		const f = path.join(dir, ".pi", "e2e.json");
		if (existsSync(f)) return f;
		const up = path.dirname(dir);
		if (up === dir) return undefined;
		dir = up;
	}
}

function loadConfig(cwd: string): Loaded {
	const file = findConfig(cwd);
	if (!file) throw new Error("No .pi/e2e.json found from " + cwd + " upward. Create one (see the e2e-test skill / package README).");
	const mtime = statSync(file).mtimeMs;
	if (loaded?.file === file && loaded.mtime === mtime) return loaded;
	const cfg = JSON.parse(readFileSync(file, "utf8")) as E2EConfig;
	if (!cfg.services || typeof cfg.services !== "object") throw new Error(`${file}: "services" is required`);
	loaded = { root: path.dirname(path.dirname(file)), file, mtime, cfg };
	registerAll(loaded.root, cfg.credentials, envRefs(cfg));
	return loaded;
}

const svcUrl = (s: ServiceCfg) => `http://${s.host ?? "localhost"}:${s.port}`;

/** ${PORT} ${URL} ${<svc>.port} ${<svc>.url} ${env:NAME} */
function interp(str: string, cfg: E2EConfig, self?: ServiceCfg): string {
	return str.replace(/\$\{([^}]+)\}/g, (m, key: string) => {
		if (key === "PORT" && self) return String(self.port);
		if (key === "URL" && self) return svcUrl(self);
		if (key.startsWith("env:")) return process.env[key.slice(4)] ?? "";
		const [name, prop] = key.split(".");
		const s = cfg.services[name];
		if (s && prop === "port") return String(s.port);
		if (s && prop === "url") return svcUrl(s);
		return m;
	});
}

/** All "$ENV:NAME" names used anywhere in the config (their values get redacted too). */
function envRefs(cfg: E2EConfig): string[] {
	return [...JSON.stringify(cfg).matchAll(/\$ENV:(\w+)/g)].map((m) => m[1]);
}

/** "$ENV:NAME" / "$CRED:user.field" → real value. Keeps secrets out of tool arguments and transcripts. */
function secret(l: Loaded, v: string | undefined): string | undefined {
	return resolveSecret(v, l.root, l.cfg.credentials);
}

function artifacts(l: Loaded, sub = ""): string {
	const base = path.join(l.root, l.cfg.artifactsDir ?? ".e2e-artifacts");
	const dir = path.join(base, sub);
	mkdirSync(dir, { recursive: true });
	// The artifacts dir holds logs and a saved login session (cookies). Never let it be committed.
	const gi = path.join(base, ".gitignore");
	if (!existsSync(gi)) writeFileSync(gi, "*\n");
	return dir;
}

// Session prefix keeps screenshots from different pi sessions from overwriting each other.
const runId = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
let shotSeq = 0;
const stamp = (name: string) => `${runId}-${String(++shotSeq).padStart(3, "0")}-${name.replace(/[^\w.-]+/g, "_").slice(0, 40)}`;

const text = (t: string, details: unknown = undefined) => ({ content: [{ type: "text" as const, text: t }], details });
const clip = (s: string, n = 12_000) => (s.length > n ? s.slice(0, n) + `\n… [truncated ${s.length - n} chars]` : s);

// ───────────────────────── services ─────────────────────────

interface Running {
	proc: ChildProcess;
	logFile: string;
	exited?: number | null;
}
const running = new Map<string, Running>();
const external = new Set<string>(); // already up when we arrived — never killed by us

/** Last `n` lines of a file, reading at most 64 KB from the end. */
function tailFile(file: string, n: number): string {
	if (!existsSync(file)) return "";
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size;
		const len = Math.min(size, 64 * 1024);
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, size - len);
		// strip ANSI colour codes and hyperlinks so the model sees clean text
		const clean = buf.toString("utf8").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
		return clean.split("\n").filter(Boolean).slice(-n).join("\n");
	} finally {
		closeSync(fd);
	}
}

function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
	return new Promise((resolve) => {
		const s = net.connect({ port, host });
		const done = (ok: boolean) => (s.destroy(), resolve(ok));
		s.setTimeout(800, () => done(false));
		s.once("connect", () => done(true));
		s.once("error", () => done(false));
	});
}

async function healthy(s: ServiceCfg): Promise<boolean> {
	if (!s.health) return portOpen(s.port);
	try {
		const r = await fetch(svcUrl(s) + s.health, { signal: AbortSignal.timeout(5000), redirect: "manual" });
		await r.body?.cancel();
		return r.status < 500;
	} catch {
		return false;
	}
}

function startProc(l: Loaded, name: string, s: ServiceCfg): Running {
	const logFile = path.join(artifacts(l, "logs"), `${name}.log`);
	// stdout/stderr go straight to the file (not through a pipe), so services never block on
	// a full pipe and keep working if pi exits with keepRunning.
	const fd = openSync(logFile, "w");
	const env: Record<string, string> = { ...(process.env as Record<string, string>), PORT: String(s.port), FORCE_COLOR: "0", NO_COLOR: "1" };
	for (const [k, v] of Object.entries(s.env ?? {})) env[k] = interp(v, l.cfg, s);
	const proc = spawn(interp(s.command, l.cfg, s), {
		cwd: path.resolve(l.root, s.cwd ?? "."),
		env,
		shell: "/bin/bash",
		detached: true, // own process group → we can kill the whole tree
		stdio: ["ignore", fd, fd],
	});
	closeSync(fd);
	const r: Running = { proc, logFile };
	proc.on("exit", (code) => {
		r.exited = code;
	});
	if (loaded?.cfg.keepRunning) proc.unref();
	running.set(name, r);
	return r;
}

async function ensureUp(l: Loaded, name: string, inflight: Map<string, Promise<string>>, signal?: AbortSignal): Promise<string> {
	const existing = inflight.get(name);
	if (existing) return existing;
	const p = (async () => {
		const s = l.cfg.services[name];
		if (!s) throw new Error(`Unknown service "${name}". Known: ${Object.keys(l.cfg.services).join(", ")}`);
		await Promise.all((s.dependsOn ?? []).map((d) => ensureUp(l, d, inflight, signal)));

		const r = running.get(name);
		if (r && r.exited === undefined && (await healthy(s))) return `${name}: up (${svcUrl(s)})`;
		if (!r && (await healthy(s))) {
			external.add(name);
			return `${name}: already running on ${svcUrl(s)} (reused, not managed)`;
		}
		if (!r && (await portOpen(s.port))) throw new Error(`${name}: port ${s.port} is busy but health check ${s.health ?? "(tcp)"} fails. Free the port or fix "health".`);

		const proc = r && r.exited === undefined ? r : startProc(l, name, s);
		const t0 = Date.now();
		const deadline = t0 + (s.startupTimeoutSec ?? 120) * 1000;
		while (Date.now() < deadline) {
			if (signal?.aborted) throw new Error("aborted");
			if (proc.exited !== undefined) {
				running.delete(name);
				throw new Error(`${name} exited (code ${proc.exited}) during startup. Last log lines:\n${tailFile(proc.logFile, 30)}\nFull log: ${proc.logFile}`);
			}
			if (await healthy(s)) return `${name}: up (${svcUrl(s)}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`;
			await new Promise((res) => setTimeout(res, 700));
		}
		throw new Error(`${name}: not healthy after ${s.startupTimeoutSec ?? 120}s. Last log lines:\n${tailFile(proc.logFile, 30)}\nFull log: ${proc.logFile}`);
	})();
	inflight.set(name, p);
	return p;
}

async function stopService(name: string): Promise<boolean> {
	const r = running.get(name);
	running.delete(name);
	if (!r?.proc.pid || r.exited !== undefined) return false;
	const kill = (sig: NodeJS.Signals) => {
		try {
			process.kill(-r.proc.pid!, sig);
		} catch {}
	};
	kill("SIGTERM");
	for (let i = 0; i < 25 && r.exited === undefined; i++) await new Promise((res) => setTimeout(res, 200));
	if (r.exited === undefined) kill("SIGKILL");
	return true;
}

async function stackStatus(l: Loaded): Promise<string> {
	const rows = await Promise.all(
		Object.entries(l.cfg.services).map(async ([name, s]) => {
			const ok = await healthy(s);
			const how = running.has(name) ? "managed" : external.has(name) ? "external" : "-";
			return `${ok ? "✓" : "✗"} ${name.padEnd(12)} ${svcUrl(s).padEnd(24)} ${how}`;
		}),
	);
	return rows.join("\n");
}

function updateStatus(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	const names = [...running.keys(), ...external];
	ctx.ui.setStatus("e2e", names.length ? `e2e: ${names.join(" ")}` : undefined);
}

// ───────────────────────── browser ─────────────────────────

let pw: typeof import("playwright") | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let device: string | undefined;
const consoleBuf: string[] = [];
const netBuf: string[] = [];
let unseenErrors = 0;

async function playwright() {
	pw ??= await import("playwright");
	return pw;
}

async function getBrowser(): Promise<Browser> {
	if (browser?.isConnected()) return browser;
	try {
		browser = await (await playwright()).chromium.launch({ headless: true });
	} catch (e) {
		throw new Error(`Could not launch Chromium. Run \`/e2e setup\` in pi (or \`npx playwright install chromium-headless-shell\`).\n${(e as Error).message}`);
	}
	return browser;
}

/** Saved browser session per test user (cookies + localStorage), so switching users needs no re-login. */
function authFile(l: Loaded, user = currentUser) {
	return path.join(artifacts(l), user ? `.auth-${user.replace(/[^\w-]/g, "_")}.json` : ".auth-state.json");
}

let currentUser: string | undefined;

async function getPage(l: Loaded, opts: { device?: string; recreate?: boolean; loggedOut?: boolean } = {}): Promise<Page> {
	const want = opts.recreate ? (opts.device ?? l.cfg.browser?.device) : (device ?? l.cfg.browser?.device);
	if (page && !page.isClosed() && !opts.recreate) return page;
	await context?.close().catch(() => {});
	const b = await getBrowser();
	const { devices } = await playwright();
	if (want && !devices[want]) throw new Error(`Unknown device "${want}". Examples: "iPhone 15", "Pixel 7", "iPad Pro 11", "Desktop Chrome".`);
	const [w, h] = l.cfg.browser?.viewport ?? [1440, 900];
	const auth = authFile(l);
	context = await b.newContext({
		...(want ? devices[want] : { viewport: { width: w, height: h } }),
		baseURL: l.cfg.browser?.baseUrl ? interp(l.cfg.browser.baseUrl, l.cfg) : undefined,
		storageState: !opts.loggedOut && existsSync(auth) ? auth : undefined,
	});
	device = want;
	consoleBuf.length = 0;
	netBuf.length = 0;
	unseenErrors = 0;
	page = await context.newPage();
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning") {
			consoleBuf.push(`[${m.type()}] ${m.text()}`.slice(0, 500));
			if (m.type() === "error") unseenErrors++;
		}
	});
	page.on("pageerror", (e) => {
		consoleBuf.push(`[pageerror] ${e.message}`.slice(0, 500));
		unseenErrors++;
	});
	page.on("requestfailed", (r) => {
		const err = r.failure()?.errorText ?? "";
		// cancelled requests (navigation away, map tiles scrolled off) are normal noise
		if (err.includes("ERR_ABORTED") || err.includes("NS_BINDING_ABORTED")) return;
		netBuf.push(`FAILED ${r.method()} ${r.url()} — ${err}`);
	});
	page.on("response", (r) => {
		if (r.status() >= 400) netBuf.push(`${r.status()} ${r.request().method()} ${r.url()}`);
	});
	return page;
}

/** Appends a short health hint so the agent notices errors without asking every time. */
function withHints(msg: string): string {
	const hints: string[] = [];
	if (unseenErrors) hints.push(`${unseenErrors} new console error(s) → browser {action:"console"}`);
	unseenErrors = 0;
	return hints.length ? `${msg}\n⚠ ${hints.join("; ")}` : msg;
}

async function settle(p: Page) {
	await p.waitForLoadState("domcontentloaded").catch(() => {});
	await p.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {}); // websockets/maps never idle
}

async function closeBrowser() {
	await browser?.close().catch(() => {});
	browser = context = page = undefined;
	device = undefined;
}

/** Downscale/encode an image to JPEG using the headless browser (no native image deps). */
async function toJpeg(png: Buffer, maxWidth: number): Promise<Buffer> {
	const b = await getBrowser();
	const p = await b.newPage();
	try {
		await p.setContent(`<style>*{margin:0}img{display:block;max-width:${maxWidth}px}</style><img src="data:image/png;base64,${png.toString("base64")}">`);
		const img = p.locator("img");
		await img.evaluate((el: HTMLImageElement) => el.decode());
		return await img.screenshot({ type: "jpeg", quality: 70 });
	} finally {
		await p.close();
	}
}

// ───────────────────────── mobile ─────────────────────────

function adbCmd(l: Loaded) {
	const a = l.cfg.mobile?.android;
	const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(os.homedir(), "Android", "Sdk");
	const bin = a?.adb ?? (existsSync(path.join(sdk, "platform-tools", "adb")) ? path.join(sdk, "platform-tools", "adb") : "adb");
	const opts = { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 };
	const withSerial = (args: string[]) => (a?.serial ? ["-s", a.serial, ...args] : args);
	return {
		text: async (args: string[]) => (await run(bin, withSerial(args), { ...opts, encoding: "utf8" })).stdout,
		bytes: async (args: string[]) => (await run(bin, withSerial(args), { ...opts, encoding: "buffer" })).stdout,
	};
}

interface UiNode {
	text: string;
	id: string;
	desc: string;
	clickable: boolean;
	cx: number;
	cy: number;
}

async function androidUi(adb: ReturnType<typeof adbCmd>): Promise<UiNode[]> {
	await adb.text(["shell", "uiautomator", "dump", "/sdcard/.pi-ui.xml"]);
	const xml = await adb.text(["exec-out", "cat", "/sdcard/.pi-ui.xml"]);
	const nodes: UiNode[] = [];
	for (const m of xml.matchAll(/<node [^>]*>/g)) {
		const a = (k: string) => m[0].match(new RegExp(` ${k}="([^"]*)"`))?.[1] ?? "";
		const b = a("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
		if (!b) continue;
		const n: UiNode = {
			text: a("text"),
			id: a("resource-id").replace(/^.*:id\//, ""),
			desc: a("content-desc"),
			clickable: a("clickable") === "true",
			cx: Math.round((+b[1] + +b[3]) / 2),
			cy: Math.round((+b[2] + +b[4]) / 2),
		};
		if (n.text || n.desc || n.id || n.clickable) nodes.push(n);
	}
	return nodes;
}

function findNode(nodes: UiNode[], query: string): UiNode {
	const q = query.toLowerCase();
	const exact = nodes.find((n) => [n.text, n.desc, n.id].some((v) => v.toLowerCase() === q));
	const hit = exact ?? nodes.find((n) => [n.text, n.desc, n.id].some((v) => v.toLowerCase().includes(q)));
	if (!hit) throw new Error(`No element matching "${query}". Use mobile {action:"ui"} to list elements.`);
	return hit;
}

// ───────────────────────── /e2e cred ─────────────────────────

async function credCommand(l: Loaded, args: string[], ctx: ExtensionContext) {
	const [sub = "list", user, to] = args;
	if (sub === "list") return ctx.ui.notify(describeCreds(l.root, l.cfg.credentials), "info");
	if (sub === "rm" || sub === "remove") {
		if (!user) throw new Error("usage: /e2e cred rm <user>");
		return ctx.ui.notify(removeCred(l.root, user) ? `removed ${user}` : `${user} is not in the private store`, "info");
	}
	if (sub === "rename" || sub === "mv") {
		if (!user || !to) throw new Error("usage: /e2e cred rename <from> <to>");
		return ctx.ui.notify(renameCred(l.root, user, to) ? `renamed ${user} → ${to}` : `${user} is not in the private store`, "info");
	}
	if (sub === "add" || sub === "set") {
		if (!user || !/^[\w-]+$/.test(user)) throw new Error("usage: /e2e cred add <user>   (letters, digits, - or _)");
		if (!ctx.hasUI) throw new Error("/e2e cred add needs the interactive UI");
		const fields: Record<string, string> = {};
		const login = await askSecret(ctx, `${user}: email or username (Esc to skip)`, false);
		if (login) fields[login.includes("@") ? "email" : "username"] = login;
		const pw = await askSecret(ctx, `${user}: password (Esc to skip)`);
		if (pw) fields.password = pw;
		for (;;) {
			const extra = await askSecret(ctx, `${user}: another field name, e.g. pin / otp_secret (Enter when done)`, false);
			if (!extra?.trim()) break;
			const v = await askSecret(ctx, `${user}.${extra.trim()}`);
			if (v) fields[extra.trim()] = v;
		}
		if (!Object.keys(fields).length) return ctx.ui.notify("nothing saved", "warning");
		saveCred(l.root, user, fields);
		return ctx.ui.notify(`🔒 saved ${user}: ${Object.keys(fields).join(", ")}  → refer to it as $CRED:${user}.<field>`, "info");
	}
	throw new Error("usage: /e2e cred [list | add <user> | rm <user> | rename <from> <to>]");
}

// ───────────────────────── extension ─────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "e2e_stack",
		label: "E2E stack",
		description:
			"Start/stop/inspect the local services declared in .pi/e2e.json (e.g. backend, frontend). " +
			"`up` starts services (and their dependsOn) in parallel and waits for health; services already running on their port are reused. " +
			"`logs` returns the last lines of a service log. `credentials` lists the test users and their fields (never values). Use before browser/mobile testing.",
		promptSnippet: "Start/stop local backend/frontend services for end-to-end testing",
		parameters: Type.Object({
			action: StringEnum(["up", "down", "status", "logs", "config", "credentials"] as const),
			services: Type.Optional(Type.Array(Type.String(), { description: "Service names; default all (for logs: first one)" })),
			lines: Type.Optional(Type.Number({ description: "logs: number of lines (default 60)" })),
		}),
		async execute(_id, p, signal, _onUpdate, ctx) {
			const l = loadConfig(ctx.cwd);
			const names = p.services?.length ? p.services : Object.keys(l.cfg.services);
			try {
				switch (p.action) {
					case "config":
						return text(redact(`${l.file}\n${JSON.stringify(l.cfg, null, 2)}`));
					case "credentials":
						return text(describeCreds(l.root, l.cfg.credentials));
					case "status":
						return text(await stackStatus(l));
					case "up": {
						const inflight = new Map<string, Promise<string>>();
						const res = await Promise.allSettled(names.map((n) => ensureUp(l, n, inflight, signal)));
						const out = [...new Set([...inflight.values()])];
						const lines = await Promise.all(out.map((x) => x.catch((e: Error) => `✗ ${e.message}`)));
						const failed = res.some((r) => r.status === "rejected");
						if (failed) throw new Error(lines.join("\n"));
						return text(lines.join("\n"));
					}
					case "down": {
						const stopped: string[] = [];
						for (const n of names) if (await stopService(n)) stopped.push(n);
						for (const n of names) external.delete(n);
						return text(stopped.length ? `stopped: ${stopped.join(", ")}` : "nothing managed was running");
					}
					case "logs": {
						const n = names[0];
						const file = path.join(artifacts(l, "logs"), `${n}.log`);
						if (!existsSync(file)) return text(`${n}: no logs (not started by e2e_stack${external.has(n) ? "; it is an external process" : ""})`);
						return text(`${clip(tailFile(file, p.lines ?? 60), 16_000)}\n(full log: ${path.relative(l.root, file)})`);
					}
				}
				throw new Error(`unknown action ${p.action}`);
			} finally {
				updateStatus(ctx);
			}
		},
	});

	pi.registerTool({
		name: "browser",
		label: "Browser",
		description:
			"Drive a headless Chromium against the app (relative URLs resolve against browser.baseUrl from .pi/e2e.json). " +
			"Actions: goto, click, fill, press, select, hover, check, wait, snapshot, text, screenshot, assert, console, network, eval, login, reset, close. " +
			"Selectors are Playwright selectors: 'role=button[name=\"Save\"]', 'text=Sign in', '#email', 'css=.row >> nth=0'. " +
			"Prefer `snapshot` (accessibility tree, cheap) to discover elements and `assert` to verify; use `screenshot` for visual/layout checks (returned as an image). " +
			"`reset` with `device` (e.g. 'iPhone 15', 'Pixel 7') emulates a mobile browser. " +
			"Multiple test users: `login {user:\"admin\"}` logs in as that user (each user keeps its own saved session); `reset {user:\"driver\"}` switches to a user's saved session. " +
			"Credentials: NEVER type literal emails/usernames/passwords. Use references in `value`: '$CRED:<user>.<field>' (e.g. '$CRED:admin.password') or '$ENV:NAME'. " +
			"List available users with e2e_stack {action:\"credentials\"}.",
		promptSnippet: "Navigate, interact with, screenshot and assert on web pages in a headless browser",
		parameters: Type.Object({
			action: StringEnum(
				["goto", "click", "fill", "press", "select", "hover", "check", "wait", "snapshot", "text", "screenshot", "assert", "console", "network", "eval", "login", "reset", "close"] as const,
			),
			url: Type.Optional(Type.String({ description: "goto: path (/login) or absolute URL. assert: substring the current URL must contain" })),
			selector: Type.Optional(Type.String()),
			value: Type.Optional(Type.String({ description: "fill/select value, press key (e.g. Enter), eval JS expression, assert: text that must appear" })),
			device: Type.Optional(Type.String({ description: "reset: Playwright device name for mobile emulation; omit for desktop" })),
			fresh: Type.Optional(Type.Boolean({ description: "reset: drop saved login state" })),
			user: Type.Optional(Type.String({ description: "login/reset: test user name from credentials (e.g. admin, driver)" })),
			fullPage: Type.Optional(Type.Boolean()),
			name: Type.Optional(Type.String({ description: "screenshot file label" })),
			attach: Type.Optional(Type.Boolean({ description: "screenshot: return the image to the model (default true)" })),
			timeoutMs: Type.Optional(Type.Number({ description: "default 10000" })),
		}),
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const l = loadConfig(ctx.cwd);
			const timeout = p.timeoutMs ?? 10_000;
			const need = (k: "selector" | "url" | "value") => {
				if (!p[k]) throw new Error(`"${k}" is required for ${p.action}`);
				return p[k]!;
			};
			if (p.action === "close") {
				await closeBrowser();
				return text("browser closed");
			}
			if (p.action === "reset") {
				if (p.user !== undefined) currentUser = p.user || undefined;
				if (p.fresh) rmSync(authFile(l), { force: true });
				await getPage(l, { device: p.device, recreate: true, loggedOut: p.fresh });
				const who = currentUser ? ` as ${currentUser}` : "";
				return text(`new ${device ?? "desktop"} context${who}${p.fresh ? " (logged out)" : existsSync(authFile(l)) ? " (saved login reused)" : " (no saved login; use login)"}`);
			}
			if (p.action === "login") {
				const users = credUsers(l.root, l.cfg.credentials);
				const user = p.user ?? l.cfg.browser?.auth?.defaultUser ?? currentUser ?? (users.length === 1 ? users[0] : undefined);
				if (p.user && !users.includes(p.user)) throw new Error(`Unknown user "${p.user}". Known:\n${describeCreds(l.root, l.cfg.credentials)}`);
				currentUser = user;
				// always start logged out, otherwise /login may redirect away before the form is filled
				await getPage(l, { recreate: true, loggedOut: true, device });
			}
			const pg = await getPage(l);
			switch (p.action) {
				case "goto": {
					const res = await pg.goto(need("url"), { waitUntil: "commit", timeout: Math.max(timeout, 30_000) });
					await settle(pg);
					await pg.waitForURL((u) => u.href !== pg.url(), { timeout: 1000 }).then(() => settle(pg)).catch(() => {});
					return text(withHints(`${res?.status() ?? "?"} → ${pg.url()} — "${await pg.title()}"`));
				}
				case "click":
					await pg.locator(need("selector")).first().click({ timeout });
					await settle(pg);
					return text(withHints(`clicked → ${pg.url()}`));
				case "fill":
					await pg.locator(need("selector")).first().fill(secret(l, p.value) ?? "", { timeout });
					return text(withHints(`filled ${p.selector}`)); // never echo the value
				case "press":
					if (p.selector) await pg.locator(p.selector).first().press(need("value"), { timeout });
					else await pg.keyboard.press(need("value"));
					await settle(pg);
					return text(withHints(`pressed ${p.value} → ${pg.url()}`));
				case "select":
					await pg.locator(need("selector")).first().selectOption(need("value"), { timeout });
					return text(withHints(`selected ${p.value}`));
				case "hover":
					await pg.locator(need("selector")).first().hover({ timeout });
					return text("hovered");
				case "check":
					await pg.locator(need("selector")).first().check({ timeout });
					return text("checked");
				case "wait":
					if (p.selector) await pg.locator(p.selector).first().waitFor({ state: "visible", timeout });
					else if (p.url) await pg.waitForURL(`**${p.url}**`, { timeout });
					else await pg.waitForTimeout(Math.min(timeout, 10_000));
					return text(withHints(`ok → ${pg.url()}`));
				case "snapshot": {
					const snap = await pg.locator(p.selector ?? "body").first().ariaSnapshot({ timeout });
					return text(withHints(`url: ${pg.url()}\n${clip(snap)}`));
				}
				case "text":
					return text(clip(await pg.locator(p.selector ?? "body").first().innerText({ timeout })));
				case "screenshot": {
					const label = p.name ?? (new URL(pg.url()).pathname.replace(/\//g, "_") || "page");
					const file = path.join(artifacts(l, "screenshots"), `${stamp(label)}.jpg`);
					const opts = { type: "jpeg" as const, quality: 70, scale: "css" as const, timeout };
					const buf = p.selector ? await pg.locator(p.selector).first().screenshot(opts) : await pg.screenshot({ ...opts, fullPage: p.fullPage });
					writeFileSync(file, buf);
					const msg = withHints(`saved ${path.relative(l.root, file)} (${pg.url()}, ${device ?? "desktop"})`);
					if (p.attach === false) return text(msg, { file });
					return { content: [{ type: "text" as const, text: msg }, { type: "image" as const, data: buf.toString("base64"), mimeType: "image/jpeg" }], details: { file } };
				}
				case "assert": {
					const checks: string[] = [];
					if (p.url) {
						if (!pg.url().includes(p.url)) throw new Error(`ASSERT FAIL: url ${pg.url()} does not contain "${p.url}"`);
						checks.push(`url contains "${p.url}"`);
					}
					if (p.selector) {
						const loc = pg.locator(p.selector).first();
						await loc.waitFor({ state: "visible", timeout }).catch(() => {
							throw new Error(`ASSERT FAIL: ${p.selector} not visible within ${timeout}ms (url ${pg.url()})`);
						});
						checks.push(`${p.selector} visible`);
					}
					if (p.value) {
						const scope = pg.locator(p.selector ?? "body").first();
						const deadline = Date.now() + timeout;
						let body = "";
						while (Date.now() < deadline) {
							body = await scope.innerText({ timeout: 1000 }).catch(() => "");
							if (body.includes(p.value)) break;
							await pg.waitForTimeout(250);
						}
						if (!body.includes(p.value)) throw new Error(`ASSERT FAIL: "${p.value}" not found in ${p.selector ?? "page"} text. Got: ${clip(body, 600)}`);
						checks.push(`text "${p.value}" present`);
					}
					if (!checks.length) throw new Error("assert needs url, selector and/or value");
					return text(withHints(`PASS: ${checks.join(", ")}`));
				}
				case "console": {
					const out = consoleBuf.splice(0);
					unseenErrors = 0;
					return text(out.length ? clip(out.join("\n")) : "(no console errors/warnings)");
				}
				case "network": {
					const out = netBuf.splice(0);
					if (!out.length) return text("(no failed requests)");
					// collapse repeats: same status+method+origin+path (query stripped) → one line with a count
					const counts = new Map<string, number>();
					for (const line of out) {
						const key = line.replace(/(https?:\/\/[^\s?#]+)[^\s]*/, "$1");
						counts.set(key, (counts.get(key) ?? 0) + 1);
					}
					const lines = [...counts].map(([k, n]) => (n > 1 ? `${k}  ×${n}` : k));
					return text(clip(lines.join("\n"), 6000));
				}
				case "eval":
					return text(clip(JSON.stringify(await pg.evaluate(need("value")), null, 1) ?? "undefined"));
				case "login": {
					const a = l.cfg.browser?.auth;
					if (!a) throw new Error('No browser.auth in .pi/e2e.json; log in manually with goto/fill/click.');
					await pg.goto(a.path, { waitUntil: "commit", timeout: 30_000 });
					await settle(pg);
					for (const [sel, v] of Object.entries(a.fields)) {
						const val = v.includes("{{")
							? (() => {
									if (!currentUser) throw new Error(`browser.auth uses {{…}} templates: pass login {user:"…"}. Known:\n${describeCreds(l.root, l.cfg.credentials)}`);
									return expandTemplate(v, currentUser, l.root, l.cfg.credentials);
								})()
							: secret(l, v);
						await pg.locator(sel).first().fill(val ?? "", { timeout });
					}
					await pg.locator(a.submit).first().click({ timeout });
					const ok = a.successSelector
						? pg.locator(a.successSelector).first().waitFor({ state: "visible", timeout: Math.max(timeout, 20_000) })
						: pg.waitForURL((u) => !u.pathname.startsWith(a.path), { timeout: Math.max(timeout, 20_000) });
					await ok.catch(async () => {
						const msg = await pg.locator("[role=alert], .error, [class*=error], [class*=toast]").allInnerTexts().catch(() => [] as string[]);
						throw new Error(`login${currentUser ? ` as ${currentUser}` : ""} failed: still on ${pg.url()}${msg.length ? `. Page says: ${clip(msg.join(" | "), 300)}` : ""}`);
					});
					await settle(pg);
					// let client-side redirects (e.g. "/" → role dashboard) finish before reporting
					for (let i = 0, last = ""; i < 10 && pg.url() !== last; i++) {
						last = pg.url();
						// first hop may wait on a dev-server compile, later hops are quick
						await pg.waitForURL((u) => u.href !== last, { timeout: i === 0 ? 15_000 : 1500 }).catch(() => {});
					}
					await settle(pg);
					await pg.context().storageState({ path: authFile(l), indexedDB: true });
					return text(withHints(`logged in${currentUser ? ` as ${currentUser}` : ""} → ${pg.url()} (session saved; switch back later with reset {user:"${currentUser ?? ""}"})`));
				}
			}
			throw new Error(`unknown action ${p.action}`);
		},
	});

	pi.registerTool({
		name: "mobile",
		label: "Mobile",
		description:
			"Drive a native mobile app. Android (adb; emulator or USB device): devices, launch, stop, install, openurl, screenshot, ui, tap, type, key, swipe, back, logcat, reverse. " +
			"iOS simulator (xcrun simctl, macOS only): devices, launch, stop, install, openurl, screenshot. " +
			"`ui` lists on-screen elements with tap coordinates; `tap` accepts `target` (text/content-desc/resource-id) or x/y. " +
			"`launch` and `reverse` map every e2e service port to the device (adb reverse) so the app can reach localhost backends. For mobile *web*, use browser reset with a device instead.",
		promptSnippet: "Drive Android (adb) / iOS simulator apps: launch, tap, type, screenshot, inspect UI",
		parameters: Type.Object({
			action: StringEnum(["devices", "launch", "stop", "install", "openurl", "screenshot", "ui", "tap", "type", "key", "swipe", "back", "logcat", "reverse"] as const),
			platform: Type.Optional(StringEnum(["android", "ios"] as const)),
			app: Type.Optional(Type.String({ description: "Android package / iOS bundle id (default from config)" })),
			target: Type.Optional(Type.String({ description: "tap: element text, content-desc or resource-id" })),
			value: Type.Optional(Type.String({ description: "type: text ($ENV:NAME supported); key: keycode e.g. ENTER, BACK; openurl/install: URL or file path" })),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			x2: Type.Optional(Type.Number()),
			y2: Type.Optional(Type.Number()),
			lines: Type.Optional(Type.Number({ description: "logcat lines (default 80)" })),
			attach: Type.Optional(Type.Boolean({ description: "screenshot: return image to the model (default true)" })),
		}),
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const l = loadConfig(ctx.cwd);
			const platform = p.platform ?? l.cfg.mobile?.platform ?? "android";
			const shot = async (png: Buffer) => {
				const jpg = await toJpeg(png, 480);
				const file = path.join(artifacts(l, "screenshots"), `${stamp(platform)}.jpg`);
				writeFileSync(file, jpg);
				const msg = `saved ${path.relative(l.root, file)}`;
				if (p.attach === false) return text(msg, { file });
				return { content: [{ type: "text" as const, text: msg }, { type: "image" as const, data: jpg.toString("base64"), mimeType: "image/jpeg" }], details: { file } };
			};

			if (platform === "ios") {
				const ios = l.cfg.mobile?.ios;
				const dev = ios?.device ?? "booted";
				const app = p.app ?? ios?.bundleId;
				const simctl = async (...args: string[]) => (await run("xcrun", ["simctl", ...args], { timeout: 60_000 })).stdout;
				switch (p.action) {
					case "devices":
						return text(await simctl("list", "devices", "booted"));
					case "launch":
						return text(await simctl("launch", dev, app ?? ""));
					case "stop":
						return text((await simctl("terminate", dev, app ?? "")) || "terminated");
					case "install":
						return text((await simctl("install", dev, p.value ?? "")) || "installed");
					case "openurl":
						return text((await simctl("openurl", dev, p.value ?? "")) || "opened");
					case "screenshot": {
						const tmp = path.join(os.tmpdir(), `pi-ios-${process.pid}.png`);
						await simctl("io", dev, "screenshot", tmp);
						return shot(readFileSync(tmp));
					}
					default:
						throw new Error(`iOS "${p.action}" is not supported by simctl. Use screenshots + openurl/deep links, or add idb/Maestro for UI interaction.`);
				}
			}

			const adbx = adbCmd(l);
			const adb = adbx.text;
			const a = l.cfg.mobile?.android;
			const app = p.app ?? a?.package;
			const reverse = async () => {
				const ports = Object.values(l.cfg.services).map((s) => s.port);
				for (const port of ports) await adb(["reverse", `tcp:${port}`, `tcp:${port}`]);
				return `adb reverse: device localhost:{${ports.join(",")}} → host`;
			};
			switch (p.action) {
				case "devices":
					return text(await adb(["devices", "-l"]));
				case "reverse":
					return text(await reverse());
				case "launch": {
					if (!app) throw new Error("app (package) required — pass app or set mobile.android.package");
					const rev = a?.reversePorts === false ? "" : (await reverse()) + "\n";
					const act = a?.activity;
					const out = act
						? await adb(["shell", "am", "start", "-W", "-n", `${app}/${act}`])
						: await adb(["shell", "monkey", "-p", app, "-c", "android.intent.category.LAUNCHER", "1"]);
					return text(rev + out.trim());
				}
				case "stop":
					await adb(["shell", "am", "force-stop", app ?? ""]);
					return text(`stopped ${app}`);
				case "install":
					return text(await adb(["install", "-r", "-g", p.value ?? ""]));
				case "openurl":
					return text(await adb(["shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", `'${p.value ?? ""}'`, ...(app ? [app] : [])]));
				case "screenshot":
					return shot(await adbx.bytes(["exec-out", "screencap", "-p"]));
				case "ui": {
					const nodes = await androidUi(adbx);
					const lines = nodes.map((n) => {
						const label = [n.text && `"${n.text}"`, n.desc && `desc="${n.desc}"`, n.id && `#${n.id}`].filter(Boolean).join(" ");
						return `${label || "(unlabeled)"} @${n.cx},${n.cy}${n.clickable ? " [tap]" : ""}`;
					});
					return text(clip(lines.join("\n") || "(no elements — screen may be a WebView/canvas; use screenshot)"));
				}
				case "tap": {
					let { x, y } = p;
					let label = `${x},${y}`;
					if (p.target) {
						const n = findNode(await androidUi(adbx), p.target);
						({ cx: x, cy: y } = n);
						label = `"${p.target}" @${x},${y}`;
					}
					if (x === undefined || y === undefined) throw new Error("tap needs target or x/y");
					await adb(["shell", "input", "tap", String(x), String(y)]);
					return text(`tapped ${label}`);
				}
				case "type": {
					const v = (secret(l, p.value) ?? "").replace(/ /g, "%s").replace(/'/g, `'\\''`);
					await adb(["shell", `input text '${v}'`]);
					return text("typed"); // never echo the value
				}
				case "key":
				case "back": {
					const key = p.action === "back" ? "BACK" : (p.value ?? "ENTER").toUpperCase().replace(/^KEYCODE_/, "");
					await adb(["shell", "input", "keyevent", `KEYCODE_${key}`]);
					return text(`key ${key}`);
				}
				case "swipe": {
					const { x = 540, y = 1600, x2 = 540, y2 = 600 } = p;
					await adb(["shell", "input", "swipe", String(x), String(y), String(x2), String(y2), "300"]);
					return text(`swiped ${x},${y} → ${x2},${y2}`);
				}
				case "logcat": {
					const pid = app ? (await adb(["shell", "pidof", app]).catch(() => "")).trim() : "";
					const args = ["logcat", "-d", "-t", String(p.lines ?? 80), ...(pid ? [`--pid=${pid}`] : ["*:W"])];
					return text(clip(await adb(args)));
				}
			}
			throw new Error(`unknown action ${p.action}`);
		},
	});

	pi.registerCommand("e2e", {
		description:
			"E2E: /e2e up|down|status [service...] | logs <service> | setup | cred [list|add <user>|rm <user>|rename <from> <to>]",
		getArgumentCompletions: (prefix) =>
			["up", "down", "status", "logs", "setup", "cred list", "cred add ", "cred rm ", "cred rename "]
				.filter((c) => c.startsWith(prefix))
				.map((c) => ({ value: c, label: c })),
		handler: async (args, ctx) => {
			const [action = "status", ...names] = args.trim().split(/\s+/).filter(Boolean);
			if (action === "cred") {
				try {
					await credCommand(loadConfig(ctx.cwd), names, ctx);
				} catch (e) {
					ctx.ui.notify((e as Error).message, "error");
				}
				return;
			}
			if (action === "setup") {
				ctx.ui.notify("downloading headless Chromium (~110 MB, once per machine)…", "info");
				try {
					const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
					const { stdout } = await run(process.execPath, [cli, "install", "chromium-headless-shell"], { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
					ctx.ui.notify(stdout.trim().split("\n").slice(-3).join("\n") || "Chromium ready", "info");
				} catch (e) {
					ctx.ui.notify(`setup failed: ${(e as Error).message}\nOn Linux you may also need system libs: sudo npx playwright install-deps chromium`, "error");
				}
				return;
			}
			try {
				const l = loadConfig(ctx.cwd);
				const targets = names.length ? names : Object.keys(l.cfg.services);
				if (action === "up") {
					ctx.ui.notify(`starting ${targets.join(", ")}…`, "info");
					const inflight = new Map<string, Promise<string>>();
					await Promise.all(targets.map((n) => ensureUp(l, n, inflight)));
					ctx.ui.notify((await Promise.all(inflight.values())).join("\n"), "info");
				} else if (action === "down") {
					for (const n of targets) await stopService(n);
					await closeBrowser();
					ctx.ui.notify("stack stopped", "info");
				} else if (action === "logs") {
					const file = path.join(artifacts(l, "logs"), `${targets[0]}.log`);
					ctx.ui.notify(tailFile(file, 25) || `${targets[0]}: no logs`, "info");
				} else {
					ctx.ui.notify(await stackStatus(l), "info");
				}
			} catch (e) {
				ctx.ui.notify((e as Error).message, "error");
			}
			updateStatus(ctx);
		},
	});

	// ───── credential safety ─────

	/** Credentials typed in chat are moved to the private store and replaced with $CRED refs before the model sees them. */
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || event.text.startsWith("/")) return { action: "continue" };
		let l: Loaded;
		try {
			l = loadConfig(ctx.cwd);
		} catch {
			return { action: "continue" }; // no e2e project here
		}
		if (l.cfg.captureCredentials === false) return { action: "continue" };
		// also catch values that are already known, e.g. pasted again later
		const known = redact(event.text);
		const users = credUsers(l.root, l.cfg.credentials);
		const { text: out, captured } = captureFromText(known, users, () => (users.includes("user") ? `user${users.length + 1}` : "user"));
		if (!captured.length) return known === event.text ? { action: "continue" } : { action: "transform", text: known, images: event.images };
		const byUser = new Map<string, Record<string, string>>();
		for (const c of captured) byUser.set(c.user, { ...(byUser.get(c.user) ?? {}), [c.field]: c.value });
		for (const [u, f] of byUser) saveCred(l.root, u, f);
		const summary = [...byUser].map(([u, f]) => `${u} (${Object.keys(f).join(", ")})`).join("; ");
		if (ctx.hasUI) ctx.ui.notify(`🔒 saved credentials for ${summary}. The model only sees $CRED references. Rename: /e2e cred rename <from> <to>`, "info");
		return {
			action: "transform",
			text: `${out}\n\n[e2e: credentials were stored securely and replaced with references: ${captured.map((c) => `$CRED:${c.user}.${c.field}`).join(", ")}. Use these references as-is in browser/mobile values; never ask for or print the real values.]`,
			images: event.images,
		};
	});

	/** Tool calls may only carry references. If the model wrote a real secret, swap it back to its reference. */
	pi.on("tool_call", async (event) => {
		if (!hasSecrets()) return;
		const red = redactDeep(event.input);
		if (red !== event.input) Object.assign(event.input, red);
	});

	/** Scrub secrets from every tool result (bash, read, browser text, logs…) before the model sees it. */
	pi.on("tool_result", async (event) => {
		if (!hasSecrets()) return;
		const content = redactDeep(event.content);
		const structured = redactDeep(event.structuredContent);
		if (content === event.content && structured === event.structuredContent) return;
		return { content, structuredContent: structured };
	});

	/** Last line of defence: scrub anything already in the conversation before each model call. */
	pi.on("context", async (event) => {
		if (!hasSecrets()) return;
		const messages = redactDeep(event.messages);
		if (messages !== event.messages) return { messages };
	});

	pi.on("session_start", async (_e, ctx) => {
		try {
			loadConfig(ctx.cwd); // registers secrets for redaction early
		} catch {}
	});

	// Last-resort cleanup if pi exits without a clean session_shutdown (crash, Ctrl+C twice).
	// Services run in their own process group, so without this they would be orphaned.
	process.once("exit", () => {
		if (loaded?.cfg.keepRunning) return;
		for (const r of running.values()) {
			if (r.proc.pid && r.exited === undefined) {
				try {
					process.kill(-r.proc.pid, "SIGTERM");
				} catch {}
			}
		}
	});

	pi.on("session_shutdown", async () => {
		await closeBrowser();
		if (loaded?.cfg.keepRunning) return;
		await Promise.all([...running.keys()].map(stopService));
	});
}
