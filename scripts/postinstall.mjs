// Runs after `pi install` / `npm install`: fetch the headless Chromium build Playwright needs.
// Never fails the install. If the download is skipped or fails, run `/e2e setup` inside pi later.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

if (process.env.PI_E2E_SKIP_BROWSER || process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) {
	console.log("[pi-e2e] skipping Chromium download (env). Run `/e2e setup` in pi when needed.");
	process.exit(0);
}
try {
	const require = createRequire(import.meta.url);
	const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
	const r = spawnSync(process.execPath, [cli, "install", "chromium-headless-shell"], { stdio: "inherit" });
	if (r.status !== 0) throw new Error(`exit ${r.status}`);
} catch (e) {
	console.warn(`[pi-e2e] Chromium download failed (${e.message}). Run \`/e2e setup\` in pi later.`);
}
