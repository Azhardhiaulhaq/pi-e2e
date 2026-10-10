import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.PI_E2E_HOME = mkdtempSync(path.join(os.tmpdir(), "pi-e2e-test-"));
const C = await import("../lib/credentials.ts");

const cap = (t: string, users: string[] = []) => C.captureFromText(t, users, () => "user");
const leaks = (out: string, ...vals: string[]) => vals.filter((v) => out.includes(v));

test("keyed fields with named users", () => {
	const r = cap("test the dispatch flow. admin email: boss@acme.io password: Hunter#22 then driver email: d1@acme.io password: 'drive me 1'");
	assert.deepEqual(leaks(r.text, "boss@acme.io", "Hunter#22", "d1@acme.io", "drive me 1"), []);
	assert.deepEqual(
		r.captured.map((c) => `${c.user}.${c.field}=${c.value}`).sort(),
		["admin.email=boss@acme.io", "admin.password=Hunter#22", "driver.email=d1@acme.io", "driver.password=drive me 1"].sort(),
	);
});

test("email / password pair and 'login as'", () => {
	const r = cap("login as supervisor with sup@x.co / S3cret!!");
	assert.deepEqual(leaks(r.text, "sup@x.co", "S3cret!!"), []);
	assert.ok(r.captured.every((c) => c.user === "supervisor"));
});

test("one line per user, multiline", () => {
	const r = cap("users:\n- admin: admin@a.com / pw123456\n- viewer: view@a.com / qwerty99");
	assert.deepEqual(leaks(r.text, "admin@a.com", "pw123456", "view@a.com", "qwerty99"), []);
	assert.deepEqual(r.captured.find((c) => c.value === "qwerty99")?.user, "viewer");
});

test("indonesian phrasing", () => {
	const r = cap("masuk pakai ops@masa.id, kata sandi: rahasia123");
	assert.deepEqual(leaks(r.text, "ops@masa.id", "rahasia123"), []);
});

test("username field, backtick value", () => {
	const r = cap("for the tester account username is `qa_bot` and password is `p@ss w0rd`");
	assert.deepEqual(leaks(r.text, "qa_bot", "p@ss w0rd"), []);
	assert.ok(r.captured.every((c) => c.user === "tester"));
});

test("unnamed user falls back", () => {
	const r = cap("password: abcdef12");
	assert.equal(r.captured[0].user, "user");
});

test("does not capture code or schema talk", () => {
	for (const t of [
		"the password field is required",
		"password: string, email: string",
		"```\npassword: hunter2\n```",
		"set password = process.env.PASS",
		"use $CRED:admin.password for the password",
		"rename the email column",
	]) {
		assert.equal(cap(t).captured.length, 0, t);
	}
});

test("store + resolve + redact", () => {
	const root = "/tmp/proj";
	C.saveCred(root, "admin", { email: "boss@acme.io", password: "Hunter#22" });
	assert.equal(C.resolveSecret("$CRED:admin.password", root, undefined), "Hunter#22");
	assert.equal(C.expandTemplate("{{username|email}}", "admin", root, undefined), "boss@acme.io");
	assert.equal(C.redact("token for boss@acme.io pw Hunter#22"), "token for $CRED:admin.email pw $CRED:admin.password");
	assert.equal(C.redact("q=Hunter%2322"), "q=$CRED:admin.password");
	assert.throws(() => C.resolveSecret("$CRED:ghost.password", root, undefined), (e: Error) => !e.message.includes("Hunter"));
	const desc = C.describeCreds(root, { viewer: { email: "$ENV:NOPE_X", password: "$ENV:NOPE_Y" } });
	assert.ok(!desc.includes("Hunter") && desc.includes("viewer") && desc.includes("NOT SET"));
});

test("env-based credentials from config", () => {
	process.env.T_PW = "envSecret99";
	const cfg = { ops: { email: "$ENV:T_MAIL", password: "$ENV:T_PW" } };
	C.registerAll("/tmp/p2", cfg);
	assert.equal(C.resolveSecret("$CRED:ops.password", "/tmp/p2", cfg), "envSecret99");
	assert.equal(C.redact("x envSecret99 y"), "x $CRED:ops.password y");
});

test("redactDeep keeps images, returns same object when clean", () => {
	const msg = [{ type: "image", data: "Hunter#22" }, { type: "text", text: "clean" }];
	assert.equal(C.redactDeep(msg), msg);
	const dirty = [{ type: "text", text: "pw Hunter#22" }];
	assert.equal((C.redactDeep(dirty)[0] as { text: string }).text, "pw $CRED:admin.password");
});

test("more phrasings", () => {
	for (const [t, vals] of [
		["test checkout as admin (admin@masa.id / Adm1n!2024) and as driver (driver01@masa.id / Dr1ver#99)", ["admin@masa.id", "Adm1n!2024", "driver01@masa.id", "Dr1ver#99"]],
		["Log in with azhar@joinmasa.ai and password Qwerty!23", ["azhar@joinmasa.ai", "Qwerty!23"]],
		["the login for ops is ops@x.com, pwd: zz_top_77", ["ops@x.com", "zz_top_77"]],
		["user: fleetmgr  password: Fl33t!", ["fleetmgr", "Fl33t!"]],
		["password: Pa$$w0rd! and the otp is 123456", ["Pa$$w0rd!", "123456"]],
	] as [string, string[]][]) {
		assert.deepEqual(leaks(cap(t).text, ...vals), [], t);
	}
	assert.equal(cap("check that the forgot password page works").captured.length, 0);
});

test("user name comes from right before the value", () => {
	const r = cap("My message: login as qa with qa@test.dev password: Zx9!secretQ");
	assert.ok(r.captured.every((c) => c.user === "qa"), JSON.stringify(r.captured.map((c) => c.user)));
});
