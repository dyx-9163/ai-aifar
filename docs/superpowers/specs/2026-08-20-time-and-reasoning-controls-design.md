# Time Context and Reasoning Controls Design

## Status

Approved in conversation on 2026-08-20. Context-window compaction and model-generated chat summaries are explicitly deferred.

## Goal

Close the current-time information loop without shell commands, keep the transport fixed to OpenAI-compatible APIs, present one coherent reasoning-control choice, and show native reasoning summaries only when the provider actually emits them.

## Decisions

1. Every model request receives a trusted runtime context containing the current local date, time, UTC offset, IANA time-zone identifier when available, locale, and operating system.
2. Workspace agent turns also receive a read-only `get_current_datetime` tool. The tool never invokes a shell and returns the same typed runtime context.
3. The system prompt explicitly forbids using `run_command` for date/time questions. Direct chats use the same base prompt, so time questions also work without a workspace.
4. A timed-out `run_command` is a failed tool operation with code `command-timeout`, never a completed operation.
5. Model transport remains internally fixed to `openai-compatible`; the Settings UI does not expose a provider compatibility selector.
6. The separate protocol and input-mode selectors become one user-facing reasoning control: unsupported, toggle, or effort. Toggle maps to the Qwen request shape; effort maps to the OpenAI `reasoning_effort` request shape. Existing profiles migrate through the current persisted fields.
7. Raw-reasoning and native-summary output are observed provider data, not user-declared capabilities. Settings does not expose raw/summary output checkboxes.
8. A native reasoning summary is rendered only after an actual `reasoning.summary.delta` event. The client does not make a paid connection-test inference call and does not generate a substitute summary.

## Non-Goals

- No changes to context-message limits, token-aware compression, or model-generated history summaries.
- No changes to private-model slot discovery or queue scheduling.
- No new provider SDK or non-OpenAI-compatible transport.
- No client-generated reasoning summary.

## Verification

- Regression coverage for trusted clock formatting, the exact phrase `今天是好久？`, no shell guidance, and timeout-as-failure.
- Form tests for reasoning-control mapping and preservation of existing profiles.
- Renderer tests proving native summaries appear only when received.
- Full unit test suite and TypeScript type checking.
