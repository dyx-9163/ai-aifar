export interface NormalizedToolCall {
  tool: string;
  input: Record<string, unknown>;
}

interface TextToolCallAdapter {
  parse(source: string, knownTools: ReadonlySet<string>): NormalizedToolCall[];
}

const TOOL_FENCE_GLOBAL_PATTERN = /```tool\s*\n([\s\S]*?)```/g;
const FENCE_WITH_LANG_PATTERN = /```([^\n]*)\n([\s\S]*?)```/g;
const TOOL_INVOKE_GLOBAL_PATTERN = /<invoke\s+[^>]*\bname="([^"]+)"[^>]*>((?:(?!<invoke\b)[\s\S])*?)<\/invoke>/g;
const TOOL_PARAMETER_PATTERN = /<parameter\s+[^>]*\bname="([^"]+)"[^>]*>((?:(?!<parameter\b|<invoke\b|<\/invoke\b)[\s\S])*?)<\/parameter>/g;
const TOOL_INVOKE_LENIENT_PATTERN = /<invoke\b[^>]*>((?:(?!<invoke\b)[\s\S])*?)<\/invoke>/g;
const TOOL_PARAMETER_LENIENT_PATTERN = /<parameter\b[^>]*>((?:(?!<parameter\b|<invoke\b|<\/invoke\b)[\s\S])*?)<\/parameter>/g;
const TOOL_CALL_PATTERN = /<tool_call\b[^>]*>((?:(?!<tool_call\b)[\s\S])*?)<\/tool_call>/g;
const TOOL_INPUT_PATTERN = /<tool_input\b[^>]*>((?:(?!<tool_input\b|<tool_call\b|<\/tool_call\b)[\s\S])*?)<\/tool_input>/g;
const NAME_ATTRIBUTE_PATTERN = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/;
const STRING_ATTRIBUTE_PATTERN = /\bstring\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/;
const UNPARSED_TEXT_TOOL_PATTERN = /<tool_calls\b|<invoke\b|<parameter\b|<tool_call\b|<tool_input\b/i;

const fencedJsonAdapter: TextToolCallAdapter = {
  parse(source, knownTools) {
    const calls: NormalizedToolCall[] = [];
    for (const match of source.matchAll(FENCE_WITH_LANG_PATTERN)) {
      const language = (match[1] ?? '').trim().toLowerCase();
      const parsed = parseFencedToolCall(match[2] ?? '');
      if (!parsed) continue;
      if (language === 'tool' || knownTools.has(parsed.tool)) calls.push(parsed);
    }
    return calls;
  },
};

const invokeXmlAdapter: TextToolCallAdapter = {
  parse(source) {
    const calls: NormalizedToolCall[] = [];
    for (const match of source.matchAll(TOOL_INVOKE_GLOBAL_PATTERN)) {
      const input: Record<string, unknown> = {};
      for (const parameter of (match[2] ?? '').matchAll(TOOL_PARAMETER_PATTERN)) {
        input[parameter[1]] = decodeToolValue(parameter[2] ?? '');
      }
      calls.push({ tool: match[1], input });
    }
    if (calls.length > 0) return calls;

    for (const match of source.matchAll(TOOL_INVOKE_LENIENT_PATTERN)) {
      const tool = attributeValue(match[0] ?? '', NAME_ATTRIBUTE_PATTERN);
      if (!tool) continue;
      calls.push({ tool, input: parseNamedValues(match[1] ?? '', TOOL_PARAMETER_LENIENT_PATTERN) });
    }
    return calls;
  },
};

const toolCallXmlAdapter: TextToolCallAdapter = {
  parse(source) {
    const calls: NormalizedToolCall[] = [];
    for (const match of source.matchAll(TOOL_CALL_PATTERN)) {
      const tool = attributeValue(match[0] ?? '', NAME_ATTRIBUTE_PATTERN);
      if (!tool) continue;
      calls.push({ tool, input: parseNamedValues(match[1] ?? '', TOOL_INPUT_PATTERN, true) });
    }
    return calls;
  },
};

const TEXT_TOOL_CALL_ADAPTERS: readonly TextToolCallAdapter[] = [
  fencedJsonAdapter,
  invokeXmlAdapter,
  toolCallXmlAdapter,
];

