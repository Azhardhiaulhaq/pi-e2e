# Changelog

## 0.2.0
- Installable with `pi install git:github.com/Azhardhiaulhaq/pi-e2e`. Chromium is downloaded on install (postinstall), with `/e2e setup` as a fallback.
- The artifacts dir writes its own `.gitignore`, so saved login cookies and logs are never committed.
- Screenshot names are prefixed with the session timestamp, so runs don't overwrite each other.
- Managed services are killed if pi exits without a clean shutdown.
- Added an example config, LICENSE, CI typecheck.

## 0.1.0
- Initial version: `e2e_stack`, `browser`, `mobile` tools, `/e2e` command, `e2e-test` skill.
