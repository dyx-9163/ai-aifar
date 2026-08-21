# Provider and Model Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a provider-first model catalog that supports OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages, with model discovery, manual model entry, bulk selection, safe legacy migration, and per-model context/output-token overrides.

**Architecture:** Persist provider connections separately from selectable model profiles while preserving every existing model-profile ID. Resolve a worker-only flattened runtime profile by joining a provider with its child model, then dispatch requests through a protocol adapter registry. Keep discovery, connection tests, credentials, and scheduling in the worker; expose only redacted state and normalized results to Vue.

**Tech Stack:** TypeScript 5.9, Node.js SQLite, Electron 43 Utility Process and IPC, Vue 3, Vitest 4, Playwright 1.62.

**Spec:** `docs/superpowers/specs/2026-08-20-provider-model-catalog-design.md`

## Global Constraints

- Preserve existing model-profile IDs, thread references, default selection, chat history, local-runtime lifecycle, and turn-event semantics.
- Provider protocols are exactly `openai-chat-completions`, `openai-responses`, and `anthropic-messages`.
- Per-model editable compatibility settings are limited to context-window and maximum-output-token overrides; display name, enabled state, and default selection remain ordinary model metadata.
- Never infer request behavior or capabilities from `deepseek`, `qwen`, `gpt`, `pangu`, or another model-name substring.
- `model-default` sends no vendor-specific thinking switch; provider-specific behavior uses validated custom request JSON.
- A catalog refresh never deletes configured models, and a failed refresh changes no persisted catalog state.
- API keys and secret custom headers never enter renderer snapshots, logs, catalog results, or visible raw errors.
- Runtime connection and activity statuses are not restored as live statuses after restart.
- Catalog discovery is bounded to 15 seconds, 5 MiB, and 10,000 normalized model IDs.
- Use test-first RED/GREEN cycles for every behavior change.
- Preserve all pre-existing dirty working-tree changes. Commit steps are used only inside an isolated execution worktree; skip them in the current dirty workspace.

## File Structure

### New Files

- `src/agent/providerAdapters/types.ts`: shared adapter request, stream, metrics, and runtime-provider contracts.
- `src/agent/providerAdapters/registry.ts`: protocol-to-adapter lookup with no model-name inference.
- `src/agent/providerAdapters/openAiChatCompletions.ts`: OpenAI Chat Completions request and stream adapter.
- `src/agent/providerAdapters/openAiResponses.ts`: OpenAI Responses request and stream adapter.
- `src/agent/providerAdapters/anthropicMessages.ts`: Anthropic Messages request and stream adapter.
- `src/agent/providerCatalog.ts`: bounded `/models` discovery, normalization, auth, and safe errors.
- `src/agent/providerConnection.ts`: minimal inference connection tests independent from catalog discovery.
- `src/renderer/providerForm.ts`: provider draft creation, loading, validation, fingerprinting, and key-preservation helpers.
- `src/renderer/modelCatalogSelection.ts`: search, full/filtered bulk selection, manual parsing, and duplicate prevention.
- `tests/providerCatalog.test.ts`: catalog bounds, parsing, auth, cancellation, and redaction tests.
- `tests/providerAdapters.test.ts`: protocol adapter request and normalized-stream contract tests.
- `tests/providerFixtures.ts`: shared provider input and joined runtime-profile fixtures for focused tests.

### Existing Files With Changed Responsibilities

- `src/shared/domain.ts`: provider, child-model, catalog, connection-result, and snapshot types.
- `src/shared/protocol.ts`: validated provider/model IPC request guards.
- `src/agent/database.ts`: provider persistence, migration, child-model operations, redacted snapshot, and joined runtime resolution.
- `src/agent/modelProvider.ts`: protocol-neutral retry, context compression, continuation, metrics, and adapter dispatch.
- `src/agent/modelConnection.ts`: compatibility wrapper or removal after provider discovery/testing replaces its combined behavior.
- `src/agent/turnScheduler.ts`: capacity grouping by provider while events retain model-profile IDs.
- `src/agent/worker.ts`: provider/model IPC handlers and provider-based scheduler limits.
- `src/preload.ts` and `src/renderer/types.d.ts`: typed renderer bridge methods.
- `src/renderer/composables/useApp.ts`: provider/model state operations and snapshot refresh.
- `src/renderer/components/SettingsView.vue`: provider editor, model list, catalog modal, and per-model override editor.
- `src/renderer/components/Conversation.vue`: provider-grouped model selector and removal of forced reasoning controls.
- `src/renderer/App.vue`: provider/model props and commands.
- `src/renderer/i18n/messages.ts`: Chinese and English provider/catalog/error copy.
- `src/renderer/styles/app.css`: provider list, catalog dialog, model rows, status badges, and responsive layout.
- `package.json`: include new focused test files in the full unit-test command.

---

### Task 1: Provider and Child-Model Contracts

**Files:**
- Modify: `src/shared/domain.ts`
- Modify: `src/shared/protocol.ts`
- Test: `tests/protocol.test.ts`

**Interfaces:**
- Produces: `ProviderProtocol`, `ProviderThinkingMode`, `ModelCatalogState`, `ModelProvider`, `ModelProviderInput`, `ProviderModelInput`, `ModelCatalogResult`, and `ProviderConnectionResult`.
- Changes: `AppSnapshot` gains `modelProviders`; `ModelProfile` gains `providerId`, `enabled`, `catalogState`, and optional `contextWindowTokens` while retaining its stable `id`, `name`, and `model` fields.
- Produces validated requests: `modelProvider.save`, `modelProvider.delete`, `modelProvider.discoverModels`, `modelProvider.test`, `providerModel.addMany`, `providerModel.update`, and `providerModel.delete`.

- [ ] **Step 1: Write failing request-guard tests**

