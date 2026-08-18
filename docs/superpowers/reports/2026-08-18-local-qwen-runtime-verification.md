# Local Qwen Runtime Verification

**Acceptance date:** 2026-08-18 (Asia/Shanghai)
**Host:** Windows acceptance host (hostname omitted)
**Repository/branch:** `D:\workspace\AI\2026-08-14\ai-aifar`, `main`
**Runtime handoff target:** GPU, one slot, 16,384-token context
**Overall result:** Accepted at the safe `1/16384` default, subject to the unverified limits below.

This report intentionally contains no API key, prompt body, response body, GGUF content, or local `.env` content.

## Artifact identity

Fresh SHA-256 and length checks matched the read-only source inventory and both local target copies:

| Artifact | Length (bytes) | SHA-256 | Source/target match |
| --- | ---: | --- | --- |
| `Qwen_Qwen3.5-9B-Q4_K_M.gguf` | 6,169,341,984 | `D784CE9EDA1A5A7B51E8F705A9E6310844BF4F173654D115823C775FDEA56D43` | Yes |
| `mmproj-Qwen_Qwen3.5-9B-bf16.gguf` | 921,704,896 | `D89C4BC142D02ED64AEED5C0A358BDEAD9109F21F4ADA03A6B2DF17A1AA94D9E` | Yes |

The target files remained local and ignored. Packaging and Git leak checks are recorded below.

## Non-live gates before runtime mutation

| Gate | Result | Evidence |
| --- | --- | --- |
| `pnpm test` | Pass | 19 files, 364 tests passed. Only the known Node SQLite experimental warning appeared. |
| `pnpm typecheck` | Pass | Vue, Node, and type-test TypeScript checks exited 0. |
| Compose config | Pass | `docker compose -f model-runtime/compose.yaml --profile "*" config --quiet` exited 0. Direct invocation warned that local override variables were unset; the checked Compose defaults remained valid. |
| `pnpm package` | Pass | Forge produced `out/Private AI Desktop-win32-x64`. The previously observed executable lock did not recur. |
| Outer package exclusion scan | Pass | 75 filesystem paths inspected under `out/Private AI Desktop-win32-x64`; zero matches for `models`, `model-runtime`, `*.gguf`, or a path-ending local `.env`. |
| ASAR archive exclusion scan | Pass | The installed local `asar.CMD` listed 878 entries from `resources/app.asar`; zero matches for `models`, `model-runtime`, `*.gguf`, or a path-ending local `.env`. |

## Safe port ownership and runtime start

The initial sandboxed TCP/Docker inspection was permission-denied. The same two read-only checks were rerun with narrowly scoped elevated access. They found no listener on TCP 8080 and no Docker container publishing 8080, so no host process and no legacy Compose project was stopped.

The task brief used the stale spelling `-Mode gpu`; parameter binding failed before the script body or Docker mutation. The repository script and its advisory matrix declare `-Profile gpu`. The tracked design documentation and root README now use the real interface. Windows also required `-ExecutionPolicy Bypass`; it was supplied only to the spawned PowerShell process and no machine execution policy was changed.

