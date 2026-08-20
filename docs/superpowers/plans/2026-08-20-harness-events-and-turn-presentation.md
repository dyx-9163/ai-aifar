# Harness Events and Turn Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize provider-native and text-fallback tool calls into one harness boundary, prevent tool markup from becoming an answer, persist operations, and render every turn as reasoning, operations, and final answer.

**Architecture:** Keep the existing native OpenAI-compatible `tool_calls` path. Extract text protocol parsing behind provider adapters that produce one normalized call shape, keep lifecycle output in typed harness events, persist tool events by call id and sequence, then derive a turn presentation model for the renderer.

**Tech Stack:** TypeScript, Electron, Vue 3, node:sqlite, Vitest, Playwright

**Spec:** `docs/superpowers/specs/2026-08-20-harness-events-and-turn-presentation-design.md`

## Global Constraints

- Preserve existing native `tool_calls` behavior and local-model compatibility.
- Never render recognized, malformed, or truncated tool protocol as final assistant text.
- Keep reasoning, operations, and final answer as distinct typed data.
- Persist completed operation history without persisting the synthetic model-call row.
- Use test-first RED/GREEN cycles and preserve unrelated user/Qoder changes.

---

### Task 1: Provider Text Tool Adapter

**Files:**
- Create: `src/agent/providerAdapters/textToolCallAdapter.ts`
- Modify: `src/agent/agentLoop.ts`
- Test: `tests/agentLoop.test.ts`

**Interfaces:**
- Produces: `NormalizedToolCall`, `parseTextToolCalls(text)`, `stripTextToolProtocol(text)`, `hasUnparsedTextToolProtocol(text)`, `looksLikeTruncatedTextToolCall(text)`.
- Consumes: known tool names supplied by the agent loop so ordinary code examples never execute.

- [ ] Add a failing test that constructs the screenshot dialect with `tool_call` and `tool_input`, expects `search_code` plus its three typed inputs, and expects stripping to leave no protocol text.
- [ ] Run `pnpm exec vitest run tests/agentLoop.test.ts -t "tool_call tool_input"` and confirm the existing parser returns no call or leaks markup.
- [ ] Extract fenced JSON, invoke/parameter XML, DSML normalization, stripping and truncation checks behind `textToolCallAdapter.ts`; add the singular XML adapter and re-export legacy parser helpers from `agentLoop.ts` for compatibility.
- [ ] Add a loop-level test that feeds the exact dialect, observes `tool.started`, `tool.output`, then a clean final `answer.delta`, and verifies no protocol markup appears in the answer.
- [ ] Run focused agent-loop tests and keep them green.

### Task 2: Durable Harness Operations

**Files:**
- Modify: `src/shared/domain.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `src/agent/agentLoop.ts`
- Modify: `src/agent/database.ts`
- Modify: `src/agent/worker.ts`
- Test: `tests/database.test.ts`
- Test: `tests/worker.test.ts`
- Test: `tests/protocol.test.ts`

**Interfaces:**
- Produces: tool output status, `ToolItem.sequence`, and database upsert behavior keyed by `item-${turnId}-tool-${toolId}`.
- Consumes: existing sequenced `tool.started` and `tool.output` harness events.

- [ ] Add failing worker/database tests proving started/output events create one durable tool item, preserve title, update status/output, exclude the synthetic model invocation, and retain two calls in event-sequence order.
- [ ] Run the focused tests and confirm no tool items are currently persisted.
- [ ] Extend `tool.output` with a typed completion status derived from `AgentToolResult.status`.
- [ ] Persist `tool.started` and `tool.output` through a narrow tool-item upsert path; retain the start timestamp/title and update only status/output/sequence.
- [ ] Run protocol, database and worker tests until green.

### Task 3: Turn Presentation Model and Operation Panel

**Files:**
- Modify: `src/renderer/timeline.ts`
- Create: `src/renderer/components/OperationPanel.vue`
- Modify: `src/renderer/components/Conversation.vue`
- Modify: `src/renderer/i18n/messages.ts`
- Modify: `src/renderer/styles/app.css`
- Test: `tests/renderer-state.test.ts`

**Interfaces:**
- Produces: `TurnTimelineGroup` containing user messages, reasoning entries, operations, final answers, metrics and progress in a stable turn order.
- Consumes: persisted `ToolItem`, live tool events not yet reflected in the snapshot, `ReasoningItem`, assistant `MessageItem`, `TurnRecord`.

- [ ] Add failing renderer tests for one turn containing user text, raw reasoning, two ordered tools and a final answer; assert the three sections remain separate.
- [ ] Add failing tests for operation presentation metadata: running means open with active label; terminal means closed with “executed N operations”.
- [ ] Change timeline construction so persisted tools/changes remain typed operations and live events merge by turn/tool id instead of disappearing at terminal state.
- [ ] Add `OperationPanel.vue` using accessible `details/summary`, running-state expansion, terminal collapse, status rows and bilingual labels.
- [ ] Render each turn in `Conversation.vue` as user message, reasoning panel, operation panel, final answer, metrics/progress while keeping final answers always visible.
- [ ] Run focused renderer tests until green.

### Task 4: Verification

**Files:**
- Modify only files required by failures introduced by Tasks 1-3.

**Interfaces:**
- Consumes: the completed adapter, persistence and renderer behavior.
- Produces: reproducible verification evidence.

- [ ] Run focused tests for agent loop, protocol, database, worker and renderer state.
- [ ] Run `pnpm test` and record test-file/test counts.
- [ ] Run `pnpm typecheck` and record the successful exit.
- [ ] Run `pnpm package`; if environment download or Electron launch fails, distinguish it from code/test failures.
- [ ] Run `git -c safe.directory=D:/workspace/AI/2026-08-14/ai-aifar diff --check` and review the scoped diff before reporting completion.

## Self-Review

- Spec coverage: provider fallback, protocol isolation, durable ordered operations, three UI sections, default collapse behavior and verification each map to a task.
- Placeholder scan: no deferred implementation placeholders remain.
- Type consistency: `NormalizedToolCall`, durable `ToolItem`, and `TurnTimelineGroup` have one owner and explicit consumers.
