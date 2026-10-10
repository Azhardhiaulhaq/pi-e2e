# Changelog

## 0.3.0
- **Multiple test users.** `credentials` in `.pi/e2e.json` (env refs) and/or a private per-machine store (`~/.pi/agent/e2e/credentials.json`, mode 600).
- `browser login {user}` / `reset {user}`: one saved session per user, so switching roles needs no re-login. `browser.auth.fields` accepts `{{email|username}}` / `{{password}}` templates and `defaultUser`.
- `$CRED:<user>.<field>` references for `fill` / mobile `type`.
- **Credentials typed in chat never reach the model.** They're stored privately and replaced with `$CRED` references before the message is sent.
- Every known secret is scrubbed from tool calls, tool results (incl. bash/read) and the model context.
- `/e2e cred list | add <user> | rm <user> | rename <from> <to>` with a masked input prompt.
- `e2e_stack {action:"credentials"}` lists users and fields, never values.
- Unit tests (`npm test`).

## 0.2.0
- Installable with `pi install git:github.com/Azhardhiaulhaq/pi-e2e`. Chromium is downloaded on install (postinstall), with `/e2e setup` as a fallback.
- The artifacts dir writes its own `.gitignore`, so saved login cookies and logs are never committed.
- Screenshot names are prefixed with the session timestamp, so runs don't overwrite each other.
- Managed services are killed if pi exits without a clean shutdown.
- Added an example config, LICENSE, CI typecheck.

## 0.1.0
- Initial version: `e2e_stack`, `browser`, `mobile` tools, `/e2e` command, `e2e-test` skill.