The successful independent start was:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File model-runtime/start-model.ps1 -Profile gpu
```

GPU became healthy on the first real start. No hybrid fallback occurred.

## Direct runtime verification

| Check | Verified result |
| --- | --- |
| Compose ownership | Project `ai-aifar-model`, service `llama-gpu`, image `ghcr.io/ggml-org/llama.cpp:server-cuda` |
| Bind | `127.0.0.1:8080->8080/tcp` only |
| `/health` | `status=ok` |
| `/v1/models` | Exact alias `Qwen3.5-9B` present |
| `/slots` | Exactly one idle slot, slot context 16,384 |
| `/props` | Reachable, `total_slots=1`, context size 16,384 |
| Artifact verification | Both lengths and SHA-256 values passed before start and bounded verification |
| Completion verification | One non-thinking UTF-8 completion succeeded; one concurrent request verified |
| Active profile | GPU; fallback not used |

No proxy was involved: the scripts and desktop both addressed loopback llama.cpp directly.

## Live packaged desktop acceptance and proven correction

The first opt-in run reached a completed turn with raw reasoning but no final-answer item. It failed after 46.7 seconds at the assistant-message assertion. Redacted container timing metadata showed exactly 2,048 generated tokens and the live fixture had inherited the 2,048-token profile default, so generation exhausted its bound before emitting final-answer content. The application correctly did not relabel raw reasoning as an answer.

A single-request diagnostic with a 4,096-token client bound finished normally and had non-empty reasoning and answer fields; only finish reason, lengths, and token counts were inspected. The minimal correction made the live acceptance fixture explicitly set `maxOutputTokens: 4096`. No product preset or global output default changed. Existing provider/database request-bound contracts then passed (2 files, 65 tests).

The corrected direct command passed:

```powershell
$env:PRIVATE_AI_LIVE_MODEL_E2E = '1'
$env:PRIVATE_AI_LIVE_MODEL_BASE_URL = 'http://127.0.0.1:8080/v1'
$env:PRIVATE_AI_LIVE_MODEL_NAME = 'Qwen3.5-9B'
& .\node_modules\.bin\playwright.CMD test tests/e2e/live-model.spec.ts --workers=1
```

Result: 1 test passed in 16.8 seconds. The test verified exact model identity, a completed real turn, raw reasoning and final answer as separate same-turn items, native-summary unavailability, answer-only copy scope, and turn-scoped metrics. It launched the packaged executable directly and did not import or start the fake model server.

## Lifecycle independence

The successful live test completed a direct chat and closed only its Playwright-owned packaged Electron process. Immediately after that exit:

- Compose still showed the same GPU container healthy on loopback port 8080.
- `/health` still returned `status=ok`.

`stop-model.ps1` then removed only `ai-aifar-model-llama-gpu-1` and its project network. It did not pass `--volumes`. After the stop, the project row count and TCP-8080 listener count were both zero.

A fresh packaged desktop was launched with isolated temporary user data while the model remained stopped. Its local-Qwen connection test reached the `offline` state, displayed `model-runtime\start-model.ps1` as independent text guidance, and exposed zero Start/Stop/Restart/Status lifecycle controls. Playwright closed the exact executable/PID it launched and removed only that temporary user-data directory. A second check still found zero project containers and zero port listeners, proving the client did not auto-restart the model.

The model was then started independently again. The required handoff state is GPU healthy at `1/16384`.

## Concurrency decision

Acceptance remained at `LLAMA_PARALLEL=1` and `LLAMA_CTX_SIZE=16384`, with one verification request. The explicitly optional `2/32768` probe was not exercised, so no claim is made for two-slot VRAM stability, latency, or CUDA behavior. Desktop concurrency remains a separate client-side limit and was not synchronized with runtime slots.

## Design acceptance mapping

| Design acceptance criterion | Implemented by | Acceptance evidence/status |
| --- | --- | --- |
| Repository runs Qwen without operational dependency on `D:\workspace\AI\aifar` | Tasks 1-3, 8 | Runtime uses repository-relative target artifacts. Target hashes match source; start/status/verify run entirely from this repository. Accepted. |
| No `context-proxy` code, image, container, cache, or request path | Tasks 2, 6, 8 | Direct loopback Compose/provider path plus final forbidden-string review. Accepted; remaining mentions are negative tests/documentation only. |
| Model starts/stops only through operator commands | Tasks 3, 7, 8 | Scoped scripts performed the only runtime mutations; desktop exposes guidance but no lifecycle controls. Accepted. |
| Desktop start/exit/restart does not own model lifecycle | Tasks 5, 7, 8 | Container survived direct-chat client exit; stopped runtime stayed stopped through a fresh desktop launch. Static source review finds no Docker lifecycle coupling. Accepted for normal exit/relaunch; forced crash was not physically injected. |
| Desktop connects to exact `Qwen3.5-9B`, never silently to `your-model-name` | Tasks 4, 5, 8 | `/v1/models`, connection logic, bounded verification, and live test all used the exact alias. Accepted. |
| Runtime and desktop concurrency are separate, observable, mismatch-safe | Tasks 2, 5, 7, 8 | One runtime slot observed; UI contract tests cover mismatch diagnostics; README documents independent controls. Accepted at one slot. |
| Thinking, raw reasoning, final answer, output bounds, and normalization pass | Tasks 4, 6-8 | Unit/provider contracts and corrected live packaged test passed. The initial bound-exhaustion failure is documented rather than hidden. Accepted at the explicit live-fixture bound. |
| GGUF files are local, hash-verified, untracked, and absent from packages | Tasks 1, 3, 8 | Fresh source/target hashes match; both the outer package scan and the 878-entry ASAR scan found zero forbidden paths; final Git leak check contains only tracked metadata. Accepted. |

## Branch commits before the documentation commit

```text
bccc991d chore: protect local model runtime artifacts
858166bb feat: add standalone direct qwen runtime
9a2d2ec3 fix: remove inert runtime timeout
27ba622c feat: add independent model lifecycle scripts
1df79702 fix: harden model runtime lifecycle guards
8334ff7f feat: add direct local qwen profile
36d2a7cc fix: seed qwen preset after id collision
3b9ae983 feat: validate local model and slots
93c941eb fix: bound and normalize model streams
82fe598c feat: show direct model diagnostics
08794b06 fix: harden model connection diagnostics
343ac910 test: stabilize live qwen acceptance bound
```

The list is chronological through the separately committed live-fixture correction. The Task 8 documentation commit is reported in the operator handoff because a commit cannot include its own hash. No commit was pushed.

## Final fresh gate

| Final command/check | Fresh result |
| --- | --- |
| `pnpm test` | Pass: 19 files, 364 tests |
| `pnpm typecheck` | Pass |
| `pnpm test:e2e` | Pass: 9 packaged Electron tests in 8.4 seconds; the suite-owned processes/server closed cleanly |
| `pnpm package` | Pass; no executable lock or launch timeout |
| Compose config | Pass with the same non-fatal unset-override warnings noted above |
| Final outer package exclusion scan | 75 filesystem paths, 0 forbidden `models`/`model-runtime`/GGUF/local-`.env` matches |
| Final ASAR exclusion scan | Reproducible command used installed `node_modules\.bin\asar.CMD list` on `resources/app.asar`: 878 archive entries, 0 forbidden `models`/`model-runtime`/GGUF/local-`.env` matches |
| Independent GPU restart | Pass; healthy after the deterministic E2E suite released port 8080 |
| `verify-model.ps1 -ConcurrentRequests 1` | Pass: both artifacts, direct endpoints, exact alias/slot contract, and one bounded UTF-8 completion |
| Proxy search | Only the README's negative no-proxy statement and a negative Compose regression assertion mention `context-proxy`/`UPSTREAM_URL` |
| Desktop lifecycle-coupling search | No matches for `modelRuntime.start`, `modelRuntime.stop`, or `docker compose` under `src` |
| `git ls-files models model-runtime/.env` | Only tracked metadata `models/README.md`; no GGUF and no local `.env` |
| `git diff --check` | Pass; Git emitted only expected LF-to-CRLF working-copy notices |

Immediately before the documentation commit, the uncommitted snapshot contained only the intended README, design-interface correction, and this report. The branch already contained the live-fixture correction in separate commit `343ac910`. The documentation commit and post-commit status are recorded in the implementer handoff. No push was performed.

## Unverified limits and operational notes

- CPU and hybrid profiles were not started live because GPU succeeded; the one permitted fallback path was therefore not exercised.
- Runtime parallelism 2 and 32,768 total context were not probed.
- Forced Electron crash was not injected. Normal close and a fresh offline relaunch were verified, and source/test inspection covers absence of lifecycle APIs.
- The production local-Qwen preset remains intentionally reasoning-disabled with a 2,048-token output default. The live reasoning fixture uses 4,096 because the first accepted-host sample exhausted 2,048 tokens before a final answer.
- Direct Compose config validation emitted non-fatal unset-override warnings; runtime scripts explicitly load `model-runtime/.env` (or `.env.example`) and the live runtime reported the accepted effective slot/context values.
- Docker and TCP ownership inspection required narrowly scoped elevated execution on this host. No host process was killed, no ambiguous container was stopped, and no volume was removed.
