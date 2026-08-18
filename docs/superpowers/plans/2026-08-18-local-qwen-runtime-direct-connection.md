# Local Qwen Runtime and Direct Desktop Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make this repository self-contained for running Qwen3.5-9B as an independently managed direct llama.cpp service, then connect Private AI Desktop with the correct Qwen profile, bounded output, model/slot diagnostics, and lossless incremental streaming.

**Architecture:** `model-runtime/` owns a loopback-only Docker Compose deployment and explicit PowerShell lifecycle scripts; ignored GGUF files live under `models/`. Electron never invokes Docker or those scripts. The Utility Process consumes only the direct HTTP contract, validates the exact model and slots, preserves direct incremental stream deltas exactly, and deduplicates only repeated explicit SSE identities.

**Tech Stack:** Docker Compose, llama.cpp server/server-cuda images, PowerShell, Electron 43, Node 24 `node:sqlite`, TypeScript 5.9, Vue 3, Vitest 4, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-18-local-qwen-runtime-direct-connection-design.md`

## Global Constraints

- Treat `D:\workspace\AI\aifar` as read-only. Copy the two approved GGUF files; never move, rename, or delete their source copies.
- Do not copy, import, build, or call `context-proxy`, its cache, its Dockerfile, or any control-service/SSH/agent module.
- Bind llama.cpp only to `127.0.0.1:8080`; do not enable llama.cpp built-in tools/agent behavior.
- No Electron, preload, renderer, shared protocol, or Utility Process API may start, stop, restart, or inspect Docker.
- Keep runtime and client concurrency separately configurable. Warn on mismatch; do not synchronize them.
- Default runtime values are `LLAMA_PARALLEL=1`, `LLAMA_CTX_SIZE=16384`, and `LLAMA_N_PREDICT=2048`.
- The direct model alias is exactly `Qwen3.5-9B`; never silently accept `your-model-name`.
- GGUF files and `model-runtime/.env` remain ignored and outside Electron packages, Git commits, and logs.
- Preserve custom profiles, chat history, API-key redaction, FIFO scheduling, cancellation, and reasoning/answer separation.
- Use red-green-refactor for every code task and make small intentional commits.

## File and Interface Map

### Runtime boundary

- `.gitignore`: excludes GGUF and local `.env`.
- `forge.config.ts`: excludes `models/` and `model-runtime/` from Electron packaging.
- `models/README.md`: tracks artifact identity without tracking binaries.
- `model-runtime/.env.example`: documents operator inputs.
- `model-runtime/compose.yaml`: direct CPU/hybrid/GPU llama.cpp profiles.
- `model-runtime/runtime-common.ps1`: artifact, port, Compose, and HTTP helpers.
- `model-runtime/start-model.ps1`: explicit start plus one GPU-to-hybrid fallback.
- `model-runtime/stop-model.ps1`: dedicated-project shutdown.
- `model-runtime/status-model.ps1`: read-only health/model/slot status.
- `model-runtime/verify-model.ps1`: artifact and direct API acceptance.

### Desktop boundary

- `src/agent/localQwenProfile.ts`: preset constants and exact legacy-placeholder predicate.
- `src/agent/modelConnection.ts`: exact `/models` validation and optional `/slots` inspection.
- `src/agent/streamTextNormalizer.ts`: pure per-channel transport normalization.
- `src/shared/domain.ts`, `src/shared/protocol.ts`: output-token and connection-result contracts.
- `src/agent/database.ts`: migrations 6/7, preset seed/repair, output-token persistence.
- `src/agent/modelProvider.ts`: direct bounded Qwen request and normalized streams.
- Settings form/UI files: output bound and connection warning display without lifecycle controls.

---

### Task 1: Protect Model Artifacts From Git and Packaging

**Files:**
- Modify: `.gitignore`
- Modify: `forge.config.ts`
- Modify: `package.json`
- Create: `models/README.md`
- Create: `tests/modelRuntimePackaging.test.ts`

**Interfaces:**
- Consumes: artifact names/hashes from the approved spec.
- Produces: Git exclusions for local artifacts plus a Forge production allowlist, external download cache, and executable outer/inner package scanner.

- [ ] **Step 1: Write the failing packaging test**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import forgeConfig from '../forge.config';

describe('local model packaging boundary', () => {
  it('ignores GGUF files and runtime overrides', () => {
    const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
    expect(ignore).toContain('models/*.gguf');
    expect(ignore).toContain('model-runtime/.env');
  });

  it('uses a production runtime allowlist for Electron archives', () => {
    const patterns = forgeConfig.packagerConfig?.ignore as RegExp[];
    expect(patterns.some((value) => value.test('/src/main.ts'))).toBe(true);
    expect(patterns.some((value) => value.test('/.vite/build/main.js'))).toBe(false);
  });
});
```

