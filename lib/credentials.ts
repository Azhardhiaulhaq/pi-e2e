/**
 * Credentials for e2e flows: several named users, values never shown to the model.
 *
 * Sources, in priority order, for `$CRED:<user>.<field>`:
 *   1. the private store  ~/.pi/agent/e2e/credentials.json (mode 600, outside the repo),
 *      filled by `/e2e cred add` or captured from chat
 *   2. `.pi/e2e.json` → credentials.<user>.<field>, normally "$ENV:NAME"
 *
 * The model only ever sees references (`$CRED:admin.password`). Tools resolve them at the last moment.
 * Every known value is also registered for redaction, so it's scrubbed from tool output and model context.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type CredFields = Record<string, string>;
export interface CredentialsCfg {
	[user: string]: CredFields;
}

export const FIELD_ALIASES: Record<string, string> = {
	password: "password", passwd: "password", pass: "password", pwd: "password", pw: "password", sandi: "password", "kata sandi": "password",
	email: "email", "e-mail": "email", mail: "email",
	username: "username", "user name": "username", userid: "username", "user id": "username", login: "username",
	pin: "pin", otp: "otp",
};

// ───────────── private store ─────────────

const storeDir = () => path.join(process.env.PI_E2E_HOME ?? path.join(os.homedir(), ".pi", "agent", "e2e"));
const storeFile = () => path.join(storeDir(), "credentials.json");
type Store = Record<string, Record<string, CredFields>>; // projectRoot → user → fields

function readStore(): Store {
	try {
		return JSON.parse(readFileSync(storeFile(), "utf8")) as Store;
	} catch {
		return {};
	}
}
function writeStore(s: Store) {
	mkdirSync(storeDir(), { recursive: true, mode: 0o700 });
	writeFileSync(storeFile(), JSON.stringify(s, null, 2), { mode: 0o600 });
	chmodSync(storeFile(), 0o600);
}

export function storedUsers(root: string): Record<string, CredFields> {
	return readStore()[root] ?? {};
}
export function saveCred(root: string, user: string, fields: CredFields) {
	const s = readStore();
	s[root] ??= {};
	s[root][user] = { ...(s[root][user] ?? {}), ...fields };
	writeStore(s);
	for (const [f, v] of Object.entries(fields)) registerSecret(v, `${user}.${f}`);
}
export function removeCred(root: string, user: string): boolean {
	const s = readStore();
	if (!s[root]?.[user]) return false;
	delete s[root][user];
	writeStore(s);
	return true;
}
export function renameCred(root: string, from: string, to: string): boolean {
	const s = readStore();
	if (!s[root]?.[from]) return false;
	s[root][to] = { ...(s[root][to] ?? {}), ...s[root][from] };
	delete s[root][from];
	writeStore(s);
	return true;
}

// ───────────── resolution ─────────────

function fromCfgValue(v: string | undefined): string | undefined {
	if (v === undefined) return undefined;
	if (v.startsWith("$ENV:")) return process.env[v.slice(5)] || undefined;
	return v;
}

export function credValue(root: string, cfg: CredentialsCfg | undefined, user: string, field: string): string | undefined {
	return storedUsers(root)[user]?.[field] ?? fromCfgValue(cfg?.[user]?.[field]);
}

export function credUsers(root: string, cfg: CredentialsCfg | undefined): string[] {
	return [...new Set([...Object.keys(cfg ?? {}), ...Object.keys(storedUsers(root))])];
}

/** Describes users/fields/sources without revealing any value. Safe to show to the model. */
export function describeCreds(root: string, cfg: CredentialsCfg | undefined): string {
	const users = credUsers(root, cfg);
	if (!users.length) return "(no credentials. Add with /e2e cred add <user>, or credentials in .pi/e2e.json)";
	const stored = storedUsers(root);
	return users
		.map((u) => {
			const fields = [...new Set([...Object.keys(cfg?.[u] ?? {}), ...Object.keys(stored[u] ?? {})])];
			const parts = fields.map((f) => {
				if (stored[u]?.[f] !== undefined) return `${f} (stored)`;
				const c = cfg?.[u]?.[f] ?? "";
				if (c.startsWith("$ENV:")) return `${f} (env ${c.slice(5)}${process.env[c.slice(5)] ? "" : ", NOT SET"})`;
				return `${f} (literal in e2e.json!)`;
			});
			return `${u}: ${parts.join(", ")}  → use $CRED:${u}.<field>`;
		})
		.join("\n");
}

/**
 * Resolve "$ENV:NAME" or "$CRED:user.field" to the real value. Other strings pass through.
 * Errors name the reference, never the value.
 */
