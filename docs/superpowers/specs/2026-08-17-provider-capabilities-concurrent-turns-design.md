# Provider Capabilities, Reasoning Display, and Concurrent Turns Design

## Status

Approved in conversation on 2026-08-17.

This document supersedes the reasoning-display, reasoning-capability, and reasoning-parameter fallback decisions in `2026-08-17-runtime-settings-and-model-metrics-design.md`. The earlier document remains authoritative for unrelated runtime settings and metrics behavior.

## Goal

Make the desktop client model-agnostic while supporting:

- provider-supplied raw reasoning and provider-supplied reasoning summaries as separate display modes;
- independent execution across chats;
- a configurable concurrency limit and FIFO queue per model profile;
- capability-driven reasoning controls instead of globally hardcoded effort values;
- clear runtime state, cancellation, metrics, persistence, and recovery behavior.

The implementation must keep the existing Vue 3, Agent Client Core, worker, Electron IPC, and SQLite architecture. It must not add Redis, a separate queue service, or another persistence technology for this feature.

## Product Decisions

The approved decisions are:

1. The reasoning panel supports both raw reasoning and reasoning summary modes.
2. Raw reasoning is shown only when the provider returns an explicit, displayable reasoning field.
3. A reasoning summary is shown only when the provider returns a native summary. If no native summary exists, the UI says that the model does not provide one. The client does not make a second model request and does not create a heuristic summary.
4. Different chats may run simultaneously. A single chat has at most one queued or running turn so that its context remains ordered.
5. Concurrency is configured per model profile. Turns beyond the selected profile's limit enter a FIFO queue.
6. Reasoning controls and effort values come from the selected model profile's declared capabilities. They are not a universal desktop-wide enum.
7. Existing model profiles and chat history are migrated without destructive data changes.

## Non-Goals

This design does not include:

- a distributed or multi-machine task queue;
- automatic retry of agent turns after an application restart;
- guessing model capabilities from arbitrary model names;
- generating a reasoning summary with an additional model call;
- manufacturing raw reasoning when the provider does not return it;
- simultaneous turns within the same chat;
- a new AG-UI server, MCP gateway, CopilotKit runtime, or provider SDK.

## Architecture

```text
Vue conversation and sidebar
  - per-chat runtime state
  - reasoning panel
  - queue and run indicators
             |
Agent Client Core
  - threadId -> ThreadRuntimeState
  - independent event reduction per thread
             |
Model Task Scheduler
  - queue and running set per modelProfileId
  - configurable concurrency limit
  - cancellation and slot release
             |
Provider Adapter
  - capability declaration
  - request parameter mapping
  - normalized stream events
             |
OpenAI / Qwen / Ollama / vLLM / compatible endpoints
```

The worker remains the execution owner. Renderer state is a projection of worker events and must not be the authority for queue position, concurrency, or cancellation.

## Provider Capability Model

Each model profile has an explicit capability declaration:

```ts
type ReasoningInputMode = "unsupported" | "toggle" | "effort" | "custom";
type ReasoningOutputMode = "raw" | "summary";

type ModelCapabilities = {
  reasoning: {
    inputMode: ReasoningInputMode;
    effortOptions: string[];
    outputModes: ReasoningOutputMode[];
    defaultEffort?: string;
  };
  concurrency: {
    defaultLimit: number;
    configurable: boolean;
    maxLimit?: number;
  };
  streaming: boolean;
  usage: {
    tokens: boolean;
    reasoningTokens: boolean;
  };
};
```

Capability rules:

- `effortOptions` is provider data and may contain values such as `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. The core treats the values as opaque identifiers.
- The renderer shows only the controls declared for the selected model profile.
- A model using `toggle` shows only an on/off thinking control.
- A model using `effort` shows only its declared effort values.
- A model using `unsupported` shows no reasoning input control.
- `raw` and `summary` describe provider output capability, not input configuration.
- A successful connection test validates configured parameters. It does not silently broaden capabilities.
- Advanced users may override a profile template. An override is marked unverified until a capability test succeeds.

### Initial Provider Templates

The initial Qwen-compatible template declares:

- reasoning input mode: `toggle`;
- request mapping: `chat_template_kwargs.enable_thinking`;
- reasoning output: `raw` when `reasoning_content` or an explicitly configured equivalent is returned;
- native summary: unavailable unless explicitly configured;
- default concurrency: `1`.

The initial OpenAI template declares model-specific effort options and native reasoning-summary support only when the configured API and model support them. It does not promise raw reasoning.

Ollama, vLLM, and other OpenAI-compatible endpoints use explicit templates or user overrides. The application does not infer capabilities solely from a model-name substring.

## Reasoning and Answer Event Protocol

Reasoning and final answer data are different event streams:

```text
turn.queued
turn.started
reasoning.raw.delta
reasoning.summary.delta
answer.delta
usage.updated
turn.completed
turn.failed
turn.cancelled
```

Every event carries `threadId`, `turnId`, and `modelProfileId`. Queue events also carry the current queue position.

Event rules:

- `reasoning.raw.delta` contains only a provider-supplied displayable reasoning field.
- `reasoning.summary.delta` contains only a provider-supplied native reasoning summary.
- `answer.delta` contains only user-visible final answer text.
- The adapter must never append reasoning deltas to the answer buffer.
- If a provider returns neither reasoning output type, the app may show a generic phase indicator but must not create reasoning text.
- Provider-specific wire formats are normalized inside the adapter, not in Vue components.
- Duplicate or replayed chunks for the same event identity must not produce duplicate rendered content.

## Per-Chat Runtime State

Agent Client Core replaces the single global `busy` and `activeTurnId` fields with per-chat runtime state:

```ts
type TurnStatus =
  | "idle"
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