```ts
it('accepts the three provider protocols and rejects vendor labels', () => {
  for (const protocol of ['openai-chat-completions', 'openai-responses', 'anthropic-messages'] as const) {
    expect(isDesktopRequest({
      type: 'modelProvider.save',
      provider: {
        name: 'Primary provider',
        baseUrl: 'https://example.test/v1',
        protocol,
        maxConcurrency: 2,
        requestTimeoutMs: 300_000,
        allowImages: false,
        toolCallingMode: 'native',
        thinkingMode: 'model-default',
      },
    })).toBe(true);
  }
  expect(isDesktopRequest({
    type: 'modelProvider.save',
    provider: {
      name: 'Invalid', baseUrl: 'https://example.test/v1', protocol: 'qwen',
      maxConcurrency: 1, requestTimeoutMs: 10_000, allowImages: false,
      toolCallingMode: 'native', thinkingMode: 'model-default',
    },
  })).toBe(false);
});

it('bounds batch model additions and token overrides', () => {
  expect(isDesktopRequest({
    type: 'providerModel.addMany',
    providerId: 'provider-1',
    models: [{ modelId: 'deepseek-v4-pro', maxOutputTokens: 8192 }],
  })).toBe(true);
  expect(isDesktopRequest({
    type: 'providerModel.addMany',
    providerId: 'provider-1',
    models: [{ modelId: 'bad', contextWindowTokens: 0 }],
  })).toBe(false);
});
```

- [ ] **Step 2: Run the focused protocol test and confirm RED**

Run: `pnpm exec vitest run tests/protocol.test.ts`

Expected: FAIL because the provider requests and domain types do not exist.

- [ ] **Step 3: Add the domain contracts and bounded guards**

```ts
export type ProviderProtocol =
  | 'openai-chat-completions'
  | 'openai-responses'
  | 'anthropic-messages';
export type ProviderThinkingMode = 'model-default' | 'custom';
export type ModelCatalogState = 'available' | 'missing' | 'manual';

export interface ModelProviderInput {
  id?: string;
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  apiKey?: string;
  maxConcurrency: number;
  requestTimeoutMs: number;
  allowImages: boolean;
  toolCallingMode: 'native' | 'text-fallback';
  thinkingMode: ProviderThinkingMode;
  customRequestBody?: Record<string, unknown>;
  customHeaders?: Record<string, string>;
  catalogPath?: string;
}

export interface ProviderModelInput {
  id?: string;
  modelId: string;
  displayName?: string;
  enabled?: boolean;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  isDefault?: boolean;
}
```

Validate URL/string lengths, JSON depth and byte size, header names, positive integer ranges, exact protocol enums, a maximum batch size of 10,000, and duplicate model IDs before accepting IPC input. Keep legacy `modelProfile.*` guards until Task 10 removes renderer callers.

- [ ] **Step 4: Run protocol tests and type checking**

Run: `pnpm exec vitest run tests/protocol.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS after compatibility fields are retained for later tasks.

- [ ] **Step 5: Commit the isolated task**

```bash
git add src/shared/domain.ts src/shared/protocol.ts tests/protocol.test.ts
git commit -m "feat: add provider and model catalog contracts"
```

### Task 2: Transactional Provider Persistence and Legacy Migration

**Files:**
- Modify: `src/agent/database.ts`
- Create: `tests/providerFixtures.ts`
- Test: `tests/database.test.ts`

**Interfaces:**
- Produces: `RuntimeModelProvider = ModelProvider & { apiKey?: string; customHeaders?: Record<string, string> }`; public `ModelProvider` exposes only `apiKeyConfigured` and `customHeaderNames`.
- Produces: `RuntimeModelProfile = ModelProfile & { providerName: string; baseUrl: string; protocol: ProviderProtocol; apiKey?: string; maxConcurrency: number; requestTimeoutMs: number; allowImages: boolean; toolCallingMode: 'native' | 'text-fallback'; thinkingMode: ProviderThinkingMode; customRequestBody?: Record<string, unknown>; customHeaders?: Record<string, string> }`.
- Produces database methods: `saveModelProvider`, `deleteModelProvider`, `getModelProviderForRuntime`, `addProviderModels`, `updateProviderModel`, `deleteProviderModel`, and `refreshProviderCatalogState`.
- Preserves: `getModelProfileForRuntime(id)` as the worker-only joined runtime resolver used by the existing agent loop.

- [ ] **Step 1: Add failing migration and CRUD tests**

```ts
it('migrates matching legacy profiles into one provider without changing model ids', () => {
  const path = createDbPath();
  createV5ModelProfileDatabase(path);
  const db = openDatabase(path);
  const snapshot = db.getSnapshot();

  expect(snapshot.modelProviders).toHaveLength(1);
  expect(snapshot.modelProfiles.map((profile) => profile.id)).toEqual(
    expect.arrayContaining(['legacy-local', 'local-custom']),
  );
  expect(snapshot.modelProfiles.every((profile) => profile.providerId === snapshot.modelProviders[0].id)).toBe(true);
  expect(db.getModelProfileForRuntime('legacy-local')).toMatchObject({
    model: expect.any(String),
    baseUrl: expect.any(String),
    protocol: 'openai-chat-completions',
  });
});

it('retains missing models and rolls back a failed refresh', () => {
  const db = openDatabase(createDbPath());
  const provider = db.saveModelProvider(providerInput());
  const [first, second] = db.addProviderModels(provider.id, [
    { modelId: 'a' }, { modelId: 'b' },
  ]);
  db.refreshProviderCatalogState(provider.id, ['a']);
  expect(db.getSnapshot().modelProfiles).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: first.id, catalogState: 'available' }),
    expect.objectContaining({ id: second.id, catalogState: 'missing' }),
  ]));
});
```

- [ ] **Step 2: Run database tests and confirm RED**

Run: `pnpm exec vitest run tests/database.test.ts`

Expected: FAIL because `model_providers` and the new database methods are absent.

- [ ] **Step 3: Add migration 12 and provider CRUD**

```sql
CREATE TABLE model_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  protocol TEXT NOT NULL,
  api_key TEXT,
  max_concurrency INTEGER NOT NULL,
  request_timeout_ms INTEGER NOT NULL,
  allow_images INTEGER NOT NULL,
  tool_calling_mode TEXT NOT NULL,
  thinking_mode TEXT NOT NULL,
  custom_request_body TEXT,
  custom_headers TEXT,
  catalog_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Add nullable `provider_id`, `enabled`, `catalog_state`, and `context_window_tokens` columns to `model_profiles`. Within migration 12, group only rows with identical normalized connection, key, concurrency, capability, and reasoning fingerprints; create separate providers for every mismatch; then populate every `provider_id`. Preserve legacy columns for compatibility reads.

Implement exact database signatures:

```ts
saveModelProvider(input: ModelProviderInput): ModelProvider;
deleteModelProvider(id: string): void;
getModelProviderForRuntime(id: string): RuntimeModelProvider | undefined;
addProviderModels(providerId: string, models: ProviderModelInput[]): ModelProfile[];
updateProviderModel(providerId: string, model: ProviderModelInput & { id: string }): ModelProfile;
deleteProviderModel(id: string): void;
refreshProviderCatalogState(providerId: string, advertisedIds: readonly string[]): void;
```

Make batch addition and catalog-state refresh single transactions. Reject duplicate `(provider_id, model)` pairs. Block provider deletion while a child is default, referenced by a thread, or belongs to a queued/running/cancelling turn. Redact provider keys and custom header values in `getSnapshot()`.

On provider edits, an omitted/blank API key preserves the saved key. For `customHeaders`, a known header with a blank submitted value preserves that header's saved value, a non-blank value replaces it, a new blank header is rejected, and removing a header name from the submitted map deletes it.

Add shared test fixtures with stable defaults:

```ts
export function providerInput(overrides: Partial<ModelProviderInput> = {}): ModelProviderInput {
  return {
    name: 'Fixture provider',
    baseUrl: 'https://example.test/v1',
    protocol: 'openai-chat-completions',
    apiKey: 'secret',
    maxConcurrency: 1,
    requestTimeoutMs: 300_000,
    allowImages: false,
    toolCallingMode: 'native',
    thinkingMode: 'model-default',
    ...overrides,
  };
}

export function runtimeProvider(overrides: Partial<RuntimeModelProvider> = {}): RuntimeModelProvider {
  const now = '2026-08-20T00:00:00.000Z';
  return {
    id: 'provider-1', ...providerInput(), apiKeyConfigured: true,
    customHeaderNames: [],
    createdAt: now, updatedAt: now, ...overrides,
  };
}

export function runtimeModel(overrides: Partial<RuntimeModelProfile> = {}): RuntimeModelProfile {
  const now = '2026-08-20T00:00:00.000Z';
  const provider = runtimeProvider();
  return {
    ...provider,
    id: 'model-1', providerId: provider.id, providerName: provider.name,
    name: 'Fixture model', model: 'fixture',
    enabled: true, catalogState: 'available', isDefault: true,
    maxOutputTokens: 8192, createdAt: now, updatedAt: now,
    ...overrides,
  };
}
```

- [ ] **Step 4: Run database tests until GREEN**

Run: `pnpm exec vitest run tests/database.test.ts`

Expected: PASS, including all pre-existing migration tests.

- [ ] **Step 5: Commit the isolated task**

```bash
git add src/agent/database.ts tests/providerFixtures.ts tests/database.test.ts
git commit -m "feat: persist providers and migrate model profiles"
```

### Task 3: Bounded Model Catalog Discovery

**Files:**
- Create: `src/agent/providerCatalog.ts`
- Create: `tests/providerCatalog.test.ts`
- Modify: `package.json`
- Modify: `src/shared/redaction.ts`

**Interfaces:**
- Consumes: `RuntimeModelProvider`, `FetchLike`, and `AbortSignal`.
- Produces: `discoverProviderModels(provider, fetchImpl, signal): Promise<ModelCatalogResult>`.
- Produces: `providerEndpoint(baseUrl, path): string` that preserves meaningful path segments.

- [ ] **Step 1: Write failing discovery tests**

```ts
it('preserves compatible-mode/v1 and normalizes exact model ids', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(Response.json({
    data: [{ id: 'deepseek-v4-pro' }, { id: 'Qwen-Max' }, { id: 'deepseek-v4-pro' }],
  }));
  const result = await discoverProviderModels(
    runtimeProvider({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/' }),
    fetchImpl,
    new AbortController().signal,
  );
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret' }) }),
  );
  expect(result).toEqual({ status: 'available', models: ['deepseek-v4-pro', 'Qwen-Max'] });
});

it('treats a missing catalog as manual-entry warning', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
  await expect(discoverProviderModels(runtimeProvider(), fetchImpl, new AbortController().signal))
    .resolves.toMatchObject({ status: 'unsupported', models: [] });
});
```

Also cover case-sensitive IDs, malformed payloads, 5 MiB enforcement, 10,000-entry enforcement, timeout, cancellation, Anthropic auth headers, custom catalog path, and secret redaction.

- [ ] **Step 2: Run the new test and confirm RED**

Run: `pnpm exec vitest run tests/providerCatalog.test.ts`

Expected: FAIL because the discovery module does not exist.

- [ ] **Step 3: Implement bounded discovery**

```ts
export const MODEL_CATALOG_TIMEOUT_MS = 15_000;
export const MAX_MODEL_CATALOG_BYTES = 5 * 1024 * 1024;
export const MAX_MODEL_CATALOG_ENTRIES = 10_000;

export async function discoverProviderModels(
  provider: RuntimeModelProvider,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<ModelCatalogResult> {
  const endpoint = providerEndpoint(provider.baseUrl, provider.catalogPath ?? 'models');
  const response = await fetchWithBoundedBody(endpoint, providerCatalogRequest(provider, signal), fetchImpl);
  if (response.status === 404 || response.status === 405) {
    return { status: 'unsupported', models: [], warning: 'Model discovery is not supported by this endpoint.' };
  }
  const ids = normalizeCatalogPayload(response.payload, MAX_MODEL_CATALOG_ENTRIES);
  return { status: 'available', models: ids };
}
```

Use `Authorization: Bearer` for both OpenAI protocols and `x-api-key` plus `anthropic-version` for Anthropic. Read the response as bounded bytes before JSON parsing. Pass cancellation through without downgrading it to an offline result.

- [ ] **Step 4: Include and run catalog tests**

Add `tests/providerCatalog.test.ts` to the explicit `pnpm test` script.

