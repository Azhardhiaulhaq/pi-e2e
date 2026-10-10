# pi-e2e

A [pi](https://pi.dev) package that lets the agent **verify its own work end to end**:
it starts your local services, drives a headless browser (desktop or an emulated phone) or a native Android/iOS app, takes screenshots it can actually *see*, and asserts on results.

Works with any project. Each repo describes its services in one file: `.pi/e2e.json`.

## Install

```bash
pi install git:github.com/Azhardhiaulhaq/pi-e2e          # latest main, all projects
pi install git:github.com/Azhardhiaulhaq/pi-e2e@v0.2.0   # pinned to a release (recommended)
pi install -l git:github.com/Azhardhiaulhaq/pi-e2e@v0.2.0  # this project only (.pi/settings.json)
```

The install clones the repo, runs `npm install`, and downloads headless Chromium (~110 MB, once per machine).
In a pi session that is already open, run `/reload`.

If the Chromium download was skipped or failed (offline, proxy), run this inside pi:
```
/e2e setup
```
On a fresh Linux box Chromium may also need system libraries: `sudo npx playwright install-deps chromium`.

Update or remove:
```bash
pi update --extensions          # moves unpinned installs to the latest main
pi remove git:github.com/Azhardhiaulhaq/pi-e2e
pi list                         # see what's installed
```
Try it without installing: `pi -e git:github.com/Azhardhiaulhaq/pi-e2e`.

## Quick start (3 steps)

**1. Describe your services** in `<project>/.pi/e2e.json` (copy [`examples/e2e.json`](examples/e2e.json)):

```jsonc
{
  "services": {
    "api": { "cwd": "backend",  "command": "uvicorn app.main:app --port ${PORT}", "port": 8000, "health": "/health" },
    "web": { "cwd": "frontend", "command": "pnpm exec next dev --port ${PORT}",  "port": 3000, "health": "/",
             "env": { "NEXT_PUBLIC_API_BASE_URL": "${api.url}" } }
  },
  "browser": {
    "baseUrl": "${web.url}",
    "auth": { "path": "/login", "fields": { "#email": "$ENV:E2E_USER", "#password": "$ENV:E2E_PASS" }, "submit": "button[type=submit]" }
  }
}
```
Or just ask pi: *"set up .pi/e2e.json for this repo"*. The bundled skill knows the schema.

**2. Export test credentials** before starting pi (never put them in prompts or config):
```bash
export E2E_USER=qa@example.com E2E_PASS='...'
```

**3. Ask for a verified change:**

> Fix the vehicle filter, then verify end to end: start the stack, log in, open /vehicles, filter status = Idle, confirm only idle units show. Screenshot before/after and give me a PASS/FAIL table.

> Check that the dashboard is usable on iPhone 15: no horizontal scroll, menu opens.

> Launch the Android app against my local backend, log in, and screenshot the trip list.

## What you get

| | What it does |
|---|---|
| `e2e_stack` tool | `up` / `down` / `status` / `logs` / `config` for services in `.pi/e2e.json`. Starts in parallel, health-checked, reuses services that are already running, kills the whole process tree on exit. |
| `browser` tool | Playwright Chromium: `goto click fill press select hover check wait snapshot text screenshot assert console network eval login reset close`. `reset {device:"iPhone 15"}` = mobile web. |
| `mobile` tool | Android via adb (`devices launch stop install openurl screenshot ui tap type key swipe back logcat reverse`). iOS simulator via `xcrun simctl` (`devices launch stop install openurl screenshot`). |
| `/e2e` command | For you: `/e2e up`, `/e2e down`, `/e2e status`, `/e2e logs api`, `/e2e setup`. |
| `e2e-test` skill | Test procedure + full config schema. Loaded by the agent only when needed. |

## Config reference

Full schema with comments: [`skills/e2e-test/SKILL.md`](skills/e2e-test/SKILL.md).

- `${PORT}` / `${URL}`: this service. `${name.url}` / `${name.port}`: another service. `${env:NAME}`: an env var.
- Without `health`, the check is just "is the TCP port open". Use a cheap endpoint that returns < 500.
- Use `dependsOn` only if a service *must* wait for another. Otherwise everything starts in parallel.
- `keepRunning: true` leaves services up after pi exits.
- `.pi/e2e.json` is found by searching upward from the cwd, so one file at a monorepo root covers every sub-folder.

## Where output goes

Everything goes to `<project>/.e2e-artifacts/` (`artifactsDir`). That folder writes its own `.gitignore`, so nothing in it gets committed:
- `logs/<service>.log`: service stdout/stderr
- `screenshots/<session>-<n>-<label>.jpg`
- `.auth-state.json`: saved login session (cookies + localStorage). Treat it like a password. `browser {action:"reset", fresh:true}` deletes it.

## Security

- Credentials: use `$ENV:NAME` only. Values filled from env vars are never echoed in tool results.
- `.pi/e2e.json` contains shell commands that pi runs. Review it in repos you don't trust, the same as a `Makefile`.
- `browser eval` runs arbitrary JS in the page under test. That's intended for debugging your own app.

## Design notes (why it's fast and cheap)

- `snapshot` (accessibility tree) finds elements in a few hundred tokens, vs. thousands for an image.
- Screenshots are JPEG q70 at CSS scale (~15–25 KB). `attach:false` saves to disk without sending to the model.
- Every action reports new console errors inline, so the agent notices breakage without polling.
- Page waits are bounded (`networkidle` max 3 s), so apps with websockets or maps don't hang.

## Mobile notes

- **Android:** emulator or USB device with debugging on. `launch` runs `adb reverse` for every service port, so the app can use `http://localhost:8000` the same as the host does. `ui` lists elements with tap coordinates. Flutter/WebView screens may expose few nodes, so use `screenshot` + `tap {x,y}`.
- **iOS:** macOS + a booted Simulator. simctl has no tap/type, so use deep links (`openurl`) + screenshots.

## Requirements

- pi ≥ 1.1, Node ≥ 20, Linux or macOS (services are started with `/bin/bash`; Windows is not supported yet).
- Android: `adb` on PATH or `$ANDROID_HOME`. iOS: Xcode command-line tools.

## Develop

```bash
git clone git@github.com:Azhardhiaulhaq/pi-e2e.git && cd pi-e2e
npm install --legacy-peer-deps
npm run typecheck
pi install ./        # load your working copy instead of the git install
```

Release: bump `version` in `package.json`, add a `CHANGELOG.md` entry, then `git tag vX.Y.Z && git push --tags`.

## License

MIT
