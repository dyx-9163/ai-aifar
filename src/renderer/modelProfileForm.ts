import type {
  ModelCapabilities,
  ModelConnectionResult,
  ModelConnectionStatus,
  ModelProfile,
  ModelProfileInput,
  ReasoningDisplayMode,
  ReasoningInputMode,
  ReasoningMode,
  ReasoningProtocol,
} from '../shared/domain';
import {
  reasoningConfigurationIssue,
  type ReasoningConfigurationIssue,
} from '../shared/reasoningConfiguration';
import { MAX_OUTPUT_TOKENS } from '../shared/modelProfileLimits';

export interface ModelProfileFormValues {
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  isDefault: boolean;
  reasoningMode: ReasoningMode;
  reasoningProtocol: ReasoningProtocol;
  reasoningEffort: string;
  profileReasoningDisplay: ReasoningDisplayMode;
  reasoningInputMode: ReasoningInputMode;
  effortOptions: string[];
  defaultEffort: string;
  customRequestBodyText?: string;
  rawOutput: boolean;
  summaryOutput: boolean;
  maxConcurrency: number;
  maxOutputTokens: number;
}

export interface EffortSelectionInput {
  reasoningMode: ReasoningMode;
  inputMode: ReasoningInputMode;
  options: string[];
  currentEffort: string;
  defaultEffort: string;
}

export interface ReasoningControlSelection {
  inputMode: ReasoningInputMode;
  effortOptions: string[];
  currentEffort: string;
  defaultEffort: string;
}

export type EffortValidationIssue = 'effortOptionsRequired' | 'defaultEffortInvalid' | 'currentEffortInvalid';
export type ConnectionTestState = 'untested' | 'testing' | 'failed' | ModelConnectionStatus;
export const OPENAI_REASONING_EFFORT_OPTIONS = ['high', 'max'];

/** Maximum Unicode code points shown for a configured model identifier in Settings diagnostics. */
export const MAX_MODEL_IDENTIFIER_DISPLAY_LENGTH = 96;

export function maxOutputTokensIsValid(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_OUTPUT_TOKENS;
}

type ConnectionDiagnosticTranslationKey =
  | 'connectionConnectedDiagnostic'
  | 'connectionConcurrencyWarningDiagnostic'
  | 'connectionSlotsUnverifiedDiagnostic'
  | 'connectionModelMismatchDiagnostic'
  | 'connectionOfflineDiagnostic'
  | 'connectionOfflineLocalQwenCommand';

export function modelConnectionDiagnostic(
  result: ModelConnectionResult,
  translate: (key: ConnectionDiagnosticTranslationKey) => string,
  showLocalQwenCommand: boolean,
): string {
  let key: ConnectionDiagnosticTranslationKey;
  switch (result.status) {
    case 'connected':
      key = 'connectionConnectedDiagnostic';
      break;
    case 'concurrency-warning':
      key = 'connectionConcurrencyWarningDiagnostic';
      break;
    case 'slots-unverified':
      key = 'connectionSlotsUnverifiedDiagnostic';
      break;
    case 'model-mismatch':
      key = 'connectionModelMismatchDiagnostic';
      break;
    case 'offline':
      key = 'connectionOfflineDiagnostic';
      break;
    default:
      return assertNever(result);
  }

  const diagnostic = replaceDiagnosticValues(translate(key), result);
  return result.status === 'offline' && showLocalQwenCommand
    ? `${diagnostic} ${translate('connectionOfflineLocalQwenCommand')}`
    : diagnostic;
}

function assertNever(_value: never): never {
  throw new Error('Unsupported model connection status.');
}

export interface FormOperationSnapshot {
  token: number;
  profileId?: string;
  fingerprint: string;
  revision: number;
}

export function captureFormOperation(
  token: number,
  profile: ModelProfileInput | ModelProfile,
  revision: number,
): FormOperationSnapshot {
  return {
    token,
    profileId: profile.id,
    fingerprint: modelProfileFormFingerprint(profile),
    revision,
  };
}

export function formOperationCanApply(
  submitted: FormOperationSnapshot,
  current: FormOperationSnapshot,
): boolean {
  return submitted.token === current.token
    && submitted.profileId === current.profileId
    && submitted.fingerprint === current.fingerprint
    && submitted.revision === current.revision;
}

export function buildModelProfileInput(
  form: ModelProfileFormValues,
  existing?: ModelProfile,
): ModelProfileInput {
  const capabilities = cloneCapabilities(existing?.capabilities ?? canonicalCapabilities());
  capabilities.reasoning = {
    ...capabilities.reasoning,
    inputMode: form.reasoningInputMode,
    effortOptions: [...form.effortOptions],
    outputModes: [
      ...(form.rawOutput ? ['raw' as const] : []),
      ...(form.summaryOutput ? ['summary' as const] : []),
    ],
    defaultEffort: form.defaultEffort || undefined,
    customRequestBody: parseCustomRequestBody(form.customRequestBodyText),
  };

  return {
    id: form.id || existing?.id,
    name: form.name,
    provider: existing?.provider ?? 'openai-compatible',
    baseUrl: form.baseUrl,
    model: form.model,
    apiKey: form.apiKey || undefined,
    isDefault: form.isDefault,
    capabilities,
    reasoning: {
      ...(existing?.reasoning ?? { mode: 'disabled', protocol: 'none', display: 'auto' }),
      mode: form.reasoningMode,
      protocol: form.reasoningProtocol,
      effort: form.reasoningEffort || undefined,
      display: form.profileReasoningDisplay,
    },
    maxConcurrency: form.maxConcurrency,
    maxOutputTokens: form.maxOutputTokens,
    responseSpeed: existing?.responseSpeed,
  };
}