Append the test file to the explicit `pnpm test` list.

- [ ] **Step 2: Run it and confirm the expected failure**

Run: `pnpm exec vitest run tests/modelRuntimePackaging.test.ts`

Expected: FAIL because development material is still packageable and the cache is project-local.

- [ ] **Step 3: Implement the exclusions and manifest**

Append:

```gitignore
models/*.gguf
model-runtime/.env
```

Use a production allowlist in `packagerConfig`, leaving only `package.json` and `.vite/**`, and put the Electron download cache under the OS temporary directory rather than the application root:

```ts
ignore: [/^\/(?!\.vite(?:\/|$)|package\.json$)/],
download: { cacheRoot: path.join(os.tmpdir(), 'private-ai-desktop-electron-cache') },
```

Create `models/README.md` containing both exact artifact names, byte sizes, SHA-256 values, source path, and the rule that binaries are local-only. Add `scripts/verify-package-contents.mjs`: enumerate outer files independently, inspect ASAR entries with `@electron/asar`, require production entry points, reject SDD/cache/source/tests/docs/model/runtime/local-env evidence, and enforce a 2 MiB ASAR ceiling.

- [ ] **Step 4: Verify the boundary**

```powershell
pnpm exec vitest run tests/modelRuntimePackaging.test.ts
pnpm typecheck
pnpm package
git check-ignore -v models/Qwen_Qwen3.5-9B-Q4_K_M.gguf
git check-ignore -v model-runtime/.env
```

Expected: all pass; the fresh package scanner reports separate outer-file, ASAR-entry, and ASAR-byte counts, and both local paths match explicit Git ignore rules.

- [ ] **Step 5: Commit**

```powershell
git add .gitignore forge.config.ts package.json models/README.md tests/modelRuntimePackaging.test.ts
git commit -m "chore: protect local model runtime artifacts"
```

### Task 2: Add Direct llama.cpp Compose Profiles

**Files:**
- Create: `model-runtime/.env.example`
- Create: `model-runtime/compose.yaml`
- Create: `model-runtime/README.md`
- Create: `tests/modelRuntimeConfig.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: profiles `cpu`, `hybrid`, and `gpu`, each serving alias `Qwen3.5-9B` directly on loopback.

- [ ] **Step 1: Write the failing static contract**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const compose = readFileSync(new URL('../model-runtime/compose.yaml', import.meta.url), 'utf8');
const env = readFileSync(new URL('../model-runtime/.env.example', import.meta.url), 'utf8');

describe('direct llama.cpp runtime', () => {
  it('has three profiles and no proxy', () => {
    expect(compose).toContain('profiles: ["cpu"]');
    expect(compose).toContain('profiles: ["hybrid"]');
    expect(compose).toContain('profiles: ["gpu"]');
    expect(compose).not.toMatch(/context[-_]proxy|UPSTREAM_URL/i);
  });

  it('binds only loopback and mounts both artifacts read-only', () => {
    expect(compose.match(/127\.0\.0\.1:8080:8080/g)).toHaveLength(3);
    expect(compose.match(/Qwen_Qwen3\.5-9B-Q4_K_M\.gguf:[^\n]+:ro/g)).toHaveLength(3);
    expect(compose.match(/mmproj-Qwen_Qwen3\.5-9B-bf16\.gguf:[^\n]+:ro/g)).toHaveLength(3);
  });

  it('publishes bounded defaults', () => {
    expect(env).toContain('LLAMA_PARALLEL=1');
    expect(env).toContain('LLAMA_CTX_SIZE=16384');
    expect(env).toContain('LLAMA_N_PREDICT=2048');
  });
});
```

- [ ] **Step 2: Run it and confirm `ENOENT`**

