export function safeErrorText(
  error: unknown,
  secrets: readonly string[] = [],
  maxLength = 500,
  fallback = 'Agent request failed.',
): string {
  const source = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
  const redacted = redactSensitiveText(source, secrets)
    .replace(/\s+/g, ' ')
    .trim();
  return (redacted || fallback).slice(0, maxLength);
}

export function redactSensitiveText(text: string, secrets: readonly string[]): string {
  let redacted = text;
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    addSecretVariants(variants, secret);
  }

  for (const variant of [...variants].sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(variant).join('[REDACTED]');
  }

  return redacted
    .replace(/authorization\s*["']?\s*[:=]\s*["']?\s*(?:bearer\s+)?[^\s,;"']+/gi, '[REDACTED]')
    .replace(/bearer\s+[^\s,;"']+/gi, '[REDACTED]');
}

function addSecretVariants(variants: Set<string>, secret: string): void {
  variants.add(secret);

  let jsonEscaped = secret;
  for (let depth = 0; depth < 2; depth += 1) {
    jsonEscaped = JSON.stringify(jsonEscaped).slice(1, -1);
    variants.add(jsonEscaped);
    variants.add(jsonEscaped.replace(/\//g, '\\/'));
  }

  let encoded = secret;
  for (let depth = 0; depth < 2; depth += 1) {
    encoded = encodeURIComponent(encoded);
    variants.add(encoded);
    variants.add(encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()));
    variants.add(encoded.replace(/%20/g, '+'));
  }
}
