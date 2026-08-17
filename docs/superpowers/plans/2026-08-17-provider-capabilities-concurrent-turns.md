# Provider Capabilities and Concurrent Turns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider-declared reasoning capabilities, separate raw/summary reasoning streams, and per-model queued concurrency so independent chats can run without a global UI lock.

**Architecture:** Extend the shared domain and protocol first, normalize legacy model profiles at the database boundary, and keep scheduling authoritative in the worker. Provider adapters emit normalized reasoning and answer events; Agent Client Core reduces those events into per-chat runtime state, and Vue renders only controls the active model actually supports.

**Tech Stack:** TypeScript 5.9, Vue 3.5, Electron 43 Utility Process IPC, Node `DatabaseSync` SQLite, Vitest 4, Playwright 1.62, OpenAI-compatible SSE.

## Global Constraints

- Keep the existing Vue 3, Agent Client Core, worker, Electron IPC, and SQLite architecture.
- Do not add Redis, PostgreSQL, an external task service, AG-UI server packages, CopilotKit, LangChain, MCP packages, or provider SDKs.
- A single chat has at most one queued, running, or cancelling turn; different chats may run simultaneously.
- Concurrency is enforced per `modelProfileId` with a FIFO queue.
- Never generate or fabricate reasoning content that the provider did not return.
- Never generate a reasoning summary with a second model call or heuristic truncation.
- Never mix raw reasoning or reasoning summaries into the final answer buffer.
- Do not silently remove rejected reasoning parameters and pretend the selected setting remained effective.
- Stream fragments are aggregated into logical SQLite items; do not insert one database row per token.
- Queued or running turns found after restart become `interrupted` and are not replayed automatically.
- Existing profiles, API keys, chat groups, chats, and message history must remain usable after migration.
- Do not include API keys or authorization headers in renderer snapshots, events, logs, or persisted content.
- Use test-driven development for every task and keep unrelated dirty-worktree files out of commits.

## File Structure

Files created by this plan:

- `src/agent/modelCapabilities.ts`: capability presets, legacy normalization, and runtime validation.
- `src/agent/turnScheduler.ts`: in-process per-model FIFO scheduler and cancellation.
- `src/renderer/modelControls.ts`: pure capability-to-control and reasoning-content selection helpers.
- `src/renderer/components/ReasoningPanel.vue`: raw/summary reasoning display independent of answer rendering.
- `tests/modelCapabilities.test.ts`: capability normalization and request-option validation.
- `tests/turnScheduler.test.ts`: scheduler ordering, capacity, cancellation, and limit changes.
- `tests/e2e/fakeModelServer.ts`: deterministic delayed SSE server used by concurrency E2E tests.

Existing files modified by this plan:

- `src/shared/domain.ts`: capability, reasoning item, turn record, and runtime-state types.
- `src/shared/protocol.ts`: queued/reasoning/cancelled events and request validation.
- `src/agent/database.ts`: legacy migration, turn state persistence, aggregated reasoning items, and restart recovery.
- `src/agent/modelProvider.ts`: capability-driven request mapping and normalized reasoning/answer callbacks.
- `src/agent/worker.ts`: scheduler integration, sequenced event emission, status persistence, and cancellation.
- `src/agentClient/core.ts`: per-chat runtime map and independent live content buffers.
- `src/renderer/composables/useApp.ts`: active-chat runtime computed state and thread-scoped start/cancel behavior.
- `src/renderer/timeline.ts`: separate reasoning entries and terminal-state handling.
- `src/renderer/components/Conversation.vue`: capability-driven header controls and reasoning panel.
- `src/renderer/components/Composer.vue`: disable/stop only for the active chat.
- `src/renderer/components/Sidebar.vue`: queue/running/completed/failed/interrupted indicators.
- `src/renderer/components/SettingsView.vue`: capability editor, display preference, and concurrency limit.
- `src/renderer/App.vue`: pass per-chat runtime state and handlers to child components.
- `src/renderer/i18n/messages.ts`: Chinese and English copy for capabilities, queueing, and reasoning availability.
- `src/renderer/styles/app.css`: reasoning panel, capability editor, queue badges, and responsive header controls.
- `tests/protocol.test.ts`, `tests/database.test.ts`, `tests/modelProvider.test.ts`, `tests/agentClientCore.test.ts`, `tests/renderer-state.test.ts`: regression and feature coverage.
- `tests/e2e/app.spec.ts`, `tests/e2e/live-model.spec.ts`: multi-chat queueing and live-Qwen reasoning acceptance.
- `package.json`: include the two new Vitest files in `pnpm test`.

---

### Task 1: Shared Capability, Reasoning, and Turn Contracts

**Files:**

- Modify: `src/shared/domain.ts:1-146`
- Modify: `src/shared/protocol.ts:1-178`
- Modify: `tests/protocol.test.ts`

**Interfaces:**

- Produces: `ReasoningInputMode`, `ReasoningOutputMode`, `ReasoningDisplayMode`, `TurnStatus`, `ReasoningItem`, `TurnRecord`, `ThreadRuntimeState`, and the nested `ModelCapabilities` contract.
- Produces events: `turn.queued`, `answer.delta`, `reasoning.raw.delta`, `reasoning.summary.delta`, and `turn.cancelled`.
- Consumed by: every later task.

- [ ] **Step 1: Write failing protocol tests for capability-shaped profiles and new events**

Add explicit tests to `tests/protocol.test.ts`:

```ts
it('accepts provider-declared capability options', () => {
  expect(isDesktopRequest({
    type: 'modelProfile.save',
    profile: {
      name: 'Local Qwen',
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'Qwen3.5-9B',
      capabilities: {
        reasoning: {
          inputMode: 'toggle',
          effortOptions: [],
          outputModes: ['raw'],
        },
        concurrency: { defaultLimit: 1, configurable: true, maxLimit: 4 },
        streaming: true,
        usage: { tokens: true, reasoningTokens: true },
      },
      reasoning: { mode: 'enabled', protocol: 'qwen', display: 'auto' },
    },
  })).toBe(true);
});

it.each([
  { type: 'turn.queued', threadId: 't1', turnId: 'r1', modelProfileId: 'm1', sequence: 1, queuePosition: 2 },
  { type: 'answer.delta', threadId: 't1', turnId: 'r1', modelProfileId: 'm1', sequence: 2, text: '答案' },
  { type: 'reasoning.raw.delta', threadId: 't1', turnId: 'r1', modelProfileId: 'm1', sequence: 3, text: '分析' },
  { type: 'reasoning.summary.delta', threadId: 't1', turnId: 'r1', modelProfileId: 'm1', sequence: 4, text: '摘要' },
  { type: 'turn.cancelled', threadId: 't1', turnId: 'r1', modelProfileId: 'm1', sequence: 5 },
])('accepts $type', (event) => {
  expect(isAgentEvent(event)).toBe(true);
});
```

- [ ] **Step 2: Run the protocol tests and verify they fail on the old flat contract**

Run: `pnpm vitest run tests/protocol.test.ts`

Expected: FAIL because the new capability shape and event types are not accepted.

- [ ] **Step 3: Replace the hardcoded effort union and flat reasoning capability**

Implement these shared types in `src/shared/domain.ts`:

```ts
export type ReasoningInputMode = 'unsupported' | 'toggle' | 'effort' | 'custom';
export type ReasoningOutputMode = 'raw' | 'summary';
export type ReasoningDisplayMode = 'auto' | 'raw' | 'summary';
export type TurnStatus =
  | 'idle' | 'queued' | 'running' | 'cancelling'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface ModelCapabilities {
  text: boolean;
  vision: boolean;
  longContext: boolean;
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
  usage: { tokens: boolean; reasoningTokens: boolean };
}

export interface ModelReasoningSettings {
  mode: ReasoningMode;
  protocol: ReasoningProtocol;
  effort?: string;
  display: ReasoningDisplayMode;
}

export interface ModelCapabilitiesInput {
  text?: boolean;
  vision?: boolean;
  longContext?: boolean;
  reasoning?: Partial<ModelCapabilities['reasoning']>;
  concurrency?: Partial<ModelCapabilities['concurrency']>;
  streaming?: boolean;
  usage?: Partial<ModelCapabilities['usage']>;
}

export interface ReasoningItem extends BaseItem {
  kind: 'reasoning';
  mode: ReasoningOutputMode;
  text: string;
  incomplete: boolean;
}

// Extend the existing MessageItem with this optional field.
// Existing rows without it are complete unless their TurnRecord is unfinished.
export interface MessageItem extends BaseItem {
  kind: 'message';
  role: 'user' | 'assistant' | 'system';
  text: string;
  incomplete?: boolean;
}

export interface TurnRecord {
  id: string;
  threadId: string;
  modelProfileId?: string;
  status: Exclude<TurnStatus, 'idle'>;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  incomplete: boolean;
}

export interface ThreadRuntimeState {
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
}
```

Update `ItemKind`, `Item`, `AppSnapshot`, `ModelProfileInput`, and `RuntimeSettingsInput` so reasoning items, persisted turns, `maxConcurrency`, and the global `reasoningDisplayMode` are typed. `ModelProfileInput.capabilities` uses `ModelCapabilitiesInput` so nested capability sections can be edited independently. Keep `responseSpeed` readable for migration but mark it deprecated in a comment; no supported adapter exposes it in this plan.

- [ ] **Step 4: Extend protocol validators without accepting empty or invalid capability values**

Add validators for non-empty unique effort strings, reasoning output values, positive concurrency limits, and the new events. All sequenced turn events must include a non-empty `modelProfileId`; use the reserved value `__demo__` for demo turns.

```ts
function isReasoningDisplayMode(value: unknown): value is ReasoningDisplayMode {
  return value === 'auto' || value === 'raw' || value === 'summary';
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1;
}
```

- [ ] **Step 5: Run the focused tests and typecheck**

Run: `pnpm vitest run tests/protocol.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: FAIL only in downstream files still using the old contract. Record the failures in the task notes; Task 2 begins the migration.

- [ ] **Step 6: Commit the shared contract**

```powershell
git add src/shared/domain.ts src/shared/protocol.ts tests/protocol.test.ts
git commit -m "feat: define provider capabilities and turn events"
```

### Task 2: Capability Presets and Legacy Profile Normalization

**Files:**

- Create: `src/agent/modelCapabilities.ts`
- Create: `tests/modelCapabilities.test.ts`
- Modify: `src/agent/database.ts:78-91,332-395,737-809`
- Modify: `src/agent/worker.ts:212-238`
- Modify: `package.json:7-14`

**Interfaces:**

- Consumes: `ModelCapabilities`, `ModelReasoningSettings`, `ModelProfileInput` from Task 1.
- Produces: `normalizeModelCapabilities(input, reasoningProtocol)`, `normalizeReasoningSettings(input, capabilities)`, `validateReasoningSelection(profile)`, `qwenCapabilities()`, and `openAiCapabilities(effortOptions)`.
- Used by: database mapping, unsaved-profile connection tests, and model request construction.

- [ ] **Step 1: Write failing normalization tests**

Create `tests/modelCapabilities.test.ts` with these cases:

```ts
describe('model capabilities', () => {
  it('migrates an explicit legacy qwen profile without guessing from its name', () => {
    const capabilities = normalizeModelCapabilities(
      { reasoning: true, streamingUsage: true } as never,
      'qwen',
    );
    expect(capabilities.reasoning).toEqual({
      inputMode: 'toggle', effortOptions: [], outputModes: ['raw'],
    });
    expect(capabilities.concurrency.defaultLimit).toBe(1);
  });

  it('preserves arbitrary declared effort values', () => {
    const capabilities = openAiCapabilities(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(normalizeReasoningSettings(
      { mode: 'enabled', protocol: 'openai', effort: 'max', display: 'summary' },
      capabilities,
    ).effort).toBe('max');
  });

  it('rejects an effort that the profile does not declare', () => {
    const profile = profileFixture({ effortOptions: ['low', 'medium', 'high'], effort: 'max' });
    expect(() => validateReasoningSelection(profile)).toThrow('does not support reasoning effort "max"');
  });
});
```

Define the fixture in the same test file so the validation test is self-contained:

```ts
function profileFixture(input: { effortOptions: string[]; effort: string }): RuntimeModelProfile {
  const capabilities = openAiCapabilities(input.effortOptions);
  return {
    id: 'model-1',
    name: 'Fixture model',
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'fixture-model',
    apiKeyConfigured: false,
    capabilities,
    reasoning: { mode: 'enabled', protocol: 'openai', effort: input.effort, display: 'summary' },
    maxConcurrency: 1,
    responseSpeed: 'standard',
    isDefault: true,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  };
}
```

- [ ] **Step 2: Run the new test and verify failure**

Run: `pnpm vitest run tests/modelCapabilities.test.ts`

Expected: FAIL because `src/agent/modelCapabilities.ts` does not exist.

- [ ] **Step 3: Implement explicit presets and legacy normalization**

Implement small pure functions. The legacy migration may use the saved `reasoning.protocol`; it must not inspect `profile.model` or `profile.name`.

```ts
export function qwenCapabilities(): ModelCapabilities {
  return {
    text: true,
    vision: false,
    longContext: false,
    reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] },
    concurrency: { defaultLimit: 1, configurable: true, maxLimit: 32 },
    streaming: true,
    usage: { tokens: true, reasoningTokens: true },
  };
}