Run: `pnpm exec vitest run tests/providerCatalog.test.ts tests/redaction.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the isolated task**

```bash
git add src/agent/providerCatalog.ts src/shared/redaction.ts tests/providerCatalog.test.ts package.json
git commit -m "feat: discover provider model catalogs safely"
```

### Task 4: Adapter Registry and OpenAI Chat Completions Migration

**Files:**
- Create: `src/agent/providerAdapters/types.ts`
- Create: `src/agent/providerAdapters/registry.ts`
- Create: `src/agent/providerAdapters/openAiChatCompletions.ts`
- Modify: `src/agent/modelProvider.ts`
- Create: `tests/providerAdapters.test.ts`
- Modify: `tests/modelProvider.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `ProviderAdapter`, `ProviderStreamInput`, `ProviderStreamResult`, and `providerAdapterFor(protocol)`.
- Produces: `streamModelResponse(profile, messages, handlers, signal, fetchImpl, nowMs, timeoutMs, tools)` as the protocol-neutral entry point.
- Produces: `contextTokenWindow(profile): number` for model override or 32,768-token fallback.
- Preserves: `streamChatCompletion` as a compatibility export until all callers and tests move.

- [ ] **Step 1: Write failing adapter-selection and request tests**

```ts
it('dispatches chat completions without adding vendor thinking fields in model-default mode', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(sseDataResponse([
    { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    '[DONE]',
  ]));
  await streamModelResponse(runtimeModel({ protocol: 'openai-chat-completions', thinkingMode: 'model-default' }), messages, handlers, signal, fetchImpl);
  const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
  expect(fetchImpl.mock.calls[0][0]).toBe('https://example.test/v1/chat/completions');
  expect(body).not.toHaveProperty('enable_thinking');
  expect(body).not.toHaveProperty('chat_template_kwargs');
  expect(body).not.toHaveProperty('reasoning_effort');
});

it('merges only allowed custom request fields', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(sseDataResponse([
    { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]',
  ]));
  await streamModelResponse(runtimeModel({
    protocol: 'openai-chat-completions', thinkingMode: 'custom',
    customRequestBody: {
      model: 'replacement', messages: [], stream: false,
      extra_body: { enable_thinking: true }, temperature: 0.1,
    },
  }), messages, handlers, signal, fetchImpl);
  const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
  expect(body).toMatchObject({ model: 'fixture', stream: true, extra_body: { enable_thinking: true }, temperature: 0.1 });
});

it('uses the model context-window override for compression planning', () => {
  expect(contextTokenWindow(runtimeModel({ contextWindowTokens: 65_536 }))).toBe(65_536);
  expect(contextTokenWindow(runtimeModel({ contextWindowTokens: undefined }))).toBe(32_768);
});
```

Define the shared adapter-test stream helper in the same file:

```ts
function sseDataResponse(entries: readonly (Record<string, unknown> | '[DONE]')[]): Response {
  const text = entries.map((entry) => `data: ${entry === '[DONE]' ? entry : JSON.stringify(entry)}\n\n`).join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
const signal = new AbortController().signal;
const handlers = {
  onAnswerDelta: vi.fn(),
  onRawReasoningDelta: vi.fn(),
  onReasoningSummaryDelta: vi.fn(),
  onPhase: vi.fn(),
  onNativeToolCalls: vi.fn(),
};
```

- [ ] **Step 2: Run adapter and existing provider tests to confirm RED**

Run: `pnpm exec vitest run tests/providerAdapters.test.ts tests/modelProvider.test.ts`

Expected: FAIL because the registry and chat adapter do not exist.

- [ ] **Step 3: Extract the adapter contract and current Chat Completions behavior**

```ts
export interface ProviderAdapter {
  readonly protocol: ProviderProtocol;
  stream(input: ProviderStreamInput): Promise<ProviderStreamResult>;
}

export function providerAdapterFor(protocol: ProviderProtocol): ProviderAdapter {
  const adapter = adapters.get(protocol);
  if (!adapter) throw new Error(`Unsupported provider protocol: ${protocol}`);
  return adapter;
}
```

Move Chat Completions endpoint construction, request-body mapping, and SSE parsing behind `openAiChatCompletionsAdapter`. Keep context compression, continuation, reasoning-recovery, timing, and aggregate metrics in `modelProvider.ts`. Re-export existing public message and handler types to avoid an all-at-once import rewrite.

Replace capability-name-based context selection with `contextTokenWindow(profile)`, using a positive model override when present and the existing conservative 32,768-token fallback otherwise.

Custom request merging must protect `model`, `messages`, `stream`, `tools`, `tool_choice`, and transport-owned usage fields. Do not emit legacy Qwen/OpenAI thinking parameters unless they were migrated into provider custom JSON.

- [ ] **Step 4: Run provider tests and type checking**

Add `tests/providerAdapters.test.ts` to the explicit `pnpm test` script.

Run: `pnpm exec vitest run tests/providerAdapters.test.ts tests/modelProvider.test.ts`

Expected: PASS with all old Chat Completions stream cases preserved.

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the isolated task**

```bash
git add src/agent/providerAdapters src/agent/modelProvider.ts tests/providerAdapters.test.ts tests/modelProvider.test.ts package.json
git commit -m "refactor: route chat completions through provider adapter"
```

### Task 5: OpenAI Responses Adapter

**Files:**
- Create: `src/agent/providerAdapters/openAiResponses.ts`
- Modify: `src/agent/providerAdapters/registry.ts`
- Test: `tests/providerAdapters.test.ts`

**Interfaces:**
- Consumes: `ProviderAdapter`, normalized `ChatMessage[]`, `NativeToolSchema[]`, and `ModelStreamHandlers`.
- Produces: `openAiResponsesAdapter` for `openai-responses`.

- [ ] **Step 1: Add failing Responses request and stream tests**

```ts
it('normalizes OpenAI Responses text, reasoning summary, tools, and usage', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(namedSseResponse([
    ['response.reasoning_summary_text.delta', { delta: 'plan' }],
    ['response.output_text.delta', { delta: 'answer' }],
    ['response.output_item.added', { item: { type: 'function_call', id: 'call-1', name: 'read_file' } }],
    ['response.function_call_arguments.delta', { item_id: 'call-1', delta: '{"path":"README.md"}' }],
    ['response.completed', { response: { usage: { input_tokens: 10, output_tokens: 4 } } }],
  ]));
  await streamModelResponse(runtimeModel({ protocol: 'openai-responses' }), messages, handlers, signal, fetchImpl);
  expect(handlers.onReasoningSummaryDelta).toHaveBeenCalledWith('plan');
  expect(handlers.onAnswerDelta).toHaveBeenCalledWith('answer');
  expect(handlers.onNativeToolCalls).toHaveBeenCalledWith([
    { id: 'call-1', name: 'read_file', arguments: { path: 'README.md' } },
  ]);
});
```