Run: `pnpm exec vitest run tests/modelRuntimeConfig.test.ts`

Expected: FAIL because runtime files do not exist.

- [ ] **Step 3: Create the operator defaults**

```dotenv
LLAMA_PARALLEL=1
LLAMA_CTX_SIZE=16384
LLAMA_N_PREDICT=2048
LLAMA_GPU_LAYERS_HYBRID=20
```

- [ ] **Step 4: Implement the three Compose services**

Set Compose name `ai-aifar-model`. All services mount `../models`, bind `127.0.0.1:8080:8080`, and pass:

```text
--alias Qwen3.5-9B
--host 0.0.0.0
--port 8080
--parallel ${LLAMA_PARALLEL}
--ctx-size ${LLAMA_CTX_SIZE}
--n-predict ${LLAMA_N_PREDICT}
--cont-batching --metrics --slots --jinja
```

Profile differences:

| Service | Image | GPU layers | Additional flags |
| --- | --- | ---: | --- |
| `llama-cpu` | `ghcr.io/ggml-org/llama.cpp:server` | `0` | none |
| `llama-hybrid` | `ghcr.io/ggml-org/llama.cpp:server-cuda` | `${LLAMA_GPU_LAYERS_HYBRID}` | `--flash-attn on` |
| `llama-gpu` | `ghcr.io/ggml-org/llama.cpp:server-cuda` | `999` | `--flash-attn on --cache-type-k q8_0 --cache-type-v q8_0` |

Each mounts both models with `:ro` and has a direct `/health` healthcheck. If the image lacks `curl`, prove and use an image-provided alternative; do not add a proxy health container.

- [ ] **Step 5: Document independent commands and concurrency math**

Document `.env` creation, profile commands, direct URLs, 1/16384 default, 2/32768 example, and the fact that Electron exit never stops the model.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm exec vitest run tests/modelRuntimeConfig.test.ts
docker compose -f model-runtime/compose.yaml --profile "*" config --quiet
docker compose -f model-runtime/compose.yaml --profile "*" config | Select-String 'context-proxy|0.0.0.0:8080'
git add model-runtime/.env.example model-runtime/compose.yaml model-runtime/README.md tests/modelRuntimeConfig.test.ts package.json
git commit -m "feat: add standalone direct qwen runtime"
```

Expected: tests/config pass and the search prints nothing.

### Task 3: Add Scoped Runtime Scripts and Copy Artifacts

**Files:**
- Create: `model-runtime/runtime-common.ps1`
- Create: `model-runtime/start-model.ps1`
- Create: `model-runtime/stop-model.ps1`
- Create: `model-runtime/status-model.ps1`
- Create: `model-runtime/verify-model.ps1`
- Create: `tests/modelRuntimeScripts.test.ts`
- Copy ignored: `models/Qwen_Qwen3.5-9B-Q4_K_M.gguf`
- Copy ignored: `models/mmproj-Qwen_Qwen3.5-9B-bf16.gguf`

**Interfaces:**
- Produces: fixed project name `ai-aifar-model`; artifact, Compose, port, health, and verification helpers.

- [ ] **Step 1: Write failing syntax and scoping tests**

```ts
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const scripts = ['runtime-common.ps1', 'start-model.ps1', 'stop-model.ps1', 'status-model.ps1', 'verify-model.ps1'];