export function openAiCapabilities(effortOptions: string[] = []): ModelCapabilities {
  return {
    text: true,
    vision: false,
    longContext: false,
    reasoning: {
      inputMode: effortOptions.length ? 'effort' : 'unsupported',
      effortOptions: [...new Set(effortOptions)],
      outputModes: effortOptions.length ? ['summary'] : [],
      defaultEffort: effortOptions.includes('medium') ? 'medium' : effortOptions[0],
    },
    concurrency: { defaultLimit: 1, configurable: true, maxLimit: 32 },
    streaming: true,
    usage: { tokens: true, reasoningTokens: true },
  };
}
```

For unknown old profiles, preserve text/vision/long-context flags, declare reasoning unsupported, and use concurrency `1`. Normalize `maxConcurrency` to `[1, capabilities.concurrency.maxLimit ?? 32]`.

- [ ] **Step 4: Route database and unsaved-profile normalization through the new module**

Remove the duplicate `normalizeCapabilities` and fixed effort logic from `database.ts`. Update `runtimeProfileFromInput()` in `worker.ts` to call the same normalization functions used by persisted profiles, so connection testing and saved execution cannot disagree.

- [ ] **Step 5: Include the new test in the standard test script and verify**

Update `package.json` so `pnpm test` includes `tests/modelCapabilities.test.ts`.

Run: `pnpm vitest run tests/modelCapabilities.test.ts tests/database.test.ts`

Expected: PASS after updating old database fixtures to the nested capability shape.

Run: `pnpm typecheck`

Expected: remaining failures are limited to provider, client state, and Vue files covered by later tasks.

- [ ] **Step 6: Commit capability normalization**

```powershell
git add src/agent/modelCapabilities.ts src/agent/database.ts src/agent/worker.ts tests/modelCapabilities.test.ts tests/database.test.ts package.json
git commit -m "feat: normalize model capability profiles"
```

### Task 3: Persisted Turn State and Aggregated Reasoning Items

**Files:**

- Modify: `src/agent/database.ts:20-38,40-91,99-160,258-305,427-686`
- Modify: `tests/database.test.ts`

**Interfaces:**

- Consumes: `ReasoningItem`, `TurnRecord`, and `TurnStatus` from Task 1.
- Produces database methods:
  - `createTurn(turn: TurnRecord): void`
  - `updateTurn(turnId: string, patch: Partial<Pick<TurnRecord, 'status' | 'startedAt' | 'completedAt' | 'error' | 'incomplete'>>): void`
  - `completeTurn(turnId: string, completedAt: string): void`
  - `interruptUnfinishedTurns(): void`
- Used by: worker scheduling and restart recovery.

- [ ] **Step 1: Write failing database tests for reasoning aggregation and restart recovery**

Add tests that use a fixed reasoning item ID per turn and mode:

```ts
it('merges reasoning fragments into one logical item', () => {
  const db = openDatabase(createDbPath());
  const thread = db.createThread('Reasoning');
  db.createTurn(turnRecord('turn-1', thread.id, 'model-1', 'running'));
  db.appendItem(reasoningItem('turn-1', thread.id, 'raw', '第一段'));
  db.appendItem(reasoningItem('turn-1', thread.id, 'raw', '第二段'));

  const reasoning = db.getSnapshot().items[thread.id].filter((item) => item.kind === 'reasoning');
  expect(reasoning).toHaveLength(1);
  expect(reasoning[0]).toMatchObject({ mode: 'raw', text: '第一段第二段', incomplete: true });
  db.close();
});

it('marks unfinished turns interrupted on reopen without replaying them', () => {
  const path = createDbPath();
  const first = openDatabase(path);
  const thread = first.createThread('Interrupted');
  first.createTurn(turnRecord('turn-1', thread.id, 'model-1', 'queued'));
  first.close();

  const second = openDatabase(path);
  expect(second.getSnapshot().turns).toContainEqual(expect.objectContaining({
    id: 'turn-1', status: 'interrupted', incomplete: true,
  }));
  second.close();
});
```

Add deterministic helpers in `tests/database.test.ts`:

```ts
function turnRecord(id: string, threadId: string, modelProfileId: string, status: TurnRecord['status']): TurnRecord {
  return {
    id, threadId, modelProfileId, status,
    createdAt: '2026-08-17T00:00:00.000Z',
    incomplete: true,
  };
}