Add this event helper beside `sseDataResponse`:

```ts
function namedSseResponse(events: readonly [string, Record<string, unknown>][]): Response {
  const text = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}
```

Cover input conversion for system/user/assistant/tool messages, image parts, `max_output_tokens`, duplicate event IDs, malformed tool JSON, response failure events, cancellation, and missing final output.

- [ ] **Step 2: Run adapter tests and confirm RED**

Run: `pnpm exec vitest run tests/providerAdapters.test.ts -t "OpenAI Responses"`

Expected: FAIL because `openAiResponsesAdapter` is not registered.

- [ ] **Step 3: Implement the Responses adapter**

```ts
const body = {
  model: input.profile.model,
  input: toResponsesInput(input.messages),
  stream: true,
  max_output_tokens: input.profile.maxOutputTokens,
  tools: toResponsesTools(input.tools),
};
```

Map `response.output_text.delta` to answer deltas, `response.reasoning_summary_text.delta` to native reasoning summaries, function-call item/argument events to normalized tool calls, and completed usage to existing metric fields. Treat raw reasoning as absent unless the provider explicitly emits a displayable field.

- [ ] **Step 4: Run all adapter tests**

Run: `pnpm exec vitest run tests/providerAdapters.test.ts tests/modelProvider.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the isolated task**

```bash
git add src/agent/providerAdapters/openAiResponses.ts src/agent/providerAdapters/registry.ts tests/providerAdapters.test.ts
git commit -m "feat: add OpenAI Responses provider adapter"
```

### Task 6: Anthropic Messages Adapter

**Files:**
- Create: `src/agent/providerAdapters/anthropicMessages.ts`
- Modify: `src/agent/providerAdapters/registry.ts`
- Test: `tests/providerAdapters.test.ts`

**Interfaces:**
- Consumes: the common adapter contract.
- Produces: `anthropicMessagesAdapter` for `anthropic-messages`.

- [ ] **Step 1: Add failing Anthropic request and stream tests**

```ts
it('uses Anthropic auth and normalizes thinking, text, tools, and usage', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(namedSseResponse([
    ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } }],
    ['content_block_start', { index: 1, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'answer' } }],
    ['message_stop', {}],
  ]));
  await streamModelResponse(runtimeModel({ protocol: 'anthropic-messages' }), messages, handlers, signal, fetchImpl);
  expect(fetchImpl).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.objectContaining({
    headers: expect.objectContaining({ 'x-api-key': 'secret', 'anthropic-version': expect.any(String) }),
  }));
  expect(handlers.onRawReasoningDelta).toHaveBeenCalledWith('plan');
  expect(handlers.onAnswerDelta).toHaveBeenCalledWith('answer');
});
```

Cover system-message extraction, image blocks, tool-use blocks, `input_json_delta`, `message_start`/`message_delta` usage, stop reasons, errors, timeout, and cancellation.

- [ ] **Step 2: Run Anthropic-focused tests and confirm RED**

Run: `pnpm exec vitest run tests/providerAdapters.test.ts -t "Anthropic"`

Expected: FAIL because the Anthropic adapter is missing.

- [ ] **Step 3: Implement the Anthropic adapter**

```ts
const body = {
  model: input.profile.model,
  system: extractAnthropicSystem(input.messages),
  messages: toAnthropicMessages(input.messages),
  stream: true,
  max_tokens: input.profile.maxOutputTokens,
  tools: toAnthropicTools(input.tools),
};
```

Map Anthropic thinking blocks to raw reasoning, text blocks to answer deltas, tool-use blocks to normalized native calls, and usage counters to existing metrics. Custom request values may add provider fields but cannot replace model, messages, stream, max tokens, or tools.

- [ ] **Step 4: Run all adapter tests and type checking**

Run: `pnpm exec vitest run tests/providerAdapters.test.ts tests/modelProvider.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the isolated task**

```bash
git add src/agent/providerAdapters/anthropicMessages.ts src/agent/providerAdapters/registry.ts tests/providerAdapters.test.ts
git commit -m "feat: add Anthropic Messages provider adapter"
```

### Task 7: Provider IPC, Discovery, and Minimal Inference Tests

**Files:**
- Create: `src/agent/providerConnection.ts`
- Modify: `src/agent/worker.ts`
- Modify: `src/preload.ts`
- Modify: `src/renderer/types.d.ts`
- Modify: `src/renderer/composables/useApp.ts`
- Test: `tests/worker.test.ts`
- Test: `tests/agentRequestBroker.test.ts`

**Interfaces:**
- Produces renderer bridge methods: `saveModelProvider`, `deleteModelProvider`, `discoverProviderModels`, `testModelProvider`, `addProviderModels`, `updateProviderModel`, and `deleteProviderModel`.
- Produces: `testProviderConnection(provider, modelId, fetchImpl, signal): Promise<ProviderConnectionResult>`.
- Consumes: database methods from Task 2, discovery from Task 3, and adapters from Tasks 4-6.

- [ ] **Step 1: Add failing worker and bridge-contract tests**

```ts
it('discovers with an unsaved provider draft without persisting its key', async () => {
  const result = await harness.request({
    type: 'modelProvider.discoverModels',
    provider: providerInput({ apiKey: 'catalog-secret' }),
  });
  expect(result).toEqual({ status: 'available', models: ['model-a'] });
  expect(JSON.stringify(harness.database.getSnapshot())).not.toContain('catalog-secret');
});

it('tests inference separately from an unsupported catalog', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  ));
  await expect(testProviderConnection(
    runtimeProvider({ protocol: 'openai-chat-completions' }),
    'manual-model',
    fetchImpl,
    new AbortController().signal,
  )).resolves.toMatchObject({ ok: true, model: 'manual-model' });
});
```

Cover blank-key preservation on edits, stable safe error codes, invalid request rejection, batch-add atomicity, snapshot refresh, stale test-result invalidation, and operation cancellation.

Add worker assertions that image attachments are accepted only when the joined provider has `allowImages: true`, and native tool schemas are sent only when `toolCallingMode === 'native'`; text fallback remains the existing fenced-JSON agent path.

- [ ] **Step 2: Run worker and broker tests and confirm RED**

Run: `pnpm exec vitest run tests/worker.test.ts tests/agentRequestBroker.test.ts`