export function isNewModelProfileDraft(formId: string | undefined, profiles: readonly ModelProfile[]): boolean {
  return !formId || !profiles.some((profile) => profile.id === formId);
}

export function recommendedReasoningControlForProtocol(
  protocol: ReasoningProtocol,
  current: ReasoningControlSelection,
): ReasoningControlSelection | undefined {
  if (current.inputMode === 'custom') {
    return undefined;
  }
  if (protocol === 'openai' && current.inputMode !== 'effort') {
    return {
      inputMode: 'effort',
      effortOptions: [...OPENAI_REASONING_EFFORT_OPTIONS],
      currentEffort: OPENAI_REASONING_EFFORT_OPTIONS[0] ?? '',
      defaultEffort: OPENAI_REASONING_EFFORT_OPTIONS[0] ?? '',
    };
  }
  if (protocol === 'qwen' && current.inputMode !== 'toggle') {
    return {
      inputMode: 'toggle',
      effortOptions: [],
      currentEffort: '',
      defaultEffort: '',
    };
  }
  if (protocol === 'none' && current.inputMode !== 'unsupported') {
    return {
      inputMode: 'unsupported',
      effortOptions: [],
      currentEffort: '',
      defaultEffort: '',
    };
  }
  return undefined;
}

export function reconcileEffortSelection(input: EffortSelectionInput): {
  currentEffort: string;
  defaultEffort: string;
} {
  if (!reasoningEffortIsActive(input) || input.options.length === 0) {
    return { currentEffort: input.currentEffort, defaultEffort: input.defaultEffort };
  }
  const defaultEffort = input.options.includes(input.defaultEffort) ? input.defaultEffort : input.options[0];
  const currentEffort = input.options.includes(input.currentEffort) ? input.currentEffort : defaultEffort;
  return { currentEffort, defaultEffort };
}

export function effortValidationIssue(input: EffortSelectionInput): EffortValidationIssue | undefined {
  if (!reasoningEffortIsActive(input)) {
    return undefined;
  }
  if (input.options.length === 0) {
    return 'effortOptionsRequired';
  }
  if (!input.options.includes(input.defaultEffort)) {
    return 'defaultEffortInvalid';
  }
  if (!input.options.includes(input.currentEffort)) {
    return 'currentEffortInvalid';
  }
  return undefined;
}

export function reasoningConfigurationValidationIssue(input: {
  reasoningMode: ReasoningMode;
  inputMode: ReasoningInputMode;
  protocol: ReasoningProtocol;
}): ReasoningConfigurationIssue | undefined {
  return reasoningConfigurationIssue({
    mode: input.reasoningMode,
    inputMode: input.inputMode,
    protocol: input.protocol,
  });
}

export async function runModelProfileSave(
  input: ModelProfileInput,
  save: (profile: ModelProfileInput) => Promise<ModelProfile>,
): Promise<{ ok: true; profile: ModelProfile } | { ok: false; error: Error }> {
  try {
    return { ok: true, profile: await save(input) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

export function modelProfileFormFingerprint(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function connectionTestStateForFingerprint(
  state: ConnectionTestState,
  testedFingerprint: string | undefined,
  currentFingerprint: string,
): ConnectionTestState {
  return testedFingerprint === currentFingerprint ? state : 'untested';
}

function reasoningEffortIsActive(input: EffortSelectionInput): boolean {
  return input.inputMode === 'effort' && (input.reasoningMode === 'enabled' || input.reasoningMode === 'auto');
}

export function customRequestBodyValidationIssue(inputMode: ReasoningInputMode, text: string | undefined): 'customRequestBodyInvalid' | undefined {
  if (inputMode !== 'custom' || !text?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return 'customRequestBodyInvalid';
    }
    return undefined;
  } catch {
    return 'customRequestBodyInvalid';
  }
}

function replaceDiagnosticValues(template: string, result: ModelConnectionResult): string {
  const serviceSlots = result.status === 'connected' || result.status === 'concurrency-warning'
    ? result.serviceSlots
    : undefined;
  return template
    .replace('{model}', modelIdentifierForDisplay(result.model))
    .replace('{concurrency}', String(result.clientConcurrency))
    .replace('{slots}', serviceSlots === undefined ? '—' : String(serviceSlots));
}

function modelIdentifierForDisplay(value: string): string {
  const displayed: string[] = [];
  for (const codePoint of value) {
    if (displayed.length === MAX_MODEL_IDENTIFIER_DISPLAY_LENGTH) {
      return `${displayed.slice(0, MAX_MODEL_IDENTIFIER_DISPLAY_LENGTH - 1).join('')}…`;
    }
    displayed.push(codePoint);
  }
  return displayed.join('');
}

function canonicalCapabilities(): ModelCapabilities {
  return {
    text: true,
    vision: false,
    longContext: false,
    reasoning: { inputMode: 'unsupported', effortOptions: [], outputModes: [], customRequestBody: undefined },
    concurrency: { defaultLimit: 1, configurable: true, maxLimit: 32 },
    streaming: true,
    usage: { tokens: true, reasoningTokens: true },
    nativeTools: false,
  };
}

function cloneCapabilities(capabilities: ModelCapabilities): ModelCapabilities {
  return {
    ...capabilities,
    reasoning: {
      ...capabilities.reasoning,
      effortOptions: [...capabilities.reasoning.effortOptions],
      outputModes: [...capabilities.reasoning.outputModes],
      customRequestBody: cloneCustomRequestBody(capabilities.reasoning.customRequestBody),
    },
    concurrency: { ...capabilities.concurrency },
    usage: { ...capabilities.usage },
  };
}

function parseCustomRequestBody(text: string | undefined): Record<string, unknown> | undefined {
  if (!text?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function cloneCustomRequestBody(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}