function reasoningItem(
  turnId: string,
  threadId: string,
  mode: ReasoningOutputMode,
  text: string,
): ReasoningItem {
  return {
    id: `item-${turnId}-reasoning-${mode}`,
    threadId, turnId, kind: 'reasoning', mode, text,
    incomplete: true,
    createdAt: '2026-08-17T00:00:01.000Z',
  };
}
```

- [ ] **Step 2: Run the focused database tests and verify failure**

Run: `pnpm vitest run tests/database.test.ts`

Expected: FAIL because turn CRUD, reasoning items, and restart interruption are not implemented.

- [ ] **Step 3: Extend the `turns` schema with migration version 3**

Use `ensureColumn()` for existing databases:

```sql
ALTER TABLE turns ADD COLUMN model_profile_id TEXT;
ALTER TABLE turns ADD COLUMN started_at TEXT;
ALTER TABLE turns ADD COLUMN completed_at TEXT;
ALTER TABLE turns ADD COLUMN error TEXT;
ALTER TABLE turns ADD COLUMN incomplete INTEGER NOT NULL DEFAULT 1;
```

After schema creation, call `interruptUnfinishedTurns()` once during database startup. It updates only `queued`, `running`, and `cancelling` rows to `interrupted`; it does not touch completed, failed, or cancelled turns.

- [ ] **Step 4: Implement turn mapping and logical-item merging**

Return persisted turns in `AppSnapshot.turns`. Extend `insertOrMergeItem()` so these keys merge independently:

```ts
function logicalStreamKey(item: Item): string | undefined {
  if (item.kind === 'message' && item.role === 'assistant' && item.turnId) return `answer:${item.turnId}`;
  if (item.kind === 'reasoning' && item.turnId) return `reasoning:${item.mode}:${item.turnId}`;
  return undefined;
}
```

When merging, append text and preserve the original item ID and timestamp. `completeTurn()` updates the turn to `completed`, sets `completedAt`, and updates reasoning and assistant payloads for that turn to `incomplete: false` in one transaction.

- [ ] **Step 5: Verify persistence and bounded row growth**

Add an assertion that appending 100 reasoning fragments and 100 answer fragments creates exactly one raw reasoning row and one assistant-answer row for the turn.

Run: `pnpm vitest run tests/database.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit persistence and recovery**

```powershell
git add src/agent/database.ts tests/database.test.ts
git commit -m "feat: persist turn runtime and reasoning streams"
```

### Task 4: Capability-Driven Provider Streaming

**Files:**

- Modify: `src/agent/modelProvider.ts:1-271`
- Modify: `tests/modelProvider.test.ts`

**Interfaces:**

- Consumes: normalized `RuntimeModelProfile` and `validateReasoningSelection()` from Task 2.
- Produces:

```ts
export interface ModelStreamHandlers {
  onAnswerDelta(text: string): Promise<void> | void;
  onRawReasoningDelta(text: string): Promise<void> | void;
  onReasoningSummaryDelta(text: string): Promise<void> | void;
  onPhase(phase: ModelRunPhase): Promise<void> | void;
}

export function streamChatCompletion(
  profile: RuntimeModelProfile,
  messages: ChatMessage[],
  handlers: ModelStreamHandlers,
  signal: AbortSignal,
): Promise<ModelRunMetrics>;
```

- Used by: worker turn execution.

- [ ] **Step 1: Write failing stream-separation and request-mapping tests**

Add a fake SSE response with three different deltas:

```ts
const chunks = [
  'data: {"choices":[{"delta":{"reasoning_content":"检查输入"}}]}\n\n',
  'data: {"choices":[{"delta":{"reasoning_summary":"已检查输入"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"最终答案"}}]}\n\n',
  'data: [DONE]\n\n',
];

expect(raw).toEqual(['检查输入']);
expect(summary).toEqual(['已检查输入']);
expect(answer).toEqual(['最终答案']);
```

Add request-body assertions:

- Qwen `toggle + enabled` sends `chat_template_kwargs.enable_thinking = true`.
- Qwen `toggle + disabled` sends `false`.
- OpenAI `effort` sends the selected declared string, including `max` when declared.
- An undeclared effort throws before `fetch`.
- HTTP 400 caused by a reasoning parameter does not trigger a retry without reasoning.
- A rejected `stream_options.include_usage` may retry once without only `stream_options`; the reasoning parameter remains identical.

- [ ] **Step 2: Run provider tests and verify failure**

Run: `pnpm vitest run tests/modelProvider.test.ts`

Expected: FAIL because raw reasoning is currently discarded, summary is not parsed, and the compatibility retry removes reasoning.

- [ ] **Step 3: Replace positional callbacks with `ModelStreamHandlers`**

Parse each SSE frame once and route fields independently:

```ts
type ParsedStreamChunk = {
  answerDelta?: string;
  rawReasoningDelta?: string;
  reasoningSummaryDelta?: string;
  finishReason?: string;
  usage?: StreamedMetrics;
};
```

Recognize `choices[0].delta.content`, `reasoning_content` or `reasoning`, and `reasoning_summary`. Do not concatenate any two fields in the provider layer.

- [ ] **Step 4: Make request mapping capability-driven and fail visibly**

Call `validateReasoningSelection(profile)` before `fetch`. Map only the selected protocol and declared input mode. Refactor compatibility retry so it may remove `stream_options` only; never remove `chat_template_kwargs` or `reasoning_effort` after a rejection.

Include the HTTP status and a redacted response-body excerpt in the thrown error. Never include headers or the API key.

- [ ] **Step 5: Run provider tests and typecheck**