type ThreadRuntimeState = {
  threadId: string;
  turnId?: string;
  modelProfileId?: string;
  status: TurnStatus;
  queuePosition?: number;
  startedAt?: number;
  firstTokenAt?: number;
  completedAt?: number;
  tokensPerSecond?: number;
  error?: string;
};
```

The state is stored as a map keyed by `threadId`. Events update only their matching chat. An event from a background chat must not change the active chat, steal focus, overwrite its composer state, or stop its scroll behavior.

## Scheduler

The worker owns a scheduler keyed by `modelProfileId`. Each entry has:

- the effective concurrency limit;
- a FIFO queue;
- a set of running turns;
- an `AbortController` for every running turn.

Scheduling rules:

1. A submitted turn starts immediately when its model profile has a free slot.
2. Otherwise it is queued and emits `turn.queued` with a queue position.
3. Completion, failure, or cancellation releases the slot exactly once and starts the next eligible turn.
4. Different model profiles have independent limits and queues.
5. A chat cannot submit another turn while it already has a queued, running, or cancelling turn.
6. Cancelling a queued turn removes it without calling the provider and recalculates later queue positions.
7. Cancelling a running turn aborts its provider request and releases the slot after the request settles.
8. Changing a concurrency limit does not terminate running turns. It affects subsequent scheduling immediately.
9. A limit reduction below the current running count prevents new starts until the running count drops below the new limit.
10. A provider error affects only the corresponding turn. It must not clear another model's queue or runtime state.

The MVP scheduler is in-process. It does not require Redis or an external service. True simultaneous inference still depends on the capacity of the configured model endpoint; administrators should leave a single-slot local endpoint at concurrency `1`.

## Restart and Recovery

The app persists enough turn state to explain an interrupted run, but it does not automatically replay work:

- queued or running turns found during startup become `interrupted`;
- already received reasoning and answer text remains visible and is marked incomplete;
- no model request or tool operation is retried automatically;
- the user may explicitly resend the turn.

This behavior prevents duplicate tool calls and other repeated side effects.

## Persistence

Streaming fragments are aggregated in memory. SQLite stores logical items, not one row per token:

- raw reasoning content;
- reasoning summary content;
- final answer content;
- turn status and timestamps;
- usage and speed metrics;
- an incomplete flag when the stream ends abnormally.

Persistence may use throttled updates during a long-running stream, followed by a final upsert when the turn reaches a terminal state. A restart must not duplicate a persisted logical item when live state is reconciled with stored state.

Copying or exporting an answer excludes raw reasoning by default. Reasoning is exported only through an explicit reasoning-export action.

## User Interface

### Conversation Header

The conversation header shows only effective controls for the selected profile:

```text
[Model] [Thinking: On] [Status]
[Model] [Reasoning effort: High] [Status]
[Model] [Status]                       // no reasoning support
```

A generic speed selector is hidden unless the provider adapter maps it to a real request capability. Runtime tokens per second is a measured metric, not a model-supplied reasoning level.

### Reasoning Panel

- The panel is collapsed by default.
- While reasoning is streaming, its header shows an active indicator.
- Display preference supports `auto`, `raw`, and `summary`.
- `auto` prefers native summary, then raw reasoning, then a phase-only indicator.
- Selecting `summary` for a model without native summary displays `This model does not provide a reasoning summary` in the active UI language.
- Selecting `raw` for a model without raw reasoning displays the equivalent capability message.
- The final answer remains visually and semantically separate.

### Sidebar and Composer

- Sidebar chats show idle, queue position, running, completed, failed, cancelled, or interrupted state.
- Switching chats never cancels a turn.
- The composer is disabled only when the current chat has a queued, running, or cancelling turn.
- While the current chat is running, its send action becomes a stop action.
- A user may switch to another idle chat and submit a new turn.

### Settings

Settings keeps a Codex-like left navigation:

- General: language, theme, and default chat behavior.
- Model Services: profiles, connection, authentication, declared capabilities, and capability test.
- Runtime: default concurrency, per-profile overrides, queue behavior, timeout, and reasoning display preference.
- Data: chat history, export, and cleanup.

The selected profile's capability editor includes:

- reasoning input mode;
- effort options when applicable;
- default effort;
- raw reasoning support;
- native summary support;
- streaming support;
- token-usage support;
- maximum concurrent turns;
- validation state and last test result.

## Migration

Migration is non-destructive:

- Existing model profiles, API-key storage, and chat history are retained.
- The current Qwen profile gains the Qwen template, raw-reasoning capability, no native-summary capability, and concurrency limit `1`.
- Existing effort values remain stored but are effective only when the selected profile declares that value.
- Unsupported legacy settings are shown as unsupported rather than silently ignored.
- Existing globally stored run state is converted to per-chat runtime state. A stale busy state without a live turn becomes `interrupted` or `idle` according to persisted turn evidence.

## Error Handling

- Unsupported reasoning parameters fail with a visible configuration error; the client does not silently retry without them while continuing to show the setting as active.
- A capability test may recommend a corrected configuration but does not mutate the profile without user confirmation.
- Connection failure or timeout transitions only the current turn to `failed`, releases its slot, and advances the queue.
- Stream interruption preserves received content and marks the turn incomplete.
- Cancellation is idempotent. Multiple stop requests release at most one slot.
- Missing reasoning output does not fail an otherwise valid answer.
- Queue-position updates are best-effort UI information; scheduling correctness does not depend on the renderer receiving every position event.
- API keys and authorization headers never appear in events, diagnostics, or persisted content items.

## Testing

### Unit Tests

- capability normalization and profile migration;
- Qwen toggle mapping and raw reasoning extraction;
- model-specific effort mapping;
- rejection of unsupported effort values;
- separation of raw reasoning, summary, and answer buffers;
- per-chat event reduction without active-chat mutation;
- scheduler concurrency limits, FIFO ordering, limit changes, and slot release;
- queued and running cancellation idempotency;
- aggregation and logical-item persistence without token-row growth;
- interrupted-state recovery.

### Integration Tests

- two chats using one model profile with concurrency `1` produce one running and one queued turn;
- completion of the first turn automatically starts the second;
- concurrency `2` permits two chats to stream independently;
- switching chats preserves both streams and correct scroll behavior;
- stopping one turn does not stop another;
- provider failure advances the affected queue;
- a Qwen response displays raw reasoning and reports native summary as unavailable;
- a summary-capable provider renders native summary separately from the answer;
- duplicate stream chunks or persisted/live reconciliation do not duplicate messages.

### End-to-End Acceptance

The feature is accepted when:

1. A single-slot Qwen profile displays one running chat and one queued chat.
2. The queued chat starts automatically after the slot is released.
3. A profile configured with concurrency `2` can run two independent chats simultaneously.
4. The user can navigate and submit work in another idle chat while a background turn runs.
5. Raw Qwen reasoning is available in a collapsible panel and never enters the copied final answer.
6. Summary mode clearly reports unavailable when the provider supplies no native summary.
7. Each model displays only its declared reasoning controls and effort values.
8. Stopping, failure, and timeout release scheduler capacity exactly once.
9. Restarted unfinished turns are marked interrupted and are not replayed.
10. SQLite stores aggregated logical content without per-token row growth.
11. Duration, time to first token, token usage, and tokens per second remain scoped to the correct turn.
12. Existing saved profiles and conversations remain usable after migration.

Verification commands remain:

- `pnpm typecheck`
- `pnpm test`
- `pnpm test:e2e`
- `pnpm make`
