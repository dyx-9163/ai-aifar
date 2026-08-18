# Local Qwen Runtime and Direct Desktop Connection Design

**Date:** 2026-08-18  
**Status:** Approved in conversation  
**Target repository:** `D:\workspace\AI\2026-08-14\ai-aifar`  
**Source inventory:** `D:\workspace\AI\aifar`

## Goal

Move the self-contained Qwen3.5-9B model runtime into the current desktop repository and adapt Private AI Desktop to connect directly to llama.cpp. The model runtime remains operationally independent: starting or stopping the desktop client must never start, stop, restart, or otherwise manage the model service.

## Approved Decisions

- Use Docker Compose rather than shipping a native `llama-server` executable.
- Physically copy both GGUF artifacts into the current repository's ignored `models/` directory.
- Do not migrate or call `context-proxy`.
- Expose llama.cpp directly on `127.0.0.1:8080` with OpenAI-compatible APIs under `/v1`.
- Keep CPU, hybrid, and GPU profiles. The independent start script defaults to GPU and may fall back to hybrid after a failed GPU health check.
- Keep model concurrency independently configurable from desktop request concurrency.
- The desktop detects and connects to the service but never owns its lifecycle.

## Scope

### In scope

- A standalone `model-runtime/` directory with Compose, configuration, lifecycle scripts, health checks, and documentation.
- An ignored `models/` directory containing the verified text model and multimodal projector.
- A built-in local Qwen provider preset and a narrowly scoped repair for the known legacy placeholder profile.
- Direct llama.cpp model discovery, slot inspection, streaming chat completion, reasoning-stream mapping, output bounds, and SSE-identity duplicate protection.
- Unit, contract, Compose, script, and opt-in live-model verification.

### Out of scope

- `context-proxy`, semantic context compaction, automatic answer continuation, completion critic calls, or proxy caching.
- The control service, SSH worker, operations agent, skills, databases, or other modules under the source tree.
- Starting or stopping Docker from Electron, preload, renderer, or Utility Process code.
- Bundling the GGUF files inside Git history or distributable Electron archives.
- Exposing llama.cpp to the LAN, adding remote authentication, or enabling llama.cpp built-in tools/agent functions.

## Source Artifacts

The implementation copies exactly these source files and verifies them before and after copying:

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `Qwen_Qwen3.5-9B-Q4_K_M.gguf` | 6,169,341,984 bytes | `D784CE9EDA1A5A7B51E8F705A9E6310844BF4F173654D115823C775FDEA56D43` |
| `mmproj-Qwen_Qwen3.5-9B-bf16.gguf` | 921,704,896 bytes | `D89C4BC142D02ED64AEED5C0A358BDEAD9109F21F4ADA03A6B2DF17A1AA94D9E` |

The source directory is read-only for this migration. No source files are moved, renamed, or deleted.

## Target Layout

```text
ai-aifar/
├─ model-runtime/
│  ├─ compose.yaml
│  ├─ .env.example
│  ├─ README.md
│  ├─ start-model.ps1
│  ├─ stop-model.ps1
│  ├─ status-model.ps1
│  └─ verify-model.ps1
├─ models/
│  ├─ Qwen_Qwen3.5-9B-Q4_K_M.gguf
│  └─ mmproj-Qwen_Qwen3.5-9B-bf16.gguf
└─ ...existing desktop sources
```

The repository `.gitignore` excludes `models/*.gguf` and local runtime overrides such as `model-runtime/.env`, while retaining `.env.example` and documentation.

## Independent Runtime Architecture

`model-runtime/compose.yaml` contains exactly three mutually exclusive llama.cpp services selected with Compose profiles:

- `cpu`: server image, no GPU layers.
- `hybrid`: CUDA server image, a bounded number of GPU layers, and host CPU fallback.
- `gpu`: CUDA server image, full supported layer offload, Flash Attention, and quantized K/V cache.

Each service:

- mounts both artifacts from `../models` read-only;
- aliases the model as `Qwen3.5-9B`;
- binds only `127.0.0.1:8080:8080`;
- enables Jinja chat templates, continuous batching, health, slots, and metrics endpoints;
- does not enable built-in tools, built-in agent behavior, a proxy, or a public listener;
- has a direct HTTP health check against llama.cpp;
- uses a Compose project name scoped to this repository so scripts cannot affect unrelated containers.

Only the selected profile binds port 8080. Switching profiles requires stopping this Compose project first to prevent port conflicts and simultaneous model copies.

## Runtime Configuration and Concurrency

`model-runtime/.env` is copied from `.env.example` and is the runtime source of truth. At minimum it exposes:

```dotenv
LLAMA_PARALLEL=1
LLAMA_CTX_SIZE=16384
LLAMA_N_PREDICT=2048
LLAMA_GPU_LAYERS_HYBRID=20
```

`LLAMA_PARALLEL` controls llama.cpp server slots. `LLAMA_CTX_SIZE` is the total configured context capacity shared by those slots. Operators who raise parallelism must raise the total context capacity when they expect to preserve the same per-request budget. For example, two 16,384-token slots require a 32,768 total context target and substantially more KV-cache memory.

