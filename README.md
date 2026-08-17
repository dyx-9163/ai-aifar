# Private AI Desktop

A private, cross-platform AI desktop client prototype built with Electron, Vue 3, TypeScript, a sandboxed renderer, a Utility Process agent runtime, and one local SQLite database.

## Commands

```powershell
pnpm install
pnpm start
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm make
```

`pnpm build` packages the app under `out/`. `pnpm test:e2e` packages the app and launches it with Playwright for a smoke test.

## Architecture

- Renderer: Vue 3 UI only. It has no direct filesystem, shell, environment, SQLite, or secret access.
- Preload: exposes a narrow `window.desktop` API through `contextBridge`.
- Main: owns Electron lifecycle, BrowserWindow security settings, and request/event forwarding.
- Utility Process: owns the demo agent runtime and SQLite persistence.
- Database: `app.sqlite` in Electron `userData`, opened with WAL, foreign keys, and busy timeout.

The E2E test sets `PRIVATE_AI_DESKTOP_USER_DATA` so test data is isolated from the real desktop profile.

## Demo Boundary

The MVP uses deterministic demo responses. It does not call a model provider, does not execute destructive tools, and does not mutate project files. Prompts containing `write`, `delete`, `修改`, or `删除` produce an approval card and remain simulated.

`node:sqlite` is used to avoid a native npm SQLite module and a Visual Studio C++ build-chain requirement. On current Node versions it may emit an experimental SQLite warning during tests.

## Packaging Notes

Forge is configured to cache Electron downloads inside `.electron-cache/` and use the Electron mirror configured in `forge.config.ts`. This keeps packaging reproducible in private-network style environments where GitHub release downloads may be blocked or slow.
