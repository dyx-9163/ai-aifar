/** Trusted runtime facts injected by the desktop harness, never inferred by the model. */
export interface RuntimeContextSnapshot {
  iso: string;
  date: string;
  time: string;
  timeZone: string;
  utcOffset: string;
  locale: string;
  platform: NodeJS.Platform;
  source: 'system-clock';
}

export interface RuntimeContextOptions {
  now?: Date;
  timeZone?: string;
  locale?: string;
  platform?: NodeJS.Platform;
}

function dateTimeParts(date: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
}

function timeZoneOffset(date: Date, timeZone: string): string {
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value;
  if (!label || label === 'GMT') return '+00:00';
  const match = /^GMT([+-]\d{2}):?(\d{2})$/.exec(label);
  return match ? `${match[1]}:${match[2]}` : '+00:00';
}

export function runtimeContextSnapshot(options: RuntimeContextOptions = {}): RuntimeContextSnapshot {
  const now = options.now ?? new Date();
  const resolved = new Intl.DateTimeFormat().resolvedOptions();
  const timeZone = options.timeZone ?? resolved.timeZone ?? 'UTC';
  const locale = options.locale ?? resolved.locale ?? 'en-US';
  const platform = options.platform ?? process.platform;
  const parts = dateTimeParts(now, timeZone);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}:${parts.second}`;
  const utcOffset = timeZoneOffset(now, timeZone);

  return {
    iso: `${date}T${time}${utcOffset}`,
    date,
    time,
    timeZone,
    utcOffset,
    locale,
    platform,
    source: 'system-clock',
  };
}

export function buildRuntimeContextPrompt(context: RuntimeContextSnapshot): string {
  return [
    'Trusted runtime context (provided by the desktop harness):',
    `- Current local date and time: ${context.iso}`,
    `- Time zone: ${context.timeZone} (UTC${context.utcOffset})`,
    `- Locale: ${context.locale}`,
    `- Platform: ${context.platform}`,
    'For current date/time questions, use this trusted context; never use a workspace command tool or shell command.',
  ].join('\n');
}

export function buildBaseAssistantSystemPrompt(context: RuntimeContextSnapshot): string {
  return [
    'You are a helpful private AI assistant. Keep answers clear, practical, and concise.',
    '',
    buildRuntimeContextPrompt(context),
  ].join('\n');
}