The verified RTX 5060 Laptop 8 GiB default remains one slot and 16,384 total context. Parallelism greater than one is supported as an explicit operator choice but is not claimed safe until the selected profile passes the live concurrency probe without CUDA OOM, restart loops, or unacceptable latency.

`LLAMA_N_PREDICT` provides a server-side upper bound even when a client omits `max_tokens`. The desktop also sends its own positive `max_tokens`; the effective generation cannot exceed the stricter active bound.

Desktop profile concurrency remains a separate client-side queue limit. The two values are not automatically synchronized. Connection diagnostics compare them and warn when they differ.

## Runtime Scripts

The scripts execute only when explicitly invoked by an operator.

### `start-model.ps1`

- Accepts `-Profile gpu|hybrid|cpu`, defaulting to `gpu`.
- Validates Docker CLI and daemon availability.
- Validates both model files, expected sizes, and SHA-256 hashes before starting.
- Rejects an unrelated listener already occupying `127.0.0.1:8080`.
- Inspects the fixed Compose project before checking the port or mutating runtime state. It stops the project without volumes only when exactly one allowed `ai-aifar-model` profile and its loopback publisher prove ownership; absent ownership falls through to the port check, while ambiguous ownership fails closed.
- Starts the selected profile and waits for a strict direct llama.cpp snapshot: `status=ok`, exact `Qwen3.5-9B`, valid `/props`, and a non-empty unique `/slots` array whose count matches `total_slots`.
- For the default GPU attempt, detects unhealthy exit, restart loop, and CUDA OOM evidence; it then stops only this Compose project and attempts hybrid once.
- Prints the final active profile and API base URL. It never starts the desktop client.

### `stop-model.ps1`

- Stops only the Compose project declared in `model-runtime/compose.yaml`.
- Does not enumerate or stop unrelated Docker containers or host processes.
- Does not touch model files or desktop data.

### `status-model.ps1`

- Shows only sanitized Compose project/profile/loopback-port state, exact health/model identity, `/props`, and the effective validated `/slots` count.
- Reports endpoint/model mismatches and port ownership without mutating anything.

### `verify-model.ps1`

- Rechecks artifact size and SHA-256.
- Verifies `/health`, `/v1/models`, `/props`, and `/slots` directly.
- Sends one bounded non-thinking Chinese completion and requires a non-empty final answer.
- Supports an explicit concurrency probe whose request count is independent of desktop settings.

## Desktop Provider Preset and Legacy Repair

The desktop declares a built-in `Local Qwen3.5-9B` preset:

```text
provider: openai-compatible
base URL: http://127.0.0.1:8080/v1
model: Qwen3.5-9B
API key: none
reasoning input: toggle
reasoning protocol: qwen
reasoning output: raw
client concurrency: 1
max output tokens: 2048
```

The preset is created idempotently when no equivalent profile exists. Existing custom profiles are preserved.

A one-time migration repairs only a profile matching all known legacy-placeholder characteristics: local base URL `http://127.0.0.1:8080/v1`, model name exactly `your-model-name`, provider `openai-compatible`, and no incompatible custom endpoint identity. It replaces the placeholder model name and capability declaration with the approved Qwen preset. It does not rewrite arbitrary user models or remote endpoints.

## Connection and Status Flow

The client performs detection, not lifecycle control:

1. The Utility Process loads the active model profile.
2. A connection test requests `/v1/models` and requires the configured model identifier to be present.
3. When available, it requests llama.cpp `/slots` at the origin URL and counts configured slots.
4. It compares service slots with the desktop profile's client concurrency.
5. It reports one of: connected, offline, model mismatch, or connected with concurrency warning.
6. If offline, the UI displays the independent `model-runtime/start-model.ps1` command. It does not execute it.
7. Chat requests continue to use the existing Utility Process provider boundary and typed events.

The desktop may perform one non-mutating connection probe after its agent runtime becomes ready and may probe again when the operator selects connection test or submits a turn. It does not poll continuously and does not treat model health as authority to modify external state.

## Direct Qwen Request Adaptation

For the built-in Qwen preset:

- thinking enabled sends `chat_template_kwargs.enable_thinking = true`;
- thinking disabled sends `chat_template_kwargs.enable_thinking = false`;
- `reasoning_content` maps only to the raw reasoning stream;
- `content` maps only to the final-answer stream;
- each request sends a validated positive `max_tokens` from the profile;
- model identity is the configured alias returned by `/v1/models` rather than a placeholder or silent default;
- one llama.cpp slot defaults to one running desktop turn, while later turns remain in the existing client FIFO queue.

No request is routed through a proxy, and no second model call is generated to summarize reasoning, compact history, criticize completion, or continue an answer.

## Stream Transport Contract

The direct llama.cpp adapter declares ordinary incremental transport. Every non-empty `content`, `reasoning_content`, and native-summary delta is preserved exactly and accumulated independently, including repeated text, prefix-shaped text, suffix-shaped text, and spaces. Payload text alone is never retransmission identity.

