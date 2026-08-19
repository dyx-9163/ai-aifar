import type { ReasoningInputMode, ReasoningMode, ReasoningProtocol } from './domain.js';

export type ReasoningConfigurationIssue =
  | 'customUnsupported'
  | 'toggleRequiresQwen'
  | 'effortRequiresOpenAi'
  | 'unsupportedInputEnabled';

export function reasoningConfigurationIssue(input: {
  inputMode: ReasoningInputMode;
  protocol: ReasoningProtocol;
  mode: ReasoningMode;
}): ReasoningConfigurationIssue | undefined {
  if (input.inputMode === 'unsupported' && input.mode !== 'disabled') {
    return 'unsupportedInputEnabled';
  }
  return undefined;
}