Expected: FAIL because the provider operations are not wired.

- [ ] **Step 3: Implement worker-owned operations**

```ts
if (message.type === 'modelProvider.discoverModels') {
  return discoverProviderModels(runtimeProviderFromInput(message.provider, database), fetch, operationSignal);
}
if (message.type === 'modelProvider.test') {
  return testProviderConnection(
    runtimeProviderFromInput(message.provider, database),
    message.modelId,
    fetch,
    operationSignal,
  );
}
```

The minimal inference test sends one protocol-valid user input, requests a very small output, uses no tools, and accepts the first valid answer/content event as connectivity proof. Catalog success and inference success remain separate results. All errors pass through existing redaction before IPC.

Expose typed preload methods and update `useApp` so successful mutations refresh the snapshot exactly once. Keep operation state inside the current renderer session and clear it when provider fingerprints change.

- [ ] **Step 4: Run focused tests and type checking**

Run: `pnpm exec vitest run tests/worker.test.ts tests/agentRequestBroker.test.ts tests/protocol.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the isolated task**

```bash
git add src/agent/providerConnection.ts src/agent/worker.ts src/preload.ts src/renderer/types.d.ts src/renderer/composables/useApp.ts tests/worker.test.ts tests/agentRequestBroker.test.ts
git commit -m "feat: expose provider catalog and connection operations"
```

### Task 8: Provider-Level Scheduler Capacity

**Files:**
- Modify: `src/agent/turnScheduler.ts`
- Modify: `src/agent/worker.ts`
- Test: `tests/turnScheduler.test.ts`
- Test: `tests/worker.test.ts`

**Interfaces:**
- Changes: `ScheduledTurn` gains `capacityKey`; `modelProfileId` remains the event and persistence identity.
- Changes: scheduler queue/running maps and `limitFor` use `capacityKey`.
- Produces: provider edits call `scheduler.updateLimit(providerId)`.

- [ ] **Step 1: Add a failing shared-provider capacity test**

```ts
it('shares one capacity limit across different models from the same provider', async () => {
  const first = deferred<void>();
  const harness = createHarness(() => 1);
  harness.scheduler.enqueue(task('a', 'thread-a', 'model-a', () => first.promise, 'provider-1'));
  harness.scheduler.enqueue(task('b', 'thread-b', 'model-b', async () => undefined, 'provider-1'));
  await flushMicrotasks();
  expect(harness.started).toEqual(['a']);
  expect(harness.queued).toContainEqual(['b', 1]);
});
```

Extend the existing `task` helper with a final optional capacity argument whose default is the model profile ID, keeping every existing scheduler test readable:

```ts
function task(
  turnId: string,
  threadId: string,
  modelProfileId: string,
  run: ScheduledTurn['run'],
  capacityKey = modelProfileId,
): ScheduledTurn {
  return { turnId, threadId, modelProfileId, capacityKey, title: turnId, run };
}
```

Also prove different providers run independently, model IDs remain in emitted events, cancellation releases provider capacity once, and reducing a provider limit does not terminate running turns.

Add a worker test that queues a turn, edits its provider, then releases it and verifies the queued turn used the immutable runtime profile captured at submission while the following turn uses the saved provider update.

- [ ] **Step 2: Run scheduler tests and confirm RED**

Run: `pnpm exec vitest run tests/turnScheduler.test.ts tests/worker.test.ts`

Expected: FAIL because scheduling is keyed by model profile.

- [ ] **Step 3: Generalize scheduler maps to `capacityKey`**

```ts
export interface ScheduledTurn {
  turnId: string;
  threadId: string;
  modelProfileId: string;
  capacityKey: string;
  title: string;
  run(signal: AbortSignal): Promise<void>;
}
```

In the worker, set `capacityKey` to the joined profile's `providerId`; use the demo profile ID only for demo turns. Resolve provider concurrency from `getModelProviderForRuntime(capacityKey)`. Keep every emitted `modelProfileId` unchanged.

- [ ] **Step 4: Run scheduler and worker tests**

Run: `pnpm exec vitest run tests/turnScheduler.test.ts tests/worker.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the isolated task**

```bash
git add src/agent/turnScheduler.ts src/agent/worker.ts tests/turnScheduler.test.ts tests/worker.test.ts
git commit -m "feat: share scheduler capacity by provider"
```

### Task 9: Provider Draft and Catalog Selection State

**Files:**
- Create: `src/renderer/providerForm.ts`
- Create: `src/renderer/modelCatalogSelection.ts`
- Modify: `src/renderer/composables/useApp.ts`
- Test: `tests/renderer-state.test.ts`

**Interfaces:**
- Produces: `createProviderDraft`, `loadProviderDraft`, `buildModelProviderInput`, `providerDraftFingerprint`, and `providerDraftValidationIssue`.
- Produces: `parseManualModelIds`, `filterCatalogModels`, `selectAllModels`, `clearAllModels`, `selectFilteredModels`, and `clearFilteredModels`.
- Produces: `groupModelsByProvider(providers, models)` for Settings and Conversation.
- Produces: `createProviderOperationState(): { discovery: 'idle'; connection: 'untested' }` so transient badges are reconstructed rather than persisted.

- [ ] **Step 1: Write failing pure-state tests**

```ts
it('creates a blank provider draft instead of copying the selected provider', () => {
  const draft = createProviderDraft(false);
  expect(draft).toMatchObject({ id: undefined, name: '', apiKey: '', protocol: 'openai-chat-completions' });
  expect(draft.baseUrl).toBe('');
});

it('selects only search results without clearing hidden selections', () => {
  const all = ['qwen-max', 'deepseek-v4-pro', 'gpt-5'];
  const selected = new Set(['gpt-5']);
  expect([...selectFilteredModels(all, selected, 'qwen')]).toEqual(['gpt-5', 'qwen-max']);
  expect([...clearFilteredModels(all, new Set(all), 'deepseek')]).toEqual(['qwen-max', 'gpt-5']);
});

it('parses manual ids case-sensitively and removes exact duplicates', () => {
  expect(parseManualModelIds('Qwen-Max, qwen-max\ndeepseek-v4-pro')).toEqual([
    'Qwen-Max', 'qwen-max', 'deepseek-v4-pro',
  ]);
});

it('preserves saved credentials and headers when edit fields stay blank', () => {
  const input = buildModelProviderInput(
    loadProviderDraft(runtimeProvider({ apiKey: undefined, apiKeyConfigured: true, customHeaderNames: ['x-tenant'] })),
  );
  expect(input.apiKey).toBeUndefined();
  expect(input.customHeaders).toEqual({ 'x-tenant': '' });
});

it('starts transient provider status as untested after state reconstruction', () => {
  expect(createProviderOperationState()).toEqual({ discovery: 'idle', connection: 'untested' });
});
```

