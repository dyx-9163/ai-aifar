# Time Context and Reasoning Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add trustworthy local-time context and a safe clock tool, simplify reasoning configuration, and make native reasoning-summary display observation-driven.

**Architecture:** A focused runtime-context module supplies deterministic clock metadata to both direct and workspace prompts and to a global read-only tool. Existing persisted reasoning fields remain the wire/storage representation, while the renderer maps them through one combined control. Provider-emitted summary events remain the sole authority for native-summary visibility.

**Tech Stack:** TypeScript, Node.js, Electron Utility Process, Vue 3, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-time-and-reasoning-controls-design.md`

## Global Constraints

- Do not modify context compression, context message limits, model-generated history summaries, slot discovery, or queue scheduling.
- Preserve all existing Qoder working-tree changes.
- Keep the provider transport fixed to `openai-compatible`.
- Never invoke a shell to answer date/time questions.
- Use test-first RED/GREEN cycles for every behavior change.

---

### Task 1: Trusted Runtime Clock and Tool Failure Semantics

**Files:**
- Create: `src/agent/runtimeContext.ts`
- Create: `src/agent/tools/getCurrentDatetime.ts`
- Modify: `src/agent/agentLoop.ts`
- Modify: `src/agent/worker.ts`
- Modify: `src/agent/tools/toolSchemas.ts`
- Modify: `src/agent/tools/toolRouter.ts`
- Modify: `src/agent/tools/runCommand.ts`
- Modify: `src/shared/toolProtocol.ts`
- Test: `tests/agentLoop.test.ts`
- Test: `tests/workspaceTools.test.ts`
- Test: `tests/writeTools.test.ts`
- Test: `tests/worker.test.ts`

**Interfaces:**
- Produces: `RuntimeContextSnapshot`, `runtimeContextSnapshot(now, timeZone, locale, platform)`, `runtimeContextPrompt(snapshot)`, and `get_current_datetime` returning the snapshot.
- Changes: a timed-out process throws a typed `command-timeout` tool error.

- [ ] Add failing clock-format, prompt, global-tool, direct-chat and timeout-status tests.
- [ ] Run focused tests and confirm failures identify missing runtime context/tool and timeout semantics.
- [ ] Implement the runtime-context module, inject it into both prompt paths, register the tool, and convert timeouts to errors.
- [ ] Run focused tests until green.

### Task 2: One Reasoning Control

**Files:**
- Modify: `src/renderer/modelProfileForm.ts`
- Modify: `src/renderer/components/SettingsView.vue`
- Modify: `src/renderer/i18n/messages.ts`
- Modify: `src/shared/reasoningConfiguration.ts`
- Test: `tests/renderer-state.test.ts`
- Test: `tests/e2e/app.spec.ts`

**Interfaces:**
- Produces: `ReasoningControlKind = 'unsupported' | 'toggle' | 'effort'` and form helpers that atomically map it to persisted `reasoning.protocol` plus `capabilities.reasoning.inputMode`.
- Preserves: existing `none/qwen/openai` storage and request mappings.

- [ ] Add failing form tests proving each combined control maps to a valid persisted configuration and existing profiles load without loss.
- [ ] Run focused tests and confirm the old independent selectors fail the new contract.
- [ ] Replace the protocol/input-mode UI with one reasoning-control selector and conditional effort controls.
- [ ] Run focused renderer tests until green.

### Task 3: Observation-Driven Native Reasoning Summary

**Files:**
- Modify: `src/renderer/modelProfileForm.ts`
- Modify: `src/renderer/components/SettingsView.vue`
- Modify: `src/renderer/components/Conversation.vue`
- Modify: `src/renderer/modelControls.ts`
- Test: `tests/renderer-state.test.ts`
- Test: `tests/modelProvider.test.ts`
- Test: `tests/e2e/app.spec.ts`

**Interfaces:**
- Consumes: actual persisted/live `ReasoningItem` values with mode `summary`.
- Produces: native-summary UI only when a provider-emitted summary item exists; no manual output capability checkbox.

- [ ] Add failing tests proving Settings has no raw/summary declaration controls and an emitted native summary remains separately rendered.
- [ ] Run focused tests and confirm the old controls violate the contract.
- [ ] Remove manual output declarations while preserving actual stream parsing and reasoning/answer separation.
- [ ] Run focused tests until green.

### Task 4: Full Verification and Review

**Files:**
- Review all files changed by Tasks 1-3.

- [ ] Run `pnpm test`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `git diff --check` with the repository marked safe only for that command.
- [ ] Inspect the scoped diff for accidental context-compression, slot, scheduler, or unrelated Qoder changes.