export function resolveSecret(v: string | undefined, root: string, cfg: CredentialsCfg | undefined): string | undefined {
	if (v === undefined) return undefined;
	if (v.startsWith("$ENV:")) {
		const name = v.slice(5);
		const val = process.env[name];
		if (val === undefined) throw new Error(`Environment variable ${name} is not set (export it before starting pi).`);
		return val;
	}
	const m = v.match(/^\$CRED:([\w-]+)\.([\w-]+)$/);
	if (m) {
		const val = credValue(root, cfg, m[1], m[2]);
		if (val === undefined) throw new Error(`Credential ${m[1]}.${m[2]} is not set. Known:\n${describeCreds(root, cfg)}`);
		return val;
	}
	return v;
}

/** Expand {{field}} / {{email|username}} in a login form value for a given user. */
export function expandTemplate(v: string, user: string, root: string, cfg: CredentialsCfg | undefined): string | undefined {
	const m = v.match(/^\{\{\s*([\w|-]+)\s*\}\}$/);
	if (!m) return resolveSecret(v, root, cfg);
	for (const f of m[1].split("|")) {
		const val = credValue(root, cfg, user, f);
		if (val !== undefined) return val;
	}
	throw new Error(`Credential "${user}" has none of: ${m[1].split("|").join(", ")}. Known:\n${describeCreds(root, cfg)}`);
}

// ───────────── redaction ─────────────

const secrets = new Map<string, string>(); // value → label

function redactable(v: string) {
	// Very short / purely numeric values (PINs) would scramble line numbers and ids in unrelated output.
	return v.length >= 6 || (v.length >= 4 && !/^\d+$/.test(v));
}

/** Map a secret value to the reference that replaces it. `weak` labels never override an existing one. */
export function registerSecret(value: string | undefined, label: string, weak = false) {
	if (!value || !redactable(value)) return;
	for (const v of new Set([value, encodeURIComponent(value)])) if (!(weak && secrets.has(v))) secrets.set(v, label);
}

const refFor = (label: string) => (label.startsWith("env.") ? `$ENV:${label.slice(4)}` : `$CRED:${label}`);

/** Register every value reachable from config + store so it can be scrubbed. */
export function registerAll(root: string, cfg: CredentialsCfg | undefined, extraEnvRefs: string[] = []) {
	for (const u of credUsers(root, cfg)) {
		const fields = new Set([...Object.keys(cfg?.[u] ?? {}), ...Object.keys(storedUsers(root)[u] ?? {})]);
		for (const f of fields) registerSecret(credValue(root, cfg, u, f), `${u}.${f}`);
	}
	for (const name of extraEnvRefs) registerSecret(process.env[name], `env.${name}`, true);
}

export const hasSecrets = () => secrets.size > 0;

export function redact(s: string): string {
	if (!secrets.size || !s) return s;
	let out = s;
	// longest first so a value containing another is replaced whole
	for (const [v, label] of [...secrets].sort((a, b) => b[0].length - a[0].length)) {
		if (out.includes(v)) out = out.split(v).join(refFor(label));
	}
	return out;
}

/** Deep-redact any JSON-ish value. Skips image payloads. Returns the same object if nothing changed. */
export function redactDeep<T>(x: T): T {
	if (!secrets.size) return x;
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") return redact(v);
		if (Array.isArray(v)) {
			let changed = false;
			const arr = v.map((i) => {
				const r = walk(i);
				if (r !== i) changed = true;
				return r;
			});
			return changed ? arr : v;
		}
		if (v && typeof v === "object") {
			if ((v as { type?: string }).type === "image") return v;
			let changed = false;
			const o: Record<string, unknown> = {};
			for (const [k, val] of Object.entries(v)) {
				const r = walk(val);
				if (r !== val) changed = true;
				o[k] = r;
			}
			return changed ? o : v;
		}
		return v;
	};
	return walk(x) as T;
}

// ───────────── capture from chat ─────────────