describe('runtime scripts', () => {
  it.each(scripts)('%s parses', (name) => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('model-runtime/${name}',[ref]$null,[ref]$e);if($e.Count){exit 1}`]);
    expect(result.status).toBe(0);
  });

  it('scopes mutations and never controls Electron', () => {
    const source = scripts.map((name) => readFileSync(`model-runtime/${name}`, 'utf8')).join('\n');
    expect(source).toContain("$script:ModelComposeProject = 'ai-aifar-model'");
    expect(source).not.toMatch(/electron|pnpm start|D:\\workspace\\AI\\aifar\\compose\.yaml/i);
  });
});
```

Add executable fake-Docker/port behavior tests using one encoded process-local PowerShell script per case. Require ownership inspection before port or mutation; exact-owner `down` then port recheck then selected start; no `--volumes`; unrelated occupied-port and ambiguous-owner paths with zero mutation. Add shared endpoint-contract cases for invalid health, case-only model mismatch, missing/invalid `total_slots`, empty/duplicate slot IDs, props/slot mismatch, and empty completion content. Prove the sanitized snapshot covers `/health`, `/v1/models`, `/props`, and `/slots` without returning raw bodies.

- [ ] **Step 2: Run and confirm missing scripts fail**

Run: `pnpm exec vitest run tests/modelRuntimeScripts.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement shared artifact and Compose helpers**

Start `runtime-common.ps1` with:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:ModelComposeProject = 'ai-aifar-model'

function Get-ExpectedModelArtifacts {
    @(
        [pscustomobject]@{ Name='Qwen_Qwen3.5-9B-Q4_K_M.gguf'; Length=6169341984L; Sha256='D784CE9EDA1A5A7B51E8F705A9E6310844BF4F173654D115823C775FDEA56D43' },
        [pscustomobject]@{ Name='mmproj-Qwen_Qwen3.5-9B-bf16.gguf'; Length=921704896L; Sha256='D89C4BC142D02ED64AEED5C0A358BDEAD9109F21F4ADA03A6B2DF17A1AA94D9E' }
    )
}
```

`Assert-ModelArtifacts` checks existence, exact length, then SHA-256 before Docker calls. `Invoke-ModelCompose` uses an argument array containing `compose`, `-f`, the resolved file, `-p`, and the fixed project; never build a shell command string. `Get-ModelRuntimeOwnership` accepts only one allowed fixed-project profile with one exact loopback publisher; it returns absent without mutation and throws on ambiguity.

- [ ] **Step 4: Implement entry-point behavior**

- `start-model.ps1`: `ValidateSet('gpu','hybrid','cpu')`, Docker/daemon/artifact preflight, then ownership inspection before any port check or mutation. An exactly owned active profile authorizes one fixed-project `down` without volumes followed by a port recheck; absent ownership requires a free port; unrelated/ambiguous ownership fails closed. Start one profile, require the strict shared runtime snapshot within 300 seconds, and permit one ownership-safe GPU fallback on current-attempt evidence.
- `stop-model.ps1`: only this project with `--profile * down`; never `--volumes`.
- `status-model.ps1`: read-only exact ownership plus the shared sanitized `/health`, `/v1/models`, `/props`, and `/slots` snapshot; no raw endpoint bodies.
- `verify-model.ps1`: `-ArtifactsOnly` stops after artifact verification; otherwise require exact ownership, `status=ok`, exact case-sensitive `Qwen3.5-9B`, positive integer `total_slots`, a non-empty unique slot-ID array with matching count, and one UTF-8 completion with non-empty final content (`max_tokens=32`, `temperature=0`, thinking false). Apply the same final-content assertion to optional `-ConcurrentRequests`; never print prompt/response bodies.

- [ ] **Step 5: Run focused script tests**

```powershell
pnpm exec vitest run tests/modelRuntimeScripts.test.ts
powershell -NoProfile -File model-runtime/status-model.ps1
```

Expected: tests pass; offline status is read-only and documented.

- [ ] **Step 6: Verify source and free space, then copy**

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath 'D:\workspace\AI\aifar\Qwen_Qwen3.5-9B-Q4_K_M.gguf','D:\workspace\AI\aifar\mmproj-Qwen_Qwen3.5-9B-bf16.gguf'
Get-PSDrive D | Select-Object Free
Copy-Item -LiteralPath 'D:\workspace\AI\aifar\Qwen_Qwen3.5-9B-Q4_K_M.gguf' -Destination 'D:\workspace\AI\2026-08-14\ai-aifar\models\Qwen_Qwen3.5-9B-Q4_K_M.gguf'
Copy-Item -LiteralPath 'D:\workspace\AI\aifar\mmproj-Qwen_Qwen3.5-9B-bf16.gguf' -Destination 'D:\workspace\AI\2026-08-14\ai-aifar\models\mmproj-Qwen_Qwen3.5-9B-bf16.gguf'
powershell -NoProfile -File model-runtime/verify-model.ps1 -ArtifactsOnly
git check-ignore -v models/*.gguf
```

Require at least 8,000,000,000 free bytes and exact source hashes before copying. Use physical copies only—no move, link, or junction. Expected: destination hashes match and Git ignores both.

- [ ] **Step 7: Commit scripts only**

```powershell
git add model-runtime/*.ps1 tests/modelRuntimeScripts.test.ts package.json
git commit -m "feat: add independent model lifecycle scripts"
```

The ignored GGUF files are never staged.

### Task 4: Add Qwen Preset, Output Bound, and Narrow DB Migration

**Files:**
- Create: `src/agent/localQwenProfile.ts`
- Create: `tests/localQwenProfile.test.ts`
- Modify: `src/shared/domain.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `src/agent/modelCapabilities.ts`
- Modify: `src/agent/database.ts`
- Modify: `tests/protocol.test.ts`
- Modify: `tests/modelCapabilities.test.ts`
- Modify: `tests/database.test.ts`

**Interfaces:**
- Produces: `LOCAL_QWEN_BASE_URL`, `LOCAL_QWEN_MODEL`, `localQwenProfileInput()`, `isLegacyLocalQwenPlaceholder()`, and `normalizeMaxOutputTokens()`.
- Extends: `ModelProfile.maxOutputTokens: number`, optional input equivalent.

- [ ] **Step 1: Write failing preset/protocol tests**

```ts
expect(localQwenProfileInput()).toMatchObject({
  name: 'Local Qwen3.5-9B',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'Qwen3.5-9B',
  maxConcurrency: 1,
  maxOutputTokens: 2048,
  reasoning: { mode: 'disabled', protocol: 'qwen', display: 'auto' },
  capabilities: { reasoning: { inputMode: 'toggle', outputModes: ['raw'] } },
});
```

Test the legacy predicate against exact local placeholder, remote placeholder, and local custom model. Add protocol cases accepting a positive integer and rejecting 0, negative, fractional, and string output limits. Prove lifecycle request types remain invalid.

- [ ] **Step 2: Run and confirm failures**

```powershell
pnpm exec vitest run tests/localQwenProfile.test.ts tests/protocol.test.ts tests/modelCapabilities.test.ts
```

Expected: FAIL for missing module/field.

- [ ] **Step 3: Implement bounded contracts**

Add:

```ts
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
export const MAX_OUTPUT_TOKENS = 32768;

export function normalizeMaxOutputTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.min(value, MAX_OUTPUT_TOKENS);
}
```

Add the profile fields and protocol validation. `localQwenProfileInput()` returns fresh arrays/objects and uses `qwenCapabilities()`.

- [ ] **Step 4: Write failing DB tests**

Cover: fresh preset, idempotent reopen, exact placeholder repaired while ID/default/API key are preserved, remote/custom profiles untouched, and non-default output limit persisted.

```ts
expect(snapshot.modelProfiles).toContainEqual(expect.objectContaining({
  model: 'Qwen3.5-9B',
  maxOutputTokens: 2048,
  reasoning: expect.objectContaining({ protocol: 'qwen' }),
}));
```

- [ ] **Step 5: Implement migrations 6 and 7**

- Migration 6 adds `model_profiles.max_output_tokens INTEGER NOT NULL DEFAULT 2048`.
- Migration 7 repairs only exact placeholder profiles; otherwise seeds one stable preset only when no equivalent exists. Preserve an existing default; default the preset only when none exists.
- Update row type, insert/update SQL, mapping, runtime profile, partial save, and clamping.
- Keep API keys excluded from snapshots.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm exec vitest run tests/localQwenProfile.test.ts tests/protocol.test.ts tests/modelCapabilities.test.ts tests/database.test.ts
pnpm typecheck
git add src/shared/domain.ts src/shared/protocol.ts src/agent/localQwenProfile.ts src/agent/modelCapabilities.ts src/agent/database.ts tests/localQwenProfile.test.ts tests/protocol.test.ts tests/modelCapabilities.test.ts tests/database.test.ts package.json
git commit -m "feat: add direct local qwen profile"
```

### Task 5: Validate Model Identity and Inspect llama.cpp Slots

**Files:**
- Create: `src/agent/modelConnection.ts`
- Create: `tests/modelConnection.test.ts`
- Modify: `src/shared/domain.ts`
- Modify: `src/agent/modelProvider.ts`
- Modify: `src/agent/worker.ts`
- Modify: `src/preload.ts`
- Modify: `src/renderer/types.d.ts`
- Modify: `src/renderer/composables/useApp.ts`
- Modify: provider/worker tests

**Interfaces:**
- Produces: `ModelConnectionStatus`, `ModelConnectionResult`, and `inspectModelConnection(profile, fetchImpl, signal)`.

- [ ] **Step 1: Write failing connection tests**

```ts
import { vi } from 'vitest';
import type { RuntimeModelProfile } from '../src/agent/database';
import { qwenCapabilities } from '../src/agent/modelCapabilities';
import { inspectModelConnection } from '../src/agent/modelConnection';

const subject: RuntimeModelProfile = {
  id: 'local-qwen35',
  name: 'Local Qwen3.5-9B',
  provider: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'Qwen3.5-9B',
  apiKeyConfigured: false,
  capabilities: qwenCapabilities(),
  reasoning: { mode: 'disabled', protocol: 'qwen', display: 'auto' },
  maxConcurrency: 1,
  maxOutputTokens: 2048,
  responseSpeed: 'standard',
  isDefault: true,
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
};
const fetchImpl = vi.fn()
  .mockResolvedValueOnce(Response.json({ data: [{ id: 'Qwen3.5-9B' }] }))
  .mockResolvedValueOnce(Response.json([{ id: 0 }, { id: 1 }]));
const signal = new AbortController().signal;

await expect(inspectModelConnection(subject, fetchImpl, signal))
  .resolves.toMatchObject({
    ok: true,
    status: 'concurrency-warning',
    model: 'Qwen3.5-9B',
    clientConcurrency: 1,
    serviceSlots: 2,
  });
```

Mock `/models` then `/slots`. Test exact-model success, model mismatch, malformed models, slots 404/transport error as `slots-unverified`, matching/mismatching slot counts, and secret redaction.

- [ ] **Step 2: Run and confirm missing implementation**

Run: `pnpm exec vitest run tests/modelConnection.test.ts tests/modelProvider.test.ts`

Expected: FAIL.

- [ ] **Step 3: Add typed result**

```ts
export type ModelConnectionStatus = 'connected' | 'concurrency-warning' | 'slots-unverified';
export interface ModelConnectionResult {
  ok: true;
  status: ModelConnectionStatus;
  message: string;
  model: string;
  clientConcurrency: number;
  serviceSlots?: number;
}
```

- [ ] **Step 4: Implement HTTP-only inspection**

GET `${baseUrl}/models`, parse `data[].id`, and require exact profile model equality. Derive `/slots` from `new URL(profile.baseUrl).origin`, count a JSON array, and downgrade slot failure to unverified. Never import Electron, Docker, shell, or filesystem modules.

- [ ] **Step 5: Route the existing test request through it**

Update the existing `modelProfile.test` result through worker/preload/renderer types. Do not add lifecycle protocol messages or polling.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm exec vitest run tests/modelConnection.test.ts tests/modelProvider.test.ts tests/worker.test.ts tests/protocol.test.ts
pnpm typecheck
git add src/shared/domain.ts src/agent/modelConnection.ts src/agent/modelProvider.ts src/agent/worker.ts src/preload.ts src/renderer/types.d.ts src/renderer/composables/useApp.ts tests/modelConnection.test.ts tests/modelProvider.test.ts tests/worker.test.ts package.json
git commit -m "feat: validate local model and slots"
```

### Task 6: Bound and Normalize Direct Streams

**Files:**
- Create: `src/agent/streamTextNormalizer.ts`
- Create: `tests/streamTextNormalizer.test.ts`
- Modify: `src/agent/modelProvider.ts`
- Modify: `tests/modelProvider.test.ts`

**Interfaces:**
- Produces: `createStreamTextNormalizer(): { push(chunk: string): string | undefined; value(): string }`.

- [ ] **Step 1: Write failing pure tests**

```ts
it('preserves ordinary incremental deltas exactly', () => {
  const stream = createStreamTextNormalizer('incremental');
  expect(['A', 'A', 'AB', ' ', ' '].map((chunk) => stream.push(chunk)))
    .toEqual(['A', 'A', 'AB', ' ', ' ']);
  expect(stream.value()).toBe('AAAB  ');
});
```

Also require per-channel separation, Unicode/SSE fragmentation, post-no-op preservation, and an explicit `cumulative` mode that rejects non-cumulative snapshots. Payload equality, prefix, or suffix is never retransmission identity.

- [ ] **Step 2: Run and confirm the module is missing**

Run: `pnpm exec vitest run tests/streamTextNormalizer.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the pure normalizer**

For `incremental` mode, ignore only empty input and otherwise append/emit every delta exactly. For explicitly declared `cumulative` mode, require each non-empty snapshot to extend the accumulated value and emit only its suffix. Do not infer modes from text.

- [ ] **Step 4: Write failing provider integration tests**

Feed repeated, prefix-shaped, suffix-shaped, and whitespace SSE independently through `content`, `reasoning_content`, and `reasoning_summary`. Require no channel mixing. Prove only a repeated explicit SSE `id` with identical event data is skipped, while an ID/data conflict fails. Capture request body:

```ts
expect(JSON.parse(String(request.init.body))).toMatchObject({
  stream: true,
  temperature: 0.2,
  max_tokens: profile.maxOutputTokens,
});
```

Require Qwen thinking disabled/enabled to send false/true.

- [ ] **Step 5: Integrate three independent normalizers and output bound**

Use three explicitly incremental channel normalizers before handlers so DB/IPC/UI receive every direct delta. Parse SSE event identity separately from payload; never deduplicate an event without an ID. Add `max_tokens: profile.maxOutputTokens`. `[DONE]`, EOF, or `finish_reason=length` without emitted answer content must fail with a fixed message and leave reasoning incomplete. Do not add proxy calls, continuation, or semantic rewriting.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm exec vitest run tests/streamTextNormalizer.test.ts tests/modelProvider.test.ts tests/worker.test.ts tests/database.test.ts tests/agentClientCore.test.ts
pnpm typecheck
git add src/agent/streamTextNormalizer.ts src/agent/modelProvider.ts tests/streamTextNormalizer.test.ts tests/modelProvider.test.ts package.json
git commit -m "fix: bound and normalize model streams"
```

### Task 7: Show Output Bounds and Connection Warnings in Settings

**Files:**
- Modify: `src/renderer/modelProfileForm.ts`
- Modify: `src/renderer/components/SettingsView.vue`
- Modify: `src/renderer/composables/useApp.ts`
- Modify: `src/renderer/App.vue`
- Modify: `src/renderer/i18n/messages.ts`
- Modify: `tests/renderer-state.test.ts`
- Modify: `tests/e2e/app.spec.ts`

**Interfaces:**
- Consumes: `ModelConnectionResult` and `maxOutputTokens`.
- Produces: integer output field and text-only direct-service diagnostics.

- [ ] **Step 1: Write failing renderer tests**

Require form/profile round-trip of 2048. Require a concurrency warning to display service/client values. Require offline guidance to contain `model-runtime\start-model.ps1` and no start/stop button or IPC action.

- [ ] **Step 2: Run and confirm failures**

Run: `pnpm exec vitest run tests/renderer-state.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement form validation and preservation**

Add `maxOutputTokens` to form state, default 2048, load/save/fingerprint it, validate integer 1..32768, and preserve it when changing thinking runtime settings.

- [ ] **Step 4: Render connection states without control coupling**

Render connected, concurrency-warning, slots-unverified, offline, and model-mismatch messages. Show the independent PowerShell command only as text for the built-in preset. Add bilingual labels/messages. Do not add shell execution, link handling, polling, or automatic retry.

- [ ] **Step 5: Verify and commit**

```powershell
pnpm exec vitest run tests/renderer-state.test.ts tests/protocol.test.ts
pnpm test:e2e
git add src/renderer/modelProfileForm.ts src/renderer/components/SettingsView.vue src/renderer/composables/useApp.ts src/renderer/App.vue src/renderer/i18n/messages.ts tests/renderer-state.test.ts tests/e2e/app.spec.ts
git commit -m "feat: show direct model diagnostics"
```

### Task 8: Run Live Runtime and Lifecycle-Independence Acceptance

**Files:**
- Modify: `README.md`
- Create: `docs/superpowers/reports/2026-08-18-local-qwen-runtime-verification.md`
- Modify earlier files only when a failing check proves a correction is required

**Interfaces:**
- Produces: verified active profile, current test evidence, and operator handoff.

- [ ] **Step 1: Run non-live gates first**

```powershell
pnpm test
pnpm typecheck
docker compose -f model-runtime/compose.yaml --profile "*" config --quiet
pnpm package
```

Expected: all exit 0; the fresh scanner proves outer package exclusions and an ASAR containing only bounded production runtime entries, with no SDD/cache/source/tests/docs/GGUF/models/model-runtime/local-env material.

- [ ] **Step 2: Resolve port 8080 ownership safely**

```powershell
Get-NetTCPConnection -LocalPort 8080 -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess
docker ps --filter publish=8080 --format '{{.ID}} {{.Names}} {{.Labels}} {{.Ports}}'
```

Record the listener and Docker labels before mutation. Do not stop an old or unrelated project. `start-model.ps1` may switch only after its own fixed-project inspection proves exactly one allowed `ai-aifar-model` profile and publisher; it then runs fixed-project `down` without volumes and rechecks the port. Any unrelated listener or ambiguous fixed-project state stops the task without mutation.

- [ ] **Step 3: Start and verify the new independent runtime**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File model-runtime/start-model.ps1 -Profile gpu
powershell -NoProfile -ExecutionPolicy Bypass -File model-runtime/status-model.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File model-runtime/verify-model.ps1 -ConcurrentRequests 1
```

Expected: GPU healthy or one documented hybrid fallback; exact alias and one slot; bounded completion succeeds.

- [ ] **Step 4: Run direct live desktop acceptance**

```powershell
$env:PRIVATE_AI_LIVE_MODEL_E2E='1'
$env:PRIVATE_AI_LIVE_MODEL_BASE_URL='http://127.0.0.1:8080/v1'
$env:PRIVATE_AI_LIVE_MODEL_NAME='Qwen3.5-9B'
& .\node_modules\.bin\playwright.CMD test tests/e2e/live-model.spec.ts --workers=1
```

Expected: the 2,048-bound case either completes with a non-empty final answer or fails/incompletes with the fixed output-limit explanation and no `turn.completed`; it must never complete empty. The retained 4,096 case must complete with separate non-empty raw reasoning and final answer, metrics, and no proxy.

- [ ] **Step 5: Prove lifecycle independence**

Launch the packaged desktop, complete one direct chat, close Electron, then run:

```powershell
docker compose -f model-runtime/compose.yaml -p ai-aifar-model ps
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 5
```

Expected: model remains healthy. Stop it through `stop-model.ps1`, reopen client, and require offline guidance without container restart. Start it independently again for handoff.

- [ ] **Step 6: Keep concurrency default safe and optionally probe 2**

Record acceptance at 1/16384. Only if explicitly exercising parallel 2, set 2/32768, restart independently, run `verify-model.ps1 -ConcurrentRequests 2`, record memory/latency/CUDA evidence, and revert to 1/16384 unless fully stable.

- [ ] **Step 7: Document and run final fresh gate**

Update root README with independent commands, no-proxy boundary, concurrency relationship, and client-exit behavior. Write the report with hashes, active profile/fallback, endpoint/slot results, tests, packaging, lifecycle evidence, and unverified limits.

```powershell
pnpm test
pnpm typecheck
pnpm test:e2e
pnpm package
powershell -NoProfile -ExecutionPolicy Bypass -File model-runtime/verify-model.ps1 -ConcurrentRequests 1
git status --short
git ls-files models model-runtime/.env
```

Expected: all gates pass and the final command lists no GGUF or local `.env`.

- [ ] **Step 8: Commit verified documentation**

```powershell
git add README.md docs/superpowers/reports/2026-08-18-local-qwen-runtime-verification.md
git commit -m "docs: verify standalone local qwen runtime"
```

## Final Review Checklist

- [ ] Map every design acceptance criterion to Tasks 1-8.
- [ ] `rg -n "context-proxy|UPSTREAM_URL" model-runtime src tests README.md` contains only negative tests/docs.
- [ ] `rg -n "modelRuntime\.(start|stop)|docker compose" src` returns no desktop lifecycle coupling.
- [ ] Source artifact sizes/hashes remain unchanged.
- [ ] New model was started independently and survives Electron exit.
- [ ] No secret, prompt/response body, GGUF, or local `.env` appears in commits/reports.
- [ ] List branch commits and do not push without a separate user request.