export function parseTextToolCalls(text: string, knownTools: ReadonlySet<string>): NormalizedToolCall[] {
  const source = normalizeProviderTags(text);
  for (const adapter of TEXT_TOOL_CALL_ADAPTERS) {
    const calls = adapter.parse(source, knownTools);
    if (calls.length > 0) return calls;
  }
  return [];
}

export function hasUnparsedToolFence(text: string): boolean {
  for (const match of text.matchAll(TOOL_FENCE_GLOBAL_PATTERN)) {
    if (!match[1] || !parseFencedToolCall(match[1])) return true;
  }
  return false;
}

export function hasUnparsedTextToolProtocol(text: string): boolean {
  return UNPARSED_TEXT_TOOL_PATTERN.test(normalizeProviderTags(text));
}

export function looksLikeTruncatedTextToolCall(text: string): boolean {
  const withoutCompleteCalls = normalizeProviderTags(text)
    .replace(/```tool\s*\n[\s\S]*?```/g, '')
    .replace(TOOL_INVOKE_LENIENT_PATTERN, '')
    .replace(TOOL_CALL_PATTERN, '');
  return /```tool\b/.test(withoutCompleteCalls)
    || /<invoke\b/.test(withoutCompleteCalls)
    || /<tool_call\b/.test(withoutCompleteCalls)
    || /<tool_input\b/.test(withoutCompleteCalls);
}

export function stripTextToolProtocol(text: string, knownTools: ReadonlySet<string>): string {
  return normalizeProviderTags(text)
    .replace(FENCE_WITH_LANG_PATTERN, (whole, language: string, body: string) => {
      if (language.trim().toLowerCase() === 'tool') return '';
      const parsed = parseFencedToolCall(body);
      return parsed && knownTools.has(parsed.tool) ? '' : whole;
    })
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '')
    .replace(TOOL_INVOKE_LENIENT_PATTERN, '')
    .replace(TOOL_CALL_PATTERN, '')
    .replace(/<(?:parameter|tool_input)\b[\s\S]*?<\/(?:parameter|tool_input)>/g, '')
    .replace(/<\/?(?:tool_calls|invoke|parameter|tool_call|tool_input)\b[^>]*>/g, '')
    .trim();
}

function parseNamedValues(
  body: string,
  pattern: RegExp,
  respectStringAttribute = false,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const value of body.matchAll(pattern)) {
    const whole = value[0] ?? '';
    const openTag = whole.slice(0, whole.indexOf('>') + 1);
    const name = attributeValue(openTag, NAME_ATTRIBUTE_PATTERN);
    if (!name) continue;
    const raw = value[1] ?? '';
    const stringAttribute = respectStringAttribute
      ? attributeValue(openTag, STRING_ATTRIBUTE_PATTERN)?.toLowerCase()
      : undefined;
    input[name] = stringAttribute === 'true' ? raw.trim() : decodeToolValue(raw);
  }
  return input;
}

function attributeValue(source: string, pattern: RegExp): string | undefined {
  const match = source.match(pattern);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function repairToolJson(body: string): string {
  const cleaned = body.replace(/,(\s*[}\]])/g, '$1');
  let repaired = '';
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of cleaned) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      else if (char === '\n') { repaired += '\\n'; continue; }
      else if (char === '\r') continue;
      else if (char === '\t') { repaired += '\\t'; continue; }
      repaired += char;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') stack.pop();
    repaired += char;
  }
  if (inString) repaired += '"';
  return repaired + stack.reverse().join('');
}

function parseFencedToolCall(body: string): NormalizedToolCall | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    try {
      parsed = JSON.parse(repairToolJson(body.trim()));
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const tool = typeof record.tool === 'string' ? record.tool : typeof record.name === 'string' ? record.name : undefined;
  if (!tool) return undefined;
  const rawInput = record.input ?? record.arguments ?? {};
  const input = typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput)
    ? rawInput as Record<string, unknown>
    : {};
  return { tool, input };
}

function normalizeProviderTags(text: string): string {
  return text.replace(/<\/?｜DSML｜/g, (tag) => (tag.startsWith('</') ? '</' : '<'));
}

function decodeToolValue(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      return JSON.parse(repairToolJson(trimmed));
    } catch {
      return trimmed;
    }
  }
}