Cover full select/clear, query changes preserving selection, already-added IDs, dirty fingerprints, blank API key preserving an existing key, custom JSON validation, and grouped sorting.

- [ ] **Step 2: Run renderer tests and confirm RED**

Run: `pnpm exec vitest run tests/renderer-state.test.ts`

Expected: FAIL because the provider and catalog helpers do not exist.

- [ ] **Step 3: Implement immutable helpers**

```ts
export function selectFilteredModels(
  allIds: readonly string[],
  selected: ReadonlySet<string>,
  query: string,
): Set<string> {
  const next = new Set(selected);
  for (const id of filterCatalogModels(allIds, query)) next.add(id);
  return next;
}

export function parseManualModelIds(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((id) => id.trim()).filter(Boolean))];
}

export function createProviderOperationState() {
  return { discovery: 'idle' as const, connection: 'untested' as const };
}
```

Provider fingerprints include every connection-affecting field but never expose the API key. Use a one-way in-memory marker such as key presence plus draft revision, not the key text, in diagnostic labels.

- [ ] **Step 4: Run renderer tests**

Run: `pnpm exec vitest run tests/renderer-state.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the isolated task**

```bash
git add src/renderer/providerForm.ts src/renderer/modelCatalogSelection.ts src/renderer/composables/useApp.ts tests/renderer-state.test.ts
git commit -m "feat: add provider and catalog renderer state"
```

### Task 10: Provider Settings, Catalog Dialog, and Grouped Chat Selector

**Files:**
- Modify: `src/renderer/components/SettingsView.vue`
- Modify: `src/renderer/components/Conversation.vue`
- Modify: `src/renderer/App.vue`
- Modify: `src/renderer/i18n/messages.ts`
- Modify: `src/renderer/styles/app.css`
- Modify: `src/renderer/modelControls.ts`
- Modify: `src/renderer/modelProfileForm.ts`
- Test: `tests/renderer-state.test.ts`
- Test: `tests/e2e/app.spec.ts`

**Interfaces:**
- Consumes: provider/model commands from Task 7 and pure helpers from Task 9.
- Produces: a provider list/editor, configured-model list, catalog dialog, per-model override editor, and provider-grouped chat selector.
- Removes: renderer dependence on per-model API URL, key, protocol, concurrency, and forced reasoning controls.

- [ ] **Step 1: Add failing renderer-source and Playwright flow tests**

```ts
it('starts New provider with a blank isolated form', async () => {
  await page.getByRole('button', { name: '新建' }).click();
  await expect(page.getByLabel('名称')).toHaveValue('');
  await expect(page.getByLabel('API 地址')).toHaveValue('');
  await expect(page.getByLabel('API Key')).toHaveValue('');
});

it('supports filtered bulk model selection and manual addition', async () => {
  await page.getByRole('button', { name: '获取可用模型' }).click();
  await page.getByPlaceholder('搜索模型').fill('deepseek');
  await page.getByRole('button', { name: '选择搜索结果' }).click();
  await expect(page.getByText(/已选择 2/)).toBeVisible();
  await page.getByLabel('手动添加模型').fill('manual-a,manual-b');
  await page.getByRole('button', { name: '添加所选' }).click();
  await expect(page.getByText('manual-a')).toBeVisible();
});
```

Add source assertions that model rows expose only display name, enabled/default, context window, and output token fields; the chat header has no forced `enable_thinking` or reasoning-effort control in model-default mode.

- [ ] **Step 2: Run renderer tests and confirm RED**

Run: `pnpm exec vitest run tests/renderer-state.test.ts`

Expected: FAIL because Settings still uses the one-profile form.

- [ ] **Step 3: Replace the Settings model section**

Build the following component state in `SettingsView.vue`:

```ts
const providerDraft = reactive(createProviderDraft(props.modelProviders.length === 0));
const selectedCatalogIds = ref<Set<string>>(new Set());
const catalogQuery = ref('');
const catalogOpen = ref(false);
const editingModelId = ref<string>();
```

Use explicit icon or icon-plus-text commands for close, refresh, edit, delete, search, and selection actions. Keep the catalog dialog at a stable responsive size with a scrollable model list. Show selected/total counts, `Select all`, `Clear all`, `Select search results`, and `Clear search results`. Mark `available`, `missing`, `manual`, and already-added states without nesting cards.

The provider editor includes name, API URL, masked key input, protocol, concurrency, timeout, model-default/custom thinking, custom request JSON, optional custom headers, image support, tool-calling mode, and catalog-path override. The child-model editor includes only its permitted metadata and token overrides.

- [ ] **Step 4: Group the chat selector and remove forced reasoning controls**

```vue
<optgroup v-for="group in modelGroups" :key="group.provider.id" :label="group.provider.name">
  <option v-for="profile in group.models" :key="profile.id" :value="profile.id">
    {{ profile.name }}{{ profile.catalogState === 'missing' ? ` (${t('catalogMissing')})` : '' }}
  </option>
</optgroup>
```

Use the selected provider's `allowImages` to enable attachments. Use its `toolCallingMode` in worker runtime resolution. Delete obsolete per-model reasoning form helpers only after no renderer caller remains.

- [ ] **Step 5: Add complete Chinese/English copy and responsive styles**

Add translations for provider protocols, discovery/test distinctions, manual entry, selection counts/actions, catalog states, custom JSON errors, deletion blockers, timeout/auth/protocol failures, and unsaved-change confirmation. Ensure controls do not overflow at 1280x720 and 2560x1440.

- [ ] **Step 6: Run renderer tests and type checking**

Run: `pnpm exec vitest run tests/renderer-state.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the isolated task**

