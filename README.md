# Private AI Desktop

A private, cross-platform AI desktop client prototype built with Electron, Vue 3, TypeScript, a sandboxed renderer, a Utility Process agent runtime, and one local SQLite database. It supports deterministic demo turns and provider-declared OpenAI-compatible model profiles.

## Install and run

```powershell
pnpm install
pnpm start
```

Model profiles are configured under **Settings → Model providers**. Configure the endpoint base URL (for example `http://127.0.0.1:8080/v1`), model name, optional API key, reasoning capabilities, native reasoning outputs, and maximum concurrent turns. A connection test proves endpoint reachability only; it does not infer or certify model capabilities.

API keys stay in the Utility Process and SQLite model-profile record. They are redacted from renderer snapshots and must not appear in items, turn errors, or emitted events.

## Provider capability contract

Controls come from the selected profile's declared capabilities rather than a model-name guess:

- `reasoning.inputMode`: `unsupported`, `toggle`, `effort`, or explicitly unverified `custom`.
- `reasoning.effortOptions`: provider-declared opaque values. The UI does not invent a universal low/medium/high scale.
- `reasoning.outputModes`: `raw`, `summary`, both, or neither. `summary` means a summary returned natively by the provider.
- `concurrency`: the default/configurable limit and optional maximum for that profile.
- `streaming` and `usage`: whether streaming and token/reasoning-token usage are declared.

An unsupported or unverified capability remains visible as unavailable; the client does not silently remove a rejected reasoning parameter and pretend it was applied.

### Qwen thinking

For a Qwen profile, use a `toggle` reasoning input, protocol `qwen`, and declare `raw` output when the endpoint returns `reasoning_content`. At request time:

- thinking enabled sends `chat_template_kwargs.enable_thinking = true`;
- thinking disabled sends `chat_template_kwargs.enable_thinking = false`.

The Qwen template exposes thinking on/off, not fabricated reasoning-effort levels. If it returns raw reasoning but no `reasoning_summary`, explicit summary display reports that a native summary is unavailable. The desktop never creates a summary with a second model call or heuristic truncation.

## Turns, queueing, and restart behavior

Each chat may have at most one queued, running, or cancelling turn. Capacity and FIFO order are enforced independently for each `modelProfileId`:

- limit `1`: the first chat runs and later chats using the same profile queue in submission order;
- limit `2`: two chats using that profile can run simultaneously;
- different profiles have independent queues;
- cancelling queued work removes it once; cancelling running work releases one slot when the abort settles.

Background events remain scoped to their source chat and do not change the selected chat.

After an application/runtime restart, persisted `queued`, `running`, or `cancelling` turns become `interrupted`. They are never replayed automatically. Review the incomplete content and explicitly resend the prompt if another model request is desired.

## Reasoning streams and metrics

The final answer, raw reasoning, and native reasoning summary are independent streams through provider parsing, IPC events, client state, SQLite, and UI rendering. Copying/selecting the answer does not include reasoning panel content; reasoning has its own copy action.

Reasoning effort is a provider request option. It is not a performance measurement. Duration, time to first token, token usage, and tokens per second are recorded per turn when the endpoint supplies enough usage/timing data. Tokens per second is measured server-side when reported, otherwise derived from completion tokens and elapsed time; when neither is available it remains unavailable. The UI does not claim a configurable “speed” that the provider did not declare.

## Verification commands

```powershell
pnpm test
pnpm typecheck
pnpm test:e2e
pnpm make
```

`pnpm test:e2e` packages the app, starts the packaged Windows executable, and runs deterministic Electron acceptance against an in-process fake OpenAI-compatible SSE server. It covers per-profile FIFO/concurrency, background focus isolation, queued/running cancellation, answer/raw/summary separation by item identity, browser selection/copy behavior, restart interruption, bounded SQLite rows, and a controlled provider-error secret scan. Screenshots and Playwright diagnostics are written below ignored `test-results/`.

The live Qwen suite is explicitly opt-in and does not import or start the project's fake E2E server. The operator selects the endpoint. Without `PRIVATE_AI_LIVE_MODEL_E2E=1` the suite skips before probing or launching Electron. When enabled, it probes `${PRIVATE_AI_LIVE_MODEL_BASE_URL}/models` first (default `http://127.0.0.1:8080/v1`) and requires that response to list the configured model name. An unreachable endpoint, non-success response, invalid model list, or model-name mismatch produces an explicit skip reason.

```powershell
# Explicit opt-in, followed by endpoint/model values shown at their defaults.
$env:PRIVATE_AI_LIVE_MODEL_E2E = '1'
$env:PRIVATE_AI_LIVE_MODEL_BASE_URL = 'http://127.0.0.1:8080/v1'
$env:PRIVATE_AI_LIVE_MODEL_NAME = 'Qwen3.5-9B'
# $env:PRIVATE_AI_LIVE_MODEL_API_KEY = '<set only when required>'

pnpm package
& .\node_modules\.bin\playwright.CMD test tests/e2e/live-model.spec.ts --workers=1
```

The live suite requires a non-empty final answer, independently identified raw Qwen reasoning and answer items for the same turn, native-summary unavailability, answer-copy selection scoped outside the reasoning DOM, and turn-scoped duration/tokens-per-second metrics when available. It does not reject legitimate answer text merely because it overlaps reasoning text, and it does not compare rendered Markdown text byte-for-byte with the persisted Markdown source.

## Architecture

- Renderer: Vue 3 UI only. It has no direct filesystem, shell, environment, SQLite, or secret access.
- Preload: exposes a narrow `window.desktop` API through `contextBridge`.
- Main: owns Electron lifecycle, BrowserWindow security settings, and request/event forwarding.
- Utility Process: owns scheduling, model calls, the demo agent runtime, and SQLite persistence.
- Database: `app.sqlite` in Electron `userData`, opened with WAL, foreign keys, and busy timeout.

E2E tests set `PRIVATE_AI_DESKTOP_USER_DATA` so their databases are isolated from the real desktop profile.

## Demo and packaging notes

Demo mode does not call a model provider, execute destructive tools, or mutate project files. Prompts containing `write`, `delete`, `修改`, or `删除` produce an approval card and remain simulated.

`node:sqlite` avoids a native npm SQLite module and a Visual Studio C++ build-chain requirement. Current Node versions may emit an experimental SQLite warning during tests.

Forge caches Electron downloads under `.electron-cache/` and uses the Electron mirror configured in `forge.config.ts`. `pnpm package` writes the unpacked app under `out/`; `pnpm make` produces the configured distributable artifact.
