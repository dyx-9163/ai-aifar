# Provider and Model Catalog Design

## Status

Approved in conversation on 2026-08-20. This document is ready for implementation planning.

This design supersedes the provider-transport and per-model reasoning-input decisions in:

- `2026-08-17-provider-capabilities-concurrent-turns-design.md`
- `2026-08-20-time-and-reasoning-controls-design.md`

Those documents remain authoritative for unrelated scheduling, event presentation, time context, and timeout behavior.

## Goal

Replace the current one-form-per-model configuration with a provider-first model catalog similar to DeepSeek Harness:

- configure a provider connection once;
- support OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages transports;
- fetch the provider's available model IDs when its catalog endpoint supports it;
- allow manual model IDs when discovery is unavailable or incomplete;
- provide detailed search and bulk-selection controls;
- keep provider behavior generic instead of hardcoding DeepSeek, Qwen, ChatGPT, Pangu, or local-model names;
- allow only context-window and maximum-output-token overrides per model.

## Product Decisions

1. A provider and a selectable model are separate persisted entities.
2. API URL, API key, transport protocol, concurrency, timeout, thinking behavior, and custom request values belong to the provider.
3. A model stores its provider reference, model ID, display name, enabled state, catalog state, optional context-window override, and optional maximum-output-token override.
4. Provider protocols are:
   - `openai-chat-completions`;
   - `openai-responses`;
   - `anthropic-messages`.
5. Thinking control has two generic modes:
   - `model-default`: send no vendor-specific thinking switch;
   - `custom`: merge explicitly configured request JSON into the provider request.
6. There is no universal on/off thinking field. Disabling thinking for a provider that requires `enable_thinking: false`, `reasoning_effort`, or another vendor field is expressed through custom request JSON.
7. Response parsing recognizes protocol-native and commonly encountered provider reasoning fields, but request behavior is never inferred from a model-name substring.
8. Refreshing a model catalog never deletes an already configured model. A missing model is retained and marked `missing` until it reappears or the user removes it.
9. Existing model IDs, thread references, defaults, and history remain valid through migration.
10. Runtime states such as testing, connected, failed, running, and cancelling are projections of current activity. They are not restored as active states after restart.

## Non-Goals

- No provider SDK dependency is required for the first implementation.
- No automatic guessing of protocol or vendor from a model ID.
- No automatic deletion of models based on a catalog response.
- No per-model API key, transport, concurrency, or thinking configuration.
- No permanent storage of transient connection-test results.
- No redesign of the existing scheduler, turn-event protocol, or local-runtime lifecycle.
- No claim that every vendor exposes a `/models` endpoint.

## Architecture

```text
Settings UI
  Provider editor
  Model catalog selector
  Per-model token override editor
          |
Electron IPC validation
          |
Worker-owned provider service
  Provider persistence
  Catalog discovery
  Connection testing
  Protocol adapter registry
          |
  OpenAI Chat Completions
  OpenAI Responses
  Anthropic Messages
```

The worker remains the authority for credentials, persistence, request creation, catalog discovery, and connection tests. The renderer receives only redacted provider data and normalized results.

The existing scheduler continues to select work by model-profile ID. Model IDs remain stable, so queue ownership, thread selection, and historical event references do not need a destructive rewrite.

## Domain Model

### Provider

```ts
type ProviderProtocol =
  | 'openai-chat-completions'
  | 'openai-responses'
  | 'anthropic-messages';

type ProviderThinkingMode = 'model-default' | 'custom';

interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  apiKeyConfigured: boolean;
  maxConcurrency: number;
  requestTimeoutMs: number;
  allowImages: boolean;
  toolCallingMode: 'native' | 'text-fallback';
  thinkingMode: ProviderThinkingMode;
  customRequestBody?: Record<string, unknown>;
  customHeaderNames: string[];
  catalogPath?: string;
  createdAt: string;
  updatedAt: string;
}
```

The renderer-facing type contains only `apiKeyConfigured`. The runtime provider type may contain the API key and is available only inside the worker.

`customRequestBody` is merged only into the protocol adapter's request body. Core fields such as model ID, messages/input, streaming mode, tools, and cancellation cannot be removed by the custom object. Conflicting values follow an explicit allowlist so custom configuration cannot silently break request ownership.