const NOT_A_VALUE = /^(string|str|number|int|bool|boolean|null|none|undefined|true|false|required|optional|hashed|hash|text|varchar|any|object|is|the|a|an|and|or|of|for|to|with|same|empty|blank|field|input|\$\{.*|\$ENV:.*|\$CRED:.*|process\.env.*|<.*>|\*+|•+|x+)$/i;
const NAME_STOP = new Set(["the", "my", "his", "her", "their", "our", "your", "its", "a", "an", "with", "and", "use", "using", "is", "test", "login", "log", "user", "new", "same", "this", "that", "account", "role", "and", "then", "also", "password", "email", "username", "pin", "otp", "in", "on", "to", "of", "it", "as", "for", "by", "default", "message", "msg", "here", "please", "pls", "check", "verify", "flow", "pakai", "dengan", "masuk", "sebagai", "via", "from", "creds", "credential", "credentials", "signin", "sign"]);

export interface Captured {
	user: string;
	field: string;
	value: string;
}

/**
 * Find credentials typed in a chat message and replace them with $CRED references.
 * Recognises e.g.  "admin email: a@b.com password: hunter22", "login as driver with d@x.com / s3cret",
 * "password is `p@ss word`". Text inside ``` fences is left alone (code, not credentials).
 */
export function captureFromText(text: string, existingUsers: string[], fallbackUser: () => string): { text: string; captured: Captured[] } {
	const captured: Captured[] = [];
	const parts = text.split(/(```[\s\S]*?```)/g);
	let autoUser: string | undefined;
	/** User named in `between` (text since the previous credential), else inherit `prev`, else guess from the line. */
	const userFor = (line: string, between: string, prev: string | undefined): string => {
		const w = between
			.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, " ")
			.split(/[\s:,;()\-–*]+/)
			.map((x) => x.toLowerCase().replace(/[^\w-]/g, ""))
			.filter((x) => x && !NAME_STOP.has(x) && !FIELD_ALIASES[x] && /^[a-z][\w-]{1,30}$/.test(x))
			.pop();
		if (w) return w;
		if (prev) return prev;
		const m = [...line.matchAll(/\b(?:as|for|user|role|account)\s+(?:the\s+|an?\s+)?["'`]?([A-Za-z][\w-]{1,30})/gi)].map((x) => x[1].toLowerCase()).find((n) => !NAME_STOP.has(n));
		if (m) return m;
		const known = existingUsers.find((u) => new RegExp(`\\b${u}\\b`, "i").test(line));
		if (known) return known;
		return (autoUser ??= fallbackUser());
	};
	const val = String.raw`(?:"([^"]+)"|'([^']+)'|\x60([^\x60]+)\x60|([^\s"'\x60,;]+))`;
	const keyed = new RegExp(String.raw`\b(kata sandi|e-mail|user ?name|user ?id|password|passwd|pass|pwd|pw|sandi|email|mail|username|userid|login|pin|otp)\b(\s*[:=]\s*|\s+(?:is|adalah)\s+)` + val, "gi");
	const pair = new RegExp(String.raw`([\w.+-]+@[\w-]+(?:\.[\w-]+)+)\s*(?:\/|\s+(?:and|with|pass(?:word)?|pw)\s+(?:password\s+)?)\s*` + val, "gi");
	const userColon = /\buser\s*[:=]\s*([^\s"'`,;]+)/gi;
	const emailAfterLogin = /\b(?:log ?in|sign ?in|login|signin|masuk)\s+(?:as\s+[\w-]+\s+)?(?:with|using|as|pakai|dengan)\s+([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/gi;

	const out = parts.map((part, i) => {
		if (i % 2 === 1) return part; // fenced code
		return part
			.split("\n")
			.map((line) => {
				const found: { value: string; field: string; at: number }[] = [];
				for (const m of line.matchAll(pair)) {
					found.push({ value: m[1], field: "email", at: m.index! });
					const pw = (m[2] ?? m[3] ?? m[4] ?? m[5]).replace(/[.,;)]+$/, "");
					found.push({ value: pw, field: "password", at: m.index! });
				}
				for (const m of line.matchAll(keyed)) {
					const field = FIELD_ALIASES[m[1].toLowerCase()] ?? m[1].toLowerCase();
					const quoted = m[3] ?? m[4] ?? m[5];
					const value = quoted ?? m[6].replace(/[.,;)]+$/, "");
					found.push({ value, field: field === "username" && value.includes("@") ? "email" : field, at: m.index! });
				}
				for (const m of line.matchAll(emailAfterLogin)) found.push({ value: m[1], field: "email", at: m.index! });
				for (const m of line.matchAll(userColon)) found.push({ value: m[1], field: m[1].includes("@") ? "email" : "username", at: m.index! });
				// a line that carries a password: any bare email on it is that account's login
				if (found.length)
					for (const m of line.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g))
						if (!found.some((f) => f.value === m[0])) found.push({ value: m[0], field: "email", at: m.index! });

				let res = line;
				found.sort((a, b) => a.at - b.at);
				let prevEnd = 0;
				let prevUser: string | undefined;
				for (const f of found) {
					if (!f.value || NOT_A_VALUE.test(f.value) || f.value.length < 3) continue;
					if (captured.some((c) => c.value === f.value)) continue;
					const valueAt = Math.max(f.at, line.indexOf(f.value, f.at));
					const user = userFor(line, line.slice(prevEnd, valueAt), prevUser);
					prevEnd = Math.max(prevEnd, valueAt + f.value.length);
					prevUser = user;
					// a second value for the same user+field is a different account; keep both
					let u = user;
					for (let n = 2; captured.some((c) => c.user === u && c.field === f.field); n++) u = `${user}${n}`;
					captured.push({ user: u, field: f.field, value: f.value });
				}
				for (const c of captured) if (res.includes(c.value)) res = res.split(c.value).join(`$CRED:${c.user}.${c.field}`);
				return res;
			})
			.join("\n");
	});
	return { text: out.join(""), captured };
}
