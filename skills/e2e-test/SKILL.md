---
name: e2e-test
description: End-to-end verification of web (desktop or mobile browser) and native mobile apps against locally running services. Use when asked to "test end to end", "verify in the browser/app", "check the UI", take screenshots, or validate that a feature works for a user. Also explains how to write .pi/e2e.json for a new project.
---

# E2E testing

Tools: `e2e_stack` (services), `browser` (headless Chromium), `mobile` (Android adb / iOS simulator).
All three read `.pi/e2e.json`, found by searching upward from the cwd. If it is missing, write one first (schema below).

## Workflow

1. **Plan.** Turn the request into 2–6 acceptance checks of the form "doing X shows Y". Write them down before testing.
2. **Start.** Run `e2e_stack {action:"up"}`, or name only the services you need. Services that are already running are reused.
   If startup fails, read the log tail it returns, fix the problem or report it, and stop. Do not test against a broken stack.
3. **Authenticate.** Run `e2e_stack {action:"credentials"}` to see the test users (names + fields, never values).
   Then `browser {action:"login", user:"admin"}`. Each user's session is saved separately; switch with `browser {action:"reset", user:"driver"}` (no re-login).
   **Credentials are references only:** `$CRED:<user>.<field>` (e.g. `$CRED:admin.password`) or `$ENV:NAME`. Use them as-is in `fill`/`type` values.
   If the user's message contains `$CRED:` references, the extension already stored the real values; use the references and never ask for, guess, echo or print the real values.
   Never read `.env` files or the credential store. If a needed user is missing, ask the user to run `/e2e cred add <user>`.
4. **Act and verify each check:**
   - `goto`, then `snapshot` (accessibility tree, cheap) to find selectors, then `click`/`fill`/`press`.
   - Verify with `assert` (url / selector / value). This is the source of truth for PASS/FAIL.
   - Take a `screenshot` only at checkpoints where layout or visuals matter (maps, charts, styling), or as evidence for the final report. Don't screenshot after every click.
   - If a tool result warns about console errors, read `browser {action:"console"}`. Use `network` to see 4xx/5xx and failed requests.
   - For backend-only checks, `curl` the service URL directly. No browser needed.
5. **Diagnose failures.** Collect `console`, `network`, and `e2e_stack {action:"logs", services:["backend"]}`. Fix the code, then re-run only the failing check.
6. **Report** as a table: `# | check | expected | observed | PASS/FAIL | evidence (screenshot path)`. Then list the console/network errors you saw.
7. **Clean up.** `browser {action:"close"}`. Leave services running unless the user asked otherwise (`e2e_stack {action:"down"}` stops them).

## Multi-user flows
For flows that involve several roles (e.g. admin creates a job → driver accepts → admin sees it accepted):
1. `login {user:"admin"}`, do the admin step, assert.
2. `login {user:"driver"}` (or `reset {user:"driver"}` if already logged in once), do the driver step, assert.
3. `reset {user:"admin"}` to switch back. Report which user performed each check in the table.
For permission checks, log in as each role and assert what it can/can't see.

## Selectors (Playwright)
`role=button[name="Save"]`, `role=link[name=/vehicles/i]`, `text=Sign in`, `#email`, `[data-testid=row] >> nth=0`, `css=.card:has-text("Idle")`.
Prefer role/text selectors taken from `snapshot` over brittle CSS.

## Mobile
- **Mobile web / responsive:** `browser {action:"reset", device:"iPhone 15"}` (or `"Pixel 7"`, `"iPad Pro 11"`). `reset` with no device returns to desktop. A saved login is kept unless `fresh:true`.
- **Native Android:** `mobile {action:"devices"}`, then `launch` (also runs `adb reverse` so the app can reach `localhost:<port>`), then `ui` (elements with tap coordinates), `tap {target:"Login"}`, `type {value:"$CRED:driver.email"}`, `key {value:"ENTER"}`, `screenshot`, `logcat`.
- **iOS simulator (macOS):** `devices`, `launch`, `openurl`, `screenshot`. Use deep links for navigation.
- Screens that are WebViews or Flutter canvases may expose few `ui` elements. Use `screenshot` and tap by `x`/`y` instead.

## .pi/e2e.json schema
```jsonc
{
  "artifactsDir": ".e2e-artifacts",          // screenshots/, logs/, saved login (gitignore it)
  "keepRunning": false,                       // keep services alive after pi exits
  "credentials": {                            // named test users; values are env refs, never literals
    "admin":  { "email": "$ENV:E2E_ADMIN_EMAIL", "password": "$ENV:E2E_ADMIN_PASS" },
    "driver": { "username": "$ENV:E2E_DRIVER_USER", "password": "$ENV:E2E_DRIVER_PASS" }
  },                                          // users can also be added privately: /e2e cred add <user>
  "captureCredentials": true,                 // credentials typed in chat → private store + $CRED refs
  "services": {
    "<name>": {
      "cwd": "path/relative/to/project/root",
      "command": "shell command; ${PORT} is this service's port",
      "port": 3000,
      "health": "/health",                    // HTTP path; <500 = healthy. Omit → TCP port check
      "env": { "API_URL": "${api.url}" },     // ${<svc>.url} ${<svc>.port} ${env:NAME}
      "dependsOn": ["api"],                   // only when it must be healthy first
      "startupTimeoutSec": 120
    }
  },
  "browser": {
    "baseUrl": "${web.url}",
    "viewport": [1440, 900],
    "device": "iPhone 15",                    // optional default emulation
    "auth": { "path": "/login",
              "fields": { "#email": "{{email|username}}", "#password": "{{password}}" },  // filled from the chosen user
              "submit": "button[type=submit]", "successSelector": "optional", "defaultUser": "admin" }
  },
  "mobile": {
    "platform": "android",                    // or "ios"
    "android": { "package": "com.example.app", "activity": ".MainActivity", "serial": "emulator-5554", "reversePorts": true },
    "ios": { "bundleId": "com.example.app", "device": "booted" }
  }
}
```
