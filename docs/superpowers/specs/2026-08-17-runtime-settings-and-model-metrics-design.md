# Runtime Settings and Model Metrics Design

## Goal

Make the Advanced settings page editable and make model runtime behavior visible and configurable without binding the desktop client to Qwen or any single OpenAI-compatible server extension.

This design covers:

- editable runtime settings in Settings > Advanced;
- per-model reasoning configuration;
- context behavior for independent chats;
- model run metrics, including speed and usage provenance;
- renderer copy and layout updates needed to make the settings page feel like the rest of the workbench.

## User Problems

The current Advanced page displays fixed rows and cannot be changed. It shows:

- thinking mode: default off;
- metrics display: enabled;
- context policy: current chat only.

The current model request also hardcodes Qwen-style thinking behavior through `chat_template_kwargs.enable_thinking = false`, so it cannot represent DeepSeek, Llama, GLM, enterprise gateways, or OpenAI-compatible endpoints with different reasoning controls.

The current metrics need clearer provenance. Some values are returned by the server, some are computed by the client, and some OpenAI-compatible servers do not return them at all.

## Scope

In scope:

- Add persisted global runtime settings.
- Add persisted per-model reasoning settings.
- Make Settings > Advanced editable.
- Keep context isolation per chat.
- Show per-run metrics with clear source labels.
- Keep private model support model-agnostic.
- Keep the MVP dependency set unchanged.

Out of scope:

- Displaying raw hidden chain-of-thought.
- Adding CopilotKit, LangChain, AG-UI runtime packages, MCP packages, Redis, PostgreSQL, or a provider SDK.
- Implementing full tool calling or AgentScope gateway behavior in this pass.
- Automatically inferring model capabilities from model names.

## Product Behavior

### Advanced Settings

Settings > Advanced becomes editable and contains:

- Metrics display: on/off toggle.
- Context message limit: numeric control with presets `10`, `20`, `50`, plus custom positive integer.
- Context policy: read-only value, `current chat only`.

The context policy stays read-only because independent chat groups are a privacy and correctness boundary. Users may change how many recent messages are included, but one chat must not silently consume another chat's history.

### Model Reasoning Settings

Reasoning belongs to each model profile, not only to global settings.

Each profile stores:

- `reasoningMode`: `auto`, `enabled`, or `disabled`.
- `reasoningProtocol`: `none`, `qwen`, `openai`, or `custom`.
- `reasoningEffort`: `low`, `medium`, or `high`, only meaningful for providers that support an effort-style parameter.

Default behavior for existing profiles:

- `reasoningMode = disabled`
- `reasoningProtocol = none`
- `reasoningEffort = medium`

The UI places reasoning controls under Settings > Model Services for the selected model profile. The Advanced page can show the current effective reasoning policy, but it must not be the only place to edit it.

### Request Mapping

The provider maps settings to request bodies through explicit profile capabilities:

| Protocol | Request behavior |
|---|---|
| `none` | Send no reasoning or thinking-specific parameters. |
| `qwen` | Send `chat_template_kwargs.enable_thinking` when the endpoint is configured to accept it. |
| `openai` | Send OpenAI-style reasoning settings only when explicitly enabled for the profile. |
| `custom` | Reserved but disabled in this pass. The UI may display it as unavailable, and the provider must not send custom JSON. |

`auto` mode does not guess by model name. It can only use capability flags saved in the profile or returned by a future health check. If capability is unknown, `auto` behaves like `disabled`.

### Metrics

The app records and displays metrics per model run:

- requested reasoning mode;
- observed reasoning support when the API returns usage or reasoning fields;
- prompt tokens;
- completion tokens;
- total tokens;
- time to first token;
- total duration;
- tokens per second;
- metric source: `server`, `client`, or `unavailable`.

Metric rules:

- Duration and time to first token are always client-measured.
- Token counts come from server `usage` when returned.
- Tokens per second uses server timing when the server provides an explicit rate; otherwise it uses server completion tokens divided by client duration; otherwise it is unavailable.
- The UI must label the source so the user can tell whether speed came from the model server or from local calculation.