Run: `pnpm vitest run tests/modelProvider.test.ts tests/modelCapabilities.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: worker callback-signature errors remain until Task 6; no errors originate in `modelProvider.ts`.

- [ ] **Step 6: Commit provider streaming**

```powershell
git add src/agent/modelProvider.ts tests/modelProvider.test.ts
git commit -m "feat: stream reasoning separately from answers"
```

### Task 5: Per-Model FIFO Turn Scheduler

**Files:**

- Create: `src/agent/turnScheduler.ts`
- Create: `tests/turnScheduler.test.ts`
- Modify: `package.json:7-14`

**Interfaces:**

- Produces:

```ts
export interface ScheduledTurn {
  turnId: string;
  threadId: string;
  modelProfileId: string;
  title: string;
  run(signal: AbortSignal): Promise<void>;
}

export interface SchedulerCallbacks {
  onQueued(turn: ScheduledTurn, position: number): Promise<void> | void;
  onStarted(turn: ScheduledTurn): Promise<void> | void;
  onCancelled(turn: ScheduledTurn, wasRunning: boolean): Promise<void> | void;
  onQueuePositions(modelProfileId: string, positions: ReadonlyMap<string, number>): Promise<void> | void;
}

export class ModelTurnScheduler {
  constructor(limitFor: (modelProfileId: string) => number, callbacks: SchedulerCallbacks);
  enqueue(turn: ScheduledTurn): void;
  cancel(turnId: string): boolean;
  updateLimit(modelProfileId: string): void;
  hasActiveThread(threadId: string): boolean;
}
```

- Consumed by: worker request handling in Task 6.

- [ ] **Step 1: Write failing scheduler tests with deferred promises**

Cover:

```ts
it('runs one turn and queues the second at limit one', async () => {
  const first = deferred<void>();
  scheduler.enqueue(task('turn-1', 'thread-1', 'model-1', () => first.promise));
  scheduler.enqueue(task('turn-2', 'thread-2', 'model-1', async () => undefined));
  await flushMicrotasks();
  expect(started).toEqual(['turn-1']);
  expect(queued).toContainEqual(['turn-2', 1]);
  first.resolve();
  await flushMicrotasks();
  expect(started).toEqual(['turn-1', 'turn-2']);
});
```

Define the scheduler test helpers in the same file:

```ts
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function task(
  turnId: string,
  threadId: string,
  modelProfileId: string,
  run: (signal: AbortSignal) => Promise<void>,
): ScheduledTurn {
  return { turnId, threadId, modelProfileId, title: turnId, run };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
```

Also test independent model queues, cancellation before start, abort while running, rejection slot release, limit increase starting queued work, limit reduction not aborting work, duplicate cancellation idempotency, and rejection of a second active turn for the same thread.

- [ ] **Step 2: Run the scheduler test and verify failure**

Run: `pnpm vitest run tests/turnScheduler.test.ts`

Expected: FAIL because the scheduler file does not exist.

- [ ] **Step 3: Implement the scheduler with one slot-release path**

Maintain:

```ts
private readonly queues = new Map<string, ScheduledTurn[]>();
private readonly running = new Map<string, { turn: ScheduledTurn; controller: AbortController }>();
private readonly runningByModel = new Map<string, Set<string>>();
```

Use a single `settle(turn)` method in `finally` to delete running state, emit updated queue positions, and call `drain(modelProfileId)`. Clamp every effective limit to at least `1`. `cancel()` aborts a running controller or removes exactly one queued entry.

- [ ] **Step 4: Verify scheduler behavior and standard test inclusion**

Add `tests/turnScheduler.test.ts` to `pnpm test`.

Run: `pnpm vitest run tests/turnScheduler.test.ts`

Expected: PASS with deterministic ordering and no timer sleeps.

- [ ] **Step 5: Commit the scheduler**

```powershell
git add src/agent/turnScheduler.ts tests/turnScheduler.test.ts package.json
git commit -m "feat: add per-model turn scheduler"
```

### Task 6: Worker Scheduling, Persistence, and Cancellation Integration

**Files:**

- Modify: `src/agent/worker.ts:18-239`
- Modify: `src/agent/demoAgent.ts`
- Modify: `tests/demoAgent.test.ts`
- Modify: `tests/renderer-state.test.ts` only if its bridge fixture needs the new event envelope

**Interfaces:**

- Consumes: `ModelTurnScheduler`, database turn methods, `ModelStreamHandlers`, and new protocol events.
- Produces: authoritative queued/running/terminal events for each turn and immediate `{ turnId }` acknowledgement from `turn.start`.
- Used by: preload/main bridge unchanged at the request-method level.

- [ ] **Step 1: Add failing worker-level behavior tests through exported helpers**

Extract pure helpers from `worker.ts` rather than booting an Electron Utility Process in Vitest:

```ts
export function createTurnEventEmitter(
  threadId: string,
  turnId: string,
  modelProfileId: string,
  sink: (event: SequencedEvent) => Promise<void>,
): (payload: SequencedEventPayload) => Promise<void>;
```

Test that `turn.queued`, `turn.started`, reasoning, answer, and terminal events receive monotonically increasing sequence numbers for the same turn and do not collide across two concurrently running turns.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm vitest run tests/demoAgent.test.ts tests/renderer-state.test.ts`

Expected: FAIL for the missing model-profile envelope or extracted emitter assertions.

- [ ] **Step 3: Replace `activeTurns` and fire-and-forget execution with the scheduler**

On `turn.start`:

1. Resolve the model profile and reserved demo profile key.
2. Reject if `scheduler.hasActiveThread(threadId)`.
3. Create the `TurnRecord` as `queued` before acknowledgement.
4. Persist the user message once.
5. Create one sequenced emitter closure for the turn.
6. Enqueue a `ScheduledTurn` whose `run()` invokes model or demo execution.
7. Return `{ turnId }` immediately.

The scheduler callbacks must persist and emit states:

```ts
onQueued:  updateTurn(status: 'queued')  + turn.queued
onStarted: updateTurn(status: 'running', startedAt) + turn.started
onCancelled: updateTurn(status: 'cancelled', completedAt) + turn.cancelled
```

Terminal execution catches provider errors and writes completed or failed. An `AbortError` is rethrown to the scheduler without emitting a terminal event; the scheduler's `onCancelled` callback is the sole owner of the cancelled database state and `turn.cancelled` event. This keeps cancellation idempotent and prevents double slot release.

- [ ] **Step 4: Persist normalized provider streams**

Wire handlers explicitly:

```ts
const handlers: ModelStreamHandlers = {
  onAnswerDelta: (text) => next({ type: 'answer.delta', text }),
  onRawReasoningDelta: (text) => next({ type: 'reasoning.raw.delta', text }),
  onReasoningSummaryDelta: (text) => next({ type: 'reasoning.summary.delta', text }),
  onPhase: (phase) => next({ type: 'model.progress', phase }),
};
```

Update `persistAndPostEvent()` to append fixed logical item IDs:

- `item-${turnId}-assistant`
- `item-${turnId}-reasoning-raw`
- `item-${turnId}-reasoning-summary`

On completion call `completeTurn()` so answer/reasoning completion flags and terminal turn state change atomically. Failed, cancelled, and interrupted content stays incomplete.

- [ ] **Step 5: Verify cancellation and sequence behavior**

Run: `pnpm vitest run tests/demoAgent.test.ts tests/database.test.ts tests/modelProvider.test.ts tests/turnScheduler.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: remaining failures are limited to Agent Client Core and Vue rendering code.

- [ ] **Step 6: Commit worker integration**

```powershell
git add src/agent/worker.ts src/agent/demoAgent.ts tests/demoAgent.test.ts tests/renderer-state.test.ts
git commit -m "feat: schedule and persist independent turns"
```

### Task 7: Agent Client Core Per-Chat Runtime and Live Buffers

**Files:**

- Modify: `src/agentClient/core.ts:1-132`
- Modify: `src/renderer/composables/useApp.ts:1-260`
- Modify: `src/renderer/timeline.ts:1-149`
- Modify: `tests/agentClientCore.test.ts`
- Modify: `tests/renderer-state.test.ts`

**Interfaces:**

- Consumes: per-turn protocol events and snapshot turn records.
- Produces: `runtimeByThread: Record<string, ThreadRuntimeState>`, `activeRuntime`, `activeBusy`, `activeTurnId`, and separate live reasoning/answer items.
- Used by: all Vue components in Task 8.

- [ ] **Step 1: Replace global-busy tests with concurrent-chat reducer tests**

Add these assertions:

```ts
it('keeps background turn events scoped to their thread', () => {
  let state = emptyAgentClientState();
  state = { ...state, activeThreadId: 'thread-1' };
  state = reduceAgentEvent(state, queued('thread-2', 'turn-2', 1));
  state = reduceAgentEvent(state, started('thread-1', 'turn-1', 1));
  expect(state.activeThreadId).toBe('thread-1');
  expect(state.runtimeByThread['thread-1'].status).toBe('running');
  expect(state.runtimeByThread['thread-2']).toMatchObject({ status: 'queued', queuePosition: 1 });
});

it('stores raw reasoning, summary, and answer in separate live items', () => {
  let state = reduceAgentEvent(emptyAgentClientState(), rawDelta('thread-1', 'turn-1', 1, '分析'));
  state = reduceAgentEvent(state, summaryDelta('thread-1', 'turn-1', 2, '摘要'));
  state = reduceAgentEvent(state, answerDelta('thread-1', 'turn-1', 3, '答案'));
  expect(state.snapshot.items['thread-1']).toMatchObject([
    { kind: 'reasoning', mode: 'raw', text: '分析' },
    { kind: 'reasoning', mode: 'summary', text: '摘要' },
    { kind: 'message', role: 'assistant', text: '答案' },
  ]);
});
```

Use typed event builders local to `tests/agentClientCore.test.ts`:

```ts
const envelope = (threadId: string, turnId: string, sequence: number) => ({
  threadId, turnId, sequence, modelProfileId: 'model-1',
});
const queued = (threadId: string, turnId: string, queuePosition: number): AgentEvent => ({
  type: 'turn.queued', ...envelope(threadId, turnId, 1), queuePosition,
});
const started = (threadId: string, turnId: string, sequence: number): AgentEvent => ({
  type: 'turn.started', ...envelope(threadId, turnId, sequence), title: turnId,
});
const rawDelta = (threadId: string, turnId: string, sequence: number, text: string): AgentEvent => ({
  type: 'reasoning.raw.delta', ...envelope(threadId, turnId, sequence), text,
});
const summaryDelta = (threadId: string, turnId: string, sequence: number, text: string): AgentEvent => ({
  type: 'reasoning.summary.delta', ...envelope(threadId, turnId, sequence), text,
});
const answerDelta = (threadId: string, turnId: string, sequence: number, text: string): AgentEvent => ({
  type: 'answer.delta', ...envelope(threadId, turnId, sequence), text,
});
```

Also test duplicate sequence suppression, queued cancellation, failed-background isolation, snapshot recovery of interrupted turns, and completion clearing only the matching thread runtime.

- [ ] **Step 2: Run reducer tests and verify failure**

Run: `pnpm vitest run tests/agentClientCore.test.ts tests/renderer-state.test.ts`

Expected: FAIL because state still has one `busy` and one `activeTurnId`, and incoming events change `activeThreadId`.

- [ ] **Step 3: Implement thread-scoped reduction**

Remove `busy` and `activeTurnId` from `AgentClientState`. Add:

```ts
runtimeByThread: Record<string, ThreadRuntimeState>;
```

Never assign `activeThreadId` from a sequenced event. Build initial runtime state from `snapshot.turns`, selecting the newest non-terminal turn per thread. Append live content with stable IDs and reconcile persisted/live content by turn, kind, and reasoning mode.

- [ ] **Step 4: Make `useApp()` compute the active chat's runtime**

Add:

```ts
const activeRuntime = computed(() => {
  const id = state.value.activeThreadId;
  return id ? state.value.runtimeByThread[id] ?? { threadId: id, status: 'idle' as const } : undefined;
});
const activeBusy = computed(() => ['queued', 'running', 'cancelling'].includes(activeRuntime.value?.status ?? 'idle'));
```

`startTurn()` performs an optimistic thread-scoped queued transition while awaiting acknowledgement. `cancelTurn()` reads only `activeRuntime.value.turnId`, sets only that runtime to cancelling, and waits for `turn.cancelled` or `turn.failed`; it does not clear state optimistically.

- [ ] **Step 5: Extend timeline entries for reasoning without merging into messages**

Add a `reasoning` entry shape with `mode`, `text`, and `incomplete`. Exclude reasoning entries from message merge logic and answer-copy actions. Treat completed, failed, and cancelled as terminal for progress indicators.

- [ ] **Step 6: Run reducer tests and typecheck**

Run: `pnpm vitest run tests/agentClientCore.test.ts tests/renderer-state.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: only Vue prop/template errors remain for Task 8.

- [ ] **Step 7: Commit client state changes**

```powershell
git add src/agentClient/core.ts src/renderer/composables/useApp.ts src/renderer/timeline.ts tests/agentClientCore.test.ts tests/renderer-state.test.ts
git commit -m "feat: track runtime state per chat"
```

### Task 8: Capability-Driven Vue Controls and Reasoning Panel

**Files:**

- Create: `src/renderer/modelControls.ts`
- Create: `src/renderer/components/ReasoningPanel.vue`
- Modify: `src/renderer/components/Conversation.vue:1-260`
- Modify: `src/renderer/components/Composer.vue:1-65`
- Modify: `src/renderer/components/Sidebar.vue`
- Modify: `src/renderer/components/SettingsView.vue`
- Modify: `src/renderer/App.vue`
- Modify: `src/renderer/i18n/messages.ts`
- Modify: `src/renderer/styles/app.css`
- Modify: `tests/renderer-state.test.ts`

**Interfaces:**

- Consumes: `activeRuntime`, `activeBusy`, `ModelCapabilities`, `ReasoningDisplayMode`, reasoning timeline entries, and model-profile save/update actions.
- Produces:

```ts
export type ReasoningControl =
  | { kind: 'hidden' }
  | { kind: 'toggle' }
  | { kind: 'effort'; options: string[] };

export function reasoningControls(profile: ModelProfile): ReasoningControl;

export function selectReasoningContent(
  preference: ReasoningDisplayMode,
  items: ReasoningItem[],
): { availability: 'available' | 'unsupported' | 'empty'; mode?: ReasoningOutputMode; text: string };
```

- Produces capability-driven header controls, independent queue status, and collapsible raw/summary display.

- [ ] **Step 1: Add failing renderer behavior assertions**

Keep pure UI-selection logic in `src/renderer/modelControls.ts`:

```ts
expect(reasoningControls(qwenProfile)).toEqual({ kind: 'toggle' });
expect(reasoningControls(openAiProfile(['low', 'medium', 'high']))).toEqual({
  kind: 'effort', options: ['low', 'medium', 'high'],
});
expect(reasoningControls(nonReasoningProfile())).toEqual({ kind: 'hidden' });
expect(selectReasoningContent('summary', [rawItem])).toEqual({
  availability: 'unsupported', mode: 'summary', text: '',
});
```

Define these fixtures in `tests/renderer-state.test.ts`; do not use component mounting to test this pure selection logic:

```ts
function modelProfileFixture(capabilities: ModelCapabilities): ModelProfile {
  return {
    id: 'model-1', name: 'Fixture', provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080/v1', model: 'fixture',
    apiKeyConfigured: false, capabilities,
    reasoning: { mode: 'enabled', protocol: 'none', display: 'auto' },
    maxConcurrency: 1, responseSpeed: 'standard', isDefault: true,
    createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z',
  };
}

const qwenProfile = modelProfileFixture(qwenCapabilities());
const openAiProfile = (options: string[]) => modelProfileFixture(openAiCapabilities(options));
const nonReasoningProfile = () => modelProfileFixture(openAiCapabilities([]));
const rawItem: ReasoningItem = {
  id: 'raw-1', threadId: 'thread-1', turnId: 'turn-1', kind: 'reasoning',
  mode: 'raw', text: '分析', incomplete: false,
  createdAt: '2026-08-17T00:00:01.000Z',
};
```

Assert that no profile in the initial adapters exposes the deprecated speed selector.

- [ ] **Step 2: Run renderer tests and verify failure**

Run: `pnpm vitest run tests/renderer-state.test.ts`

Expected: FAIL because controls are hardcoded and no reasoning panel selection helper exists.

- [ ] **Step 3: Build `ReasoningPanel.vue`**

Props and behavior:

```ts
defineProps<{
  raw?: ReasoningItem;
  summary?: ReasoningItem;
  preference: ReasoningDisplayMode;
  running: boolean;
}>();
```

- Collapsed by default.
- `auto` selects native summary, then raw, then phase-only status.
- Explicit unavailable modes render localized capability copy.
- Streaming text uses plain escaped text or the existing safe markdown renderer; never use unsanitized HTML.
- Copy controls copy only the selected reasoning item, never the answer.

- [ ] **Step 4: Replace hardcoded header controls**

In `Conversation.vue`, remove `['low', 'medium', 'high', 'xhigh']`. Render:

- a toggle for `inputMode === 'toggle'`;
- a menu generated from `capabilities.reasoning.effortOptions` for `inputMode === 'effort'`;
- nothing for `unsupported`;
- a warning link to settings for unverified `custom`.

Hide the response-speed selector unless a future capability field explicitly declares real options; do not map it to temperature or output length.

- [ ] **Step 5: Scope composer and sidebar state to each chat**

Pass `activeBusy` and `activeRuntime` into `Composer.vue`. Show Stop only for `running` or `cancelling`; show Cancel for queued turns. Sidebar rows use `runtimeByThread[thread.id]` to render queue position, running animation, completed, failed, cancelled, or interrupted labels.

Add stable selectors for E2E without coupling tests to translated text:

```html
<article :data-testid="`thread-row-${thread.id}`">
  <span data-testid="thread-runtime-status">{{ localizedStatus }}</span>
</article>
```

- [ ] **Step 6: Add settings capability editor and localized copy**

Under Model Services, add reasoning input mode, effort option list, default effort, raw output, native summary, and maximum concurrency. Under Runtime, add reasoning display preference and explain FIFO queueing. Validate limits inline and preserve API-key redaction.

Add Chinese and English keys for:

- raw reasoning, reasoning summary, automatic;
- model does not provide raw reasoning;
- model does not provide a reasoning summary;
- queued position, running, cancelling, cancelled, interrupted;
- maximum concurrent turns and capability test status.

- [ ] **Step 7: Verify Vue behavior and layout**

Run: `pnpm vitest run tests/renderer-state.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS with no Vue template or TypeScript errors.

- [ ] **Step 8: Commit the Vue experience**

```powershell
git add src/renderer/modelControls.ts src/renderer/components/ReasoningPanel.vue src/renderer/components/Conversation.vue src/renderer/components/Composer.vue src/renderer/components/Sidebar.vue src/renderer/components/SettingsView.vue src/renderer/App.vue src/renderer/i18n/messages.ts src/renderer/styles/app.css tests/renderer-state.test.ts
git commit -m "feat: add reasoning and queued chat controls"
```

### Task 9: End-to-End Acceptance and Release Verification

**Files:**

- Create: `tests/e2e/fakeModelServer.ts`
- Modify: `tests/e2e/app.spec.ts`
- Modify: `tests/e2e/live-model.spec.ts`
- Modify: `README.md`

**Interfaces:**

- Consumes: the complete implementation from Tasks 1-8.
- Produces: reproducible acceptance coverage and user-facing operating notes.

- [ ] **Step 1: Add a deterministic queued-concurrency E2E scenario**

Use `tests/e2e/fakeModelServer.ts`, exporting this explicit controller:

```ts
export interface FakeModelServer {
  baseUrl: string;
  requestCount(): number;
  releaseNext(parts: Array<{ answer?: string; rawReasoning?: string; summary?: string }>): void;
  close(): Promise<void>;
}

export function startFakeModelServer(): Promise<FakeModelServer>;
```

The server holds `/v1/chat/completions` requests until `releaseNext()` is called, emits valid `data:` SSE frames, and closes every response with `data: [DONE]`. Configure concurrency `1`, submit chat A, switch to chat B, and submit chat B before A completes.

Assert:

```ts
await expect(chatA).toContainText(/Running|运行中/);
await expect(chatB).toContainText(/Queued 1|排队第 1 位/);
server.releaseNext([{ answer: 'first complete' }]);
await expect(chatB).toContainText(/Running|运行中/);
```

Then configure concurrency `2` and verify both chats show running before either response is released.

- [ ] **Step 2: Add live-Qwen reasoning acceptance when the endpoint is available**

Keep `tests/e2e/live-model.spec.ts` environment-gated. Send a prompt that elicits a short answer with thinking enabled. Assert:

- the final answer is non-empty;
- a returned `reasoning_content` appears only inside the reasoning panel;
- summary mode shows unavailable for the Qwen template;
- copied answer text excludes reasoning;
- duration is scoped to that turn, and tokens per second is scoped to that turn when server usage or timing data makes it available.

When the endpoint is unavailable, skip with a clear reason instead of passing a fake live-model assertion.

- [ ] **Step 3: Add restart-interruption acceptance**

Seed a queued or running turn in the packaged test database, start the app, and assert the sidebar displays interrupted. Verify no request reaches the fake model endpoint during startup.

- [ ] **Step 4: Document configuration and operational semantics**

Update `README.md` with:

- Qwen capability template and `enable_thinking` mapping;
- per-profile concurrency and FIFO queue behavior;
- the difference between reasoning effort and measured tokens per second;
- raw versus native-summary availability;
- restart behavior and explicit resend requirement.

Do not document a speed control for providers that do not support one.

- [ ] **Step 5: Run the complete automated verification**

Run: `pnpm test`

Expected: all unit and integration tests pass, including `modelCapabilities` and `turnScheduler`.

Run: `pnpm typecheck`

Expected: PASS.

Run: `pnpm test:e2e`

Expected: packaged deterministic Electron E2E passes.

Run the live model test only with the documented live-endpoint environment variables and a reachable endpoint.

- [ ] **Step 6: Run packaging verification**

Run: `pnpm make`

Expected: Electron Forge completes and produces the configured Windows artifact without TypeScript or bundling errors.

- [ ] **Step 7: Inspect the final database behavior**

After a streamed test turn, query the test SQLite database and verify one user item, one assistant item, at most one raw reasoning item, and at most one summary item for the turn. Verify no API key occurs in `items.payload`, turn errors, or emitted event fixtures.

- [ ] **Step 8: Commit acceptance coverage and documentation**

```powershell
git add tests/e2e/fakeModelServer.ts tests/e2e/app.spec.ts tests/e2e/live-model.spec.ts README.md
git commit -m "test: verify concurrent reasoning workflows"
```

## Final Review Checklist

- [ ] Every accepted design requirement maps to a task and an automated or explicit acceptance check.
- [ ] The selected model profile alone defines reasoning controls and concurrency.
- [ ] Qwen offers thinking on/off and raw reasoning, not fake low/medium/high levels.
- [ ] Native summary unavailability does not cause an extra model call.
- [ ] Background events never change the selected chat.
- [ ] A single chat cannot create ambiguous concurrent context.
- [ ] Queue cancellation and running cancellation release capacity exactly once.
- [ ] Restart recovery never replays a turn automatically.
- [ ] Reasoning, summary, and answer remain separate through provider parsing, events, memory, SQLite, UI, copy, and export.
- [ ] Existing profiles and chats migrate without data loss.
- [ ] Unrelated pre-existing working-tree changes are absent from every task commit.