```bash
git add src/renderer/components/SettingsView.vue src/renderer/components/Conversation.vue src/renderer/App.vue src/renderer/i18n/messages.ts src/renderer/styles/app.css src/renderer/modelControls.ts src/renderer/modelProfileForm.ts tests/renderer-state.test.ts tests/e2e/app.spec.ts
git commit -m "feat: add provider model catalog settings"
```

### Task 11: Upgrade, End-to-End, Security, and Visual Verification

**Files:**
- Modify: `tests/e2e/app.spec.ts`
- Modify: `tests/e2e/fakeModelServer.ts`
- Modify: `tests/e2e/live-model.spec.ts`
- Modify: `tests/database.test.ts`
- Modify: `tests/redaction.test.ts`
- Modify: `tests/packageContents.test.ts`
- Review: every file changed in Tasks 1-10

**Interfaces:**
- Verifies the complete spec; produces no new product API unless a failing acceptance test exposes a missing contract.

- [ ] **Step 1: Add acceptance fixtures for all critical flows**

```ts
test('upgrades legacy profiles and keeps historical thread model references', async () => {
  const userData = createUserData('legacy-provider-migration');
  seedLegacyModelProfile(userData);
  const app = await launchPackagedApp(userData);
  const window = await app.firstWindow();
  await window.getByRole('button', { name: '设置' }).click();
  await expect(window.getByText('Qwen3.5-9B')).toBeVisible();
  await app.close();
});

test('keeps a configured model when refresh no longer advertises it', async () => {
  const userData = createUserData('catalog-missing');
  const server = await startFakeModelServer();
  const db = openDatabase(join(userData, 'app.sqlite'));
  const provider = db.saveModelProvider(providerInput({ baseUrl: server.baseUrl }));
  db.addProviderModels(provider.id, [{ modelId: 'model-a' }, { modelId: 'model-b' }]);
  db.close();
  server.setConnectionState({ modelIds: ['model-a'] });
  const app = await launchPackagedApp(userData);
  const window = await app.firstWindow();
  await window.getByRole('button', { name: '设置' }).click();
  await window.getByRole('button', { name: '刷新模型目录' }).click();
  await expect(window.getByText('model-b')).toBeVisible();
  await expect(window.getByText('目录中不可用')).toBeVisible();
  await app.close();
  await server.close();
});
```

Define the migration fixture in `app.spec.ts` using the exact legacy columns read by migration 12:

```ts
function seedLegacyModelProfile(userData: string): void {
  const db = new DatabaseSync(join(userData, 'app.sqlite'));
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations (version, applied_at) VALUES (11, datetime('now'));
    CREATE TABLE model_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL,
      deployment_type TEXT NOT NULL, runtime_type TEXT NOT NULL,
      base_url TEXT NOT NULL, model TEXT NOT NULL, api_key TEXT,
      capabilities TEXT NOT NULL, reasoning TEXT NOT NULL,
      max_concurrency INTEGER NOT NULL, max_output_tokens INTEGER NOT NULL,
      response_speed TEXT NOT NULL, is_default INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  db.prepare(`INSERT INTO model_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      'legacy-local', 'Qwen3.5-9B', 'openai-compatible', 'private', 'openai-compatible',
      'http://127.0.0.1:8080/v1', 'Qwen3.5-9B', 'local-not-used',
      JSON.stringify({ text: true, vision: false, nativeTools: true }),
      JSON.stringify({ mode: 'disabled', protocol: 'none', display: 'auto' }),
      1, 8192, 'standard', 1,
      '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z',
    );
  db.close();
}
```

Extend `FakeModelServer` with protocol-specific queued responses for `/v1/responses` and `/v1/messages`, while retaining `setConnectionState({ modelIds })` for catalog refresh tests. Each response helper must emit the exact event shapes asserted in Tasks 5 and 6.

Add mocked end-to-end providers for Chat Completions, Responses, and Anthropic Messages; unsupported `/models` plus manual inference; provider deletion blockers; cancellation of discovery, test, and long-running generation; and API-key absence from snapshots and captured errors.

- [ ] **Step 2: Run focused acceptance tests and fix only evidenced gaps**

Run: `pnpm exec vitest run tests/database.test.ts tests/providerCatalog.test.ts tests/providerAdapters.test.ts tests/worker.test.ts tests/turnScheduler.test.ts tests/renderer-state.test.ts tests/redaction.test.ts`

Expected: PASS.

- [ ] **Step 3: Run the full unit and type gates**

Run: `pnpm test`

Expected: every listed Vitest file passes.

Run: `pnpm typecheck`

Expected: all Vue, Node, and type-test projects pass.

- [ ] **Step 4: Package and run Playwright acceptance**

Run: `pnpm test:e2e`

Expected: the packaged Electron app passes legacy upgrade, provider configuration, catalog, manual model, grouped selector, and cancellation flows.

- [ ] **Step 5: Perform visual verification**

Capture Playwright screenshots at 1280x720 and 2560x1440 for:

- blank new-provider form;
- populated provider with model list;
- catalog dialog with a search filter and mixed selections;
- missing/manual model states;
- grouped chat model selector.

Inspect that text does not overlap or clip, the modal remains within the viewport, lists scroll without resizing the dialog, buttons stay visible, and no API key appears. Save test artifacts under the existing Playwright output directory only.

- [ ] **Step 6: Run repository hygiene checks**

Run: `git -c safe.directory=D:/workspace/AI/2026-08-14/ai-aifar diff --check`

Expected: no whitespace errors.

Inspect `git status --short` and the scoped diff. Confirm pre-existing dirty changes were preserved, no generated database or secret file was added, and the implementation matches the design document.

- [ ] **Step 7: Commit the isolated acceptance task**

```bash
git add tests/e2e/app.spec.ts tests/e2e/fakeModelServer.ts tests/e2e/live-model.spec.ts tests/database.test.ts tests/redaction.test.ts tests/packageContents.test.ts
git commit -m "test: verify provider model catalog end to end"
```

## Execution Notes

- Read the spec before every task that changes a cross-layer interface.
- Use `superpowers:test-driven-development` for each RED/GREEN cycle.
- Use `superpowers:requesting-code-review` after Tasks 2, 6, 8, and 10 because those are the database, protocol, scheduler, and UI integration boundaries.
- Use `superpowers:verification-before-completion` before reporting Task 11 complete.
- If implementation runs in the current dirty workspace, do not execute the commit steps; report the scoped files and leave all changes uncommitted.