Custom headers are an advanced option. The renderer receives configured header names but never saved header values. Header names and new values are validated, forbidden transport headers are rejected, and all values are redacted from events and errors. A blank value while editing preserves the saved value for that header.

Image input and native tool calling are provider-level compatibility settings. They are not inferred from model names and are not repeated for each model. Text streaming and usage/reasoning output remain adapter-observed behavior.

### Provider Model

The existing public name `ModelProfile` may remain during migration to reduce churn, but its logical role becomes a child model of a provider.

```ts
type ModelCatalogState = 'available' | 'missing' | 'manual';

interface ProviderModel {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  catalogState: ModelCatalogState;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
```

`contextWindowTokens` and `maxOutputTokens` are nullable overrides. An unset value means the application uses provider metadata when available, otherwise its existing conservative runtime default.

Model IDs are treated as case-sensitive opaque strings. The application does not derive capabilities from names such as `qwen`, `deepseek`, `gpt`, or `pangu`.

## Persistence and Migration

Add a `model_providers` table and associate each existing `model_profiles` row with a provider ID. Keep existing model-profile primary keys so thread, setting, scheduler, and history references remain valid.

Migration rules:

1. Create a provider grouping fingerprint from exact connection and behavior fields: normalized base URL, API key, transport/runtime compatibility, concurrency, timeout, image/tool capability, reasoning request behavior, and relevant custom values.
2. Group legacy profiles only when the complete fingerprint matches. Never merge merely because two rows use the same host or model family.
3. Preserve every legacy model-profile ID and its default flag.
4. Preserve each legacy maximum-output-token value as a model override.
5. Leave the context-window override unset when the old schema has no authoritative value.
6. Convert legacy thinking configuration to either `model-default` or equivalent provider custom request JSON so migration does not silently change request behavior.
7. If any legacy fields cannot be safely combined, create separate providers instead of guessing.
8. Run the migration transactionally and make it idempotent.

For the first release, legacy provider columns may remain on `model_profiles` but new runtime reads use the provider relation. Removing obsolete columns is deferred to a later cleanup migration.

Configuration is persisted locally as it is today. This feature does not introduce a new credential vault. API keys must never appear in renderer snapshots, logs, errors, catalog results, or test fixtures outside explicitly isolated database tests.

## Provider Protocol Adapters

Each adapter owns endpoint construction, authentication headers, request-body mapping, stream parsing, usage parsing, and connection-test behavior.

### OpenAI Chat Completions

- Request endpoint: `<baseUrl>/chat/completions`.
- Default authentication: `Authorization: Bearer <key>`.
- Model discovery: `<baseUrl>/models`.
- Normalize answer deltas, tool calls, usage, and provider-supplied reasoning fields.

### OpenAI Responses

- Request endpoint: `<baseUrl>/responses`.
- Default authentication: `Authorization: Bearer <key>`.
- Model discovery: `<baseUrl>/models`.
- Normalize response events into the existing reasoning, answer, tool, usage, completion, failure, and cancellation events.

### Anthropic Messages

- Request endpoint: `<baseUrl>/messages`.
- Default authentication: `x-api-key` plus a validated Anthropic version header.
- Model discovery: `<baseUrl>/models` when available.
- Normalize content blocks, thinking blocks, tool use, usage, completion, failure, and cancellation.

### URL Handling

The stored base URL is the API root, commonly ending in `/v1`. Endpoint construction removes only duplicate slashes and a trailing slash. It must not remove meaningful segments such as `compatible-mode/v1`.

The advanced provider form may override the catalog path when a compatible service exposes model discovery elsewhere. Request endpoints remain protocol-owned in this release.

## Thinking Behavior

`model-default` is the recommended mode. It sends no client-added thinking switch and lets the selected model and endpoint decide whether to reason.

`custom` accepts validated JSON for provider-specific controls. Examples may be shown as neutral field-shape hints, but saved behavior is driven by user input rather than a hardcoded model-name rule.

The response layer separately observes and normalizes:

- OpenAI Responses reasoning-summary events;
- Anthropic thinking content blocks;
- explicit reasoning fields returned by OpenAI-compatible providers, including `reasoning_content`-style deltas.