The app must not persist or display raw hidden reasoning text. If the server returns visible reasoning deltas in a provider-specific field, this pass records only that reasoning was observed and any returned reasoning token count.

### Context

Each chat group has independent context. When a turn starts, the worker builds context from messages in the same chat only, up to the configured message limit.

The default limit remains `20` messages. The setting affects future turns only and does not rewrite existing saved messages.

### UI Layout

Settings keeps the left settings section navigation and a center content panel. The Advanced panel changes from static rows to real controls:

- a toggle row for metrics;
- a compact segmented or select control for context limit presets;
- a numeric input when custom limit is selected;
- a read-only context policy row with muted explanatory copy;
- a summary row showing the active model's reasoning configuration.

Model Services follows a Codex-like settings arrangement:

- active chat model selector at the top;
- profile list or pill row;
- editable profile form;
- endpoint and authentication fields;
- capabilities section;
- reasoning section;
- actions aligned at the bottom right.

No settings controls are placed in the right inspector during this pass. The right inspector remains for plan, activity, approvals, and run details.

## Data Model

Extend app settings:

```ts
type AppSettings = {
  theme: "light" | "dark";
  language: "zh-CN" | "en-US";
  activeModelProfileId?: string;
  showModelMetrics: boolean;
  contextMessageLimit: number;
};
```

Extend model profiles:

```ts
type ReasoningMode = "auto" | "enabled" | "disabled";
type ReasoningProtocol = "none" | "qwen" | "openai" | "custom";
type ReasoningEffort = "low" | "medium" | "high";

type ModelReasoningSettings = {
  mode: ReasoningMode;
  protocol: ReasoningProtocol;
  effort: ReasoningEffort;
};
```

Extend model run metrics:

```ts
type MetricSource = "server" | "client" | "unavailable";

type ModelRunMetrics = {
  modelProfileId?: string;
  modelName?: string;
  reasoningRequested: ReasoningMode;
  reasoningProtocol: ReasoningProtocol;
  reasoningObserved: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  timeToFirstTokenMs?: number;
  durationMs: number;
  tokensPerSecond?: number;
  speedSource: MetricSource;
  usageSource: MetricSource;
};
```

Existing saved settings and profiles migrate by applying defaults at read time and during the next save. No destructive migration is required.

## Error Handling

- If a server rejects `stream_options.include_usage`, retry once without that option and mark usage source as unavailable.
- If a server rejects reasoning parameters, show a profile-level warning and retry without reasoning parameters for that run.
- If metrics are incomplete, show only available values.
- If a custom context limit is less than `1`, clamp to `1`.
- If a custom context limit is larger than `200`, clamp to `200` for the MVP.
- API keys remain redacted from renderer snapshots.

## Testing

Add or update tests for:

- settings persistence and default migration;
- profile reasoning persistence and redaction;
- OpenAI-compatible request mapping for `none`, `qwen`, and `openai`;
- retry behavior when optional usage or reasoning parameters are rejected;
- metrics calculation and source labels;
- context builder using only the active chat and the configured limit;
- renderer state updates for Advanced settings;
- Settings UI e2e path for editing language, model, reasoning, metrics, and context limit.

Verification commands:

- `pnpm typecheck`
- `pnpm test`
- `pnpm test:e2e`
- `pnpm make`

## Acceptance Criteria

The implementation is accepted when:

1. Advanced settings are editable and persist after restart.
2. Existing profiles continue to work with no user migration step.
3. Qwen thinking can be enabled through an explicit Qwen protocol setting, but Qwen is not hardcoded as the only private model.
4. OpenAI-style reasoning settings are sent only when the profile explicitly enables that protocol.
5. Chat context remains isolated per chat group.
6. A model run shows speed and usage only with clear source labels.
7. Raw hidden reasoning is not displayed or persisted.
8. The settings layout is centered, compact, and consistent with the existing Codex-like workbench style.