Transport deduplication is allowed only when SSE supplies a real non-empty `id`: a repeated event with the same ID and identical data is skipped, while conflicting data for the same ID fails the stream. Events without IDs are never deduplicated by payload. Cumulative full-so-far normalization exists only behind the explicit `cumulative` normalizer mode for a separately declared transport; it is never inferred for direct Qwen.

UTF-8 decoding and SSE framing remain incremental across arbitrary byte and line fragmentation. `[DONE]`, EOF, or a `length` finish with no emitted final-answer content fails the turn with a fixed bounded explanation; raw reasoning is retained only as incomplete evidence and is never relabelled as an answer.

## Context Boundary Without a Proxy

The existing desktop message-count limit remains in effect. Because the proxy and token-aware compaction are explicitly excluded, the desktop does not claim that every retained message set fits the model's token context.

If llama.cpp rejects an oversized context, the turn fails visibly with a bounded explanation recommending a new chat or a lower history limit. No history is silently dropped beyond the configured message-count behavior, and no background summarization call is introduced.

## Error Handling

- Docker unavailable: scripts fail before Compose mutation and identify the missing prerequisite.
- Missing or corrupt model: scripts fail closed before startup and print the mismatched artifact only.
- Port 8080 owned by another process/container: startup stops without killing the owner.
- GPU startup failure: the explicit independent script performs one hybrid fallback and reports both attempts.
- Endpoint offline in desktop: connection state is offline; no container action follows.
- `/v1/models` does not list `Qwen3.5-9B`: connection fails as model mismatch rather than accepting any reachable endpoint.
- `/slots` unavailable: chat connectivity can still succeed, but concurrency is marked unverified.
- Client concurrency differs from slot count: connection succeeds with a warning.
- Streaming transport fails: the existing turn failure path remains authoritative and no automatic retry duplicates a generation.
- A stream ends without final-answer content: the turn fails and remains incomplete; it is never recorded as a completed empty-answer turn.

Errors and diagnostics must not print API keys, prompt bodies, response bodies, or GGUF contents.

## Verification Strategy

### Static and automated verification

- `docker compose --profile "*" config --quiet` passes.
- Each profile contains exactly one llama.cpp service and no proxy service.
- Each service mounts both expected files read-only and binds only loopback port 8080.
- `.gitignore` excludes GGUF artifacts and local runtime `.env`.
- PowerShell script tests cover Docker failure, corrupt files, occupied port, project scoping, GPU success, GPU-to-hybrid fallback, and no unrelated-container mutation.
- Database tests cover preset idempotency, narrow placeholder migration, preservation of custom profiles, and `maxOutputTokens` persistence.
- Provider tests cover exact model discovery, Qwen thinking flags, output bounds, separate reasoning/answer streams, lossless repeated/prefix/suffix incremental chunks, explicitly declared cumulative mode, and SSE-ID retransmission handling.
- Client tests cover connected/offline/mismatch/concurrency-warning states and verify that no lifecycle request exists in the renderer/preload protocol.

### Live verification

For CPU, hybrid, and GPU profiles where the environment supports them:

1. Start the model through the independent script.
2. Verify direct `/health`, `/v1/models`, `/props`, and `/slots`.
3. Run a bounded text completion with thinking off and on.
4. Require raw reasoning and final answer to remain separate when thinking is enabled.
5. Run the desktop's opt-in live Qwen test against the direct endpoint.
6. Run the configured parallel request count and record completion, queueing, latency, memory, and CUDA behavior.
7. Close the desktop and prove the model container remains running.
8. Stop the model independently and prove the desktop reports offline without attempting restart.

GPU concurrency greater than one is accepted only with live evidence. Otherwise the shipped default remains one.

## Delivery and Rollback

Implementation proceeds in this order:

1. Add ignored target directories and copy/verify the artifacts.
2. Add the independent Compose runtime and scripts.
3. Verify direct model operation before changing desktop behavior.
4. Add the preset, narrow migration, diagnostics, request bounds, and lossless direct stream handling.
5. Run focused, regression, packaging, and opt-in live tests.

Rollback is component-specific:

- Desktop adaptation can be reverted without stopping the independent model service.
- Runtime files can be removed after explicitly stopping only their Compose project.
- GGUF files can be deleted only after their exact ignored target paths and hashes are revalidated; source artifacts remain untouched.

## Acceptance Criteria

- The current repository can run Qwen3.5-9B without any file or process dependency on `D:\workspace\AI\aifar`.
- No `context-proxy` code, image, container, cache, or request path is present.
- The model starts and stops only through independent operator commands.
- Starting, closing, crashing, or restarting Private AI Desktop does not start, stop, or restart the model container.
- The desktop connects directly to the correct `Qwen3.5-9B` alias and never silently accepts `your-model-name`.
- Runtime and desktop concurrency are separately configurable, observable, and mismatch-safe.
- Direct Qwen thinking, raw reasoning, final answers, output bounds, and lossless incremental stream handling pass automated and live checks.
- GGUF files are present locally and hash-verified. Packaged Electron artifacts contain only `package.json` and production `.vite/**` entries in the bounded ASAR; model/runtime, SDD/cache, source, test, docs, and local environment material are absent from both inner and outer inventories.