Observed reasoning output does not prove that a request-side switch exists. Missing reasoning output is not treated as a transport failure.

## Model Catalog Discovery

The catalog request uses the unsaved provider draft so a user can discover models before creating the provider.

Catalog normalization:

1. Accept a bounded response matching `{ data: [{ id }] }` and adapter-approved equivalent shapes.
2. Keep only non-empty string IDs.
3. Deduplicate by exact ID.
4. Sort for display without altering stored IDs.
5. Limit response bytes, parsed entries, and request duration.
6. Return normalized IDs only; never return request headers or credentials.

Recommended initial bounds are a 15-second timeout, 5 MiB response limit, and 10,000 model IDs. These values are constants with tests and may later become advanced settings.

Refresh behavior:

- fetched IDs already configured become `available`;
- configured non-manual IDs absent from the refresh become `missing`;
- manually added IDs remain `manual` unless the user explicitly adopts a matching catalog entry;
- selected-but-unsaved rows remain renderer draft state;
- a failed refresh does not change persisted catalog states;
- adding selected models is one database transaction.

## Model Selection Experience

The catalog dialog contains:

- a search field;
- selected count and total count;
- `Select all` and `Clear all` actions for the full catalog;
- `Select search results` and `Clear search results` actions for the current filter;
- one stable checkbox row per model ID;
- visible states for already added, newly selected, missing, and manual models;
- a scrollable list with stable dimensions;
- a manual-entry field accepting newline- or comma-separated IDs;
- `Cancel` and `Add selected` commands.

Search is case-insensitive for convenience but does not change model-ID casing. Changing the query does not clear selections. Already configured models are shown as selected and cannot be duplicated.

The provider page lists configured models under the provider. Editing a model exposes only display name, context-window override, maximum-output-token override, enabled state, and default selection.

The chat model selector groups enabled models by provider name. Missing catalog models remain selectable but show a warning marker until a live request or later catalog refresh confirms availability.

The chat header does not show a forced reasoning-effort or thinking toggle while the provider uses `model-default`. In `custom` mode, the provider editor explains that the saved custom request values apply to every turn using that provider; the chat page does not invent per-model choices.

## Provider Editor Behavior

`New provider` always creates an isolated blank draft with a new temporary identity. It must not mutate or reuse the currently selected provider form.

Editing behavior:

- an unchanged blank API-key field keeps the existing key;
- entering a new key replaces it;
- no masked placeholder is ever submitted as a credential;
- unsaved edits do not update the active provider or its models;
- switching away with dirty edits asks for confirmation;
- saving provider details and adding models are explicit operations.

Deleting a provider displays its model count. Deletion is blocked while any child model is the global default, selected by a thread, queued, running, or cancelling. The user must first switch those references. Once unreferenced, provider and child models are deleted transactionally.

## IPC and Worker Operations

Add validated request operations equivalent to:

```text
modelProvider.save
modelProvider.delete
modelProvider.test
modelProvider.discoverModels
providerModel.addMany
providerModel.update
providerModel.delete
```

IPC rules:

- provider drafts may include a key only on save, test, or discovery requests;
- snapshot and response objects are always redacted;
- batch model addition rejects duplicates before opening the transaction;
- all strings, URLs, JSON depth, JSON size, token values, and list lengths are bounded;
- cancellation uses an `AbortSignal` owned by the worker operation;
- renderer errors use stable error codes and safe user-facing messages.

## Discovery and Connection Testing

Discovery and inference validation are separate results:

1. `Discover models` calls the catalog endpoint using the unsaved provider draft.
2. `Test connection` uses a selected or manually entered model ID and sends the smallest protocol-valid non-tool request.
3. A successful catalog request proves only that authentication and discovery work; it does not prove that a selected model can generate.
4. A missing catalog endpoint leaves discovery in a warning state and still allows an inference test with a manual model ID.
5. A successful inference test does not mark a provider permanently connected. The result remains current-session UI state and is cleared after relevant fields change or the app restarts.
6. Both operations have independent cancellation and timeouts.

## Runtime Request Resolution

Before a turn starts, the worker resolves an immutable effective request configuration:

```text
provider connection and generic defaults
  -> provider protocol adapter
  -> selected model ID
  -> model context/output-token overrides
  -> ordinary per-turn input, tools, and cancellation
```

The resolved configuration is captured for that turn. Editing a provider or model does not mutate an already running request. Subsequent turns use the saved update.

Concurrency moves to the provider because models behind one endpoint usually share service capacity. The scheduler key becomes provider ID while preserving per-thread single-turn ordering. A provider concurrency change affects future scheduling and never terminates running turns.

## Runtime State and Recovery

Persist configuration and durable catalog state only. Do not persist `testing`, `connected`, `failed`, `running`, or `cancelling` as authoritative live state.

On startup:

- interrupted turns follow the existing recovery rules;
- provider connection badges start as `untested`;
- stale tool operations are reconciled by the existing timeline recovery path;
- no provider is contacted until the user tests, refreshes, or submits a turn.

## Errors and Safety

Use stable error categories:

- invalid API URL;
- unreachable endpoint;
- timeout;
- authentication or permission failure;
- unsupported catalog endpoint;
- unknown model or model access denied;
- protocol mismatch;
- malformed or oversized response;
- invalid custom JSON;
- cancelled by user.

A missing or unsupported `/models` endpoint is a warning, not proof that inference is unavailable. The UI offers manual model entry in the same state.

All provider errors pass through credential and header redaction before IPC. Raw response bodies are bounded and are not shown by default. Cancellation aborts fetch and stream readers and settles UI state exactly once.

## Verification Strategy

### Unit Tests

- Provider and provider-model input validation.
- URL construction without damaging `compatible-mode/v1` paths.
- Authentication and request mapping for all three adapters.
- Stream normalization for answer, reasoning, tool, usage, completion, failure, and cancellation events.
- Custom request-body allowlist and custom-header validation.
- Catalog parsing, exact-ID deduplication, bounds, timeout, and redaction.
- Search, select-all, clear-all, select-filtered, clear-filtered, and selection-preservation helpers.
- Manual comma/newline parsing and duplicate prevention.

### Database Tests

- Idempotent provider-table migration.
- Safe grouping only for exact legacy fingerprints.
- Preservation of model-profile IDs, API keys, defaults, output-token values, and thread references.
- Transactional batch addition and provider deletion safeguards.
- Missing-model refresh behavior and failed-refresh rollback.
- Redacted snapshots and worker-only credential reads.

### Renderer Tests

- New provider starts as a blank isolated draft.
- Editing one provider never mutates another.
- Blank key preserves the saved key without exposing it.
- Catalog selection remains stable across searches and refreshes.
- Model editor exposes only allowed per-model settings.
- Chat selector groups models by provider and marks missing models.
- Transient statuses reset after restart and cancellation settles once.

### Integration and End-to-End Tests

- Mock OpenAI Chat Completions provider with model discovery and streaming.
- Mock OpenAI Responses provider with model discovery and reasoning summary.
- Mock Anthropic Messages provider with model discovery and thinking/tool blocks.
- Unsupported `/models` followed by manual model addition and successful inference.
- Existing database upgrade followed by opening historical threads and selecting preserved models.
- Provider deletion blocked by active/default/thread references.

### Completion Gate

- Focused tests pass for each new module before integration.
- Full unit suite passes.
- TypeScript type checking passes.
- Electron UI is verified at desktop and narrow widths.
- API keys do not appear in snapshots, visible errors, or captured logs.
- A real or mock long-running stream can be cancelled without leaving the task or provider in a running state.

## Rollout Sequence

1. Add domain types and database migration while retaining compatibility reads.
2. Add protocol adapter interfaces and tests.
3. Move the existing OpenAI-compatible path behind the Chat Completions adapter.
4. Add Responses and Anthropic adapters.
5. Add provider CRUD, catalog discovery, and batch model operations through IPC.
6. Replace the settings form with provider and model-catalog views.
7. Group the chat selector by provider and resolve runtime requests through provider relations.
8. Remove obsolete renderer assumptions after migration and regression verification.

At every step, old model-profile IDs remain valid and the application can be tested against an upgraded copy of an existing database.
