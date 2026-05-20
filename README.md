# AUTOcarl

Desktop app that automates crew-site timecard entry and expense-report PDF filling for the team.

## Status

Early scaffold. Hours-submission flow first; expense PDFs next.

## Stack

- Electron + React + TypeScript (Vite)
- Playwright — browser automation against the crew site
- pdf-lib — PDF form-field filling
- keytar — OS keychain for per-user site credentials (never plaintext)

## Develop

```bash
npm install
npm run dev
```

## Build a distributable

```bash
# Mac (universal — Apple Silicon + Intel, builds both DMGs)
npm run dist:mac

# Windows (build on a Windows machine for best results)
npm run dist:win
```

Output lands in `release/<version>/`:
- `AUTOcarl-0.1.0-arm64.dmg` — Apple Silicon Mac
- `AUTOcarl-0.1.0-x64.dmg` — Intel Mac
- `AUTOcarl-0.1.0-portable.exe` — Windows (no install, double-click to run)

### Standalone, no install dependencies on the user side
Teammates do not need Node.js, npm, or any developer tools. They just download the file for their OS and open it. Credentials live in the OS keychain (macOS Keychain / Windows Credential Manager). All data stays on their machine.

### Cross-compilation notes
- Mac → Mac (both arches): works from any Mac.
- Mac → Windows: works but unsigned — Windows SmartScreen will show a warning the first time. For a signed binary, build on a Windows machine with a code-signing certificate.
- Native dependency (`keytar`) rebuilds per target via `electron-builder install-app-deps`.

## Architecture

- `src/main/` — Electron main process. Owns Playwright runs, keytar access, PDF generation. Never exposed to renderer directly.
- `src/preload/` — Bridges a typed IPC API into the renderer. The renderer can ONLY call what's exposed here.
- `src/renderer/` — React UI. Pure UI; all side effects go through the preload bridge.
- `src/shared/` — Types shared between main and renderer.
- `src/automation/` — Playwright scripts. Pure functions that take config + return result.
