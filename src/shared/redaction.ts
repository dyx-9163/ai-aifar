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
  const exactVariants = new Set<string>();
  const encodedVariants = new Map<string, EncodedCandidate>();
  for (const secret of secrets) {
    if (!secret) continue;
    addSecretVariants(exactVariants, encodedVariants, secret);
  }

  for (const variant of [...exactVariants].sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(variant).join('[REDACTED]');
  }
  for (const candidate of [...encodedVariants.values()].sort((left, right) => right.value.length - left.value.length)) {
    redacted = redacted.replace(encodedCandidatePattern(candidate), '[REDACTED]');
  }

  return redacted
    .replace(/authorization\s*["']?\s*[:=]\s*["']?\s*(?:bearer\s+)?[^\s,;"']+/gi, '[REDACTED]')
    .replace(/bearer\s+[^\s,;"']+/gi, '[REDACTED]');
}

interface EncodedCandidate {
  value: string;
  flexibleHex: ReadonlySet<number>;
}

function addSecretVariants(
  exactVariants: Set<string>,
  encodedVariants: Map<string, EncodedCandidate>,
  secret: string,
): void {
  exactVariants.add(secret);

  let jsonEscaped = secret;
  for (let depth = 0; depth < 2; depth += 1) {
    jsonEscaped = JSON.stringify(jsonEscaped).slice(1, -1);
    exactVariants.add(jsonEscaped);
    exactVariants.add(jsonEscaped.replace(/\//g, '\\/'));
  }

  let percentEncoded: EncodedCandidate = { value: secret, flexibleHex: new Set() };
  let formEncoded: EncodedCandidate = { value: secret, flexibleHex: new Set() };
  for (let depth = 0; depth < 2; depth += 1) {
    percentEncoded = encodeCandidate(percentEncoded, false);
    formEncoded = encodeCandidate(formEncoded, true);
    encodedVariants.set(candidateKey(percentEncoded), percentEncoded);
    encodedVariants.set(candidateKey(formEncoded), formEncoded);
  }
}

function encodeCandidate(candidate: EncodedCandidate, formSpaces: boolean): EncodedCandidate {
  let value = '';
  const flexibleHex = new Set<number>();
  for (let inputIndex = 0; inputIndex < candidate.value.length;) {
    const codePoint = candidate.value.codePointAt(inputIndex);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const characterLength = character.length;
    const encoded = formSpaces && character === ' ' ? '+' : encodeURIComponent(character);
    const outputStart = value.length;
    value += encoded;
    if (encoded === character) {
      for (let offset = 0; offset < characterLength; offset += 1) {
        if (candidate.flexibleHex.has(inputIndex + offset)) flexibleHex.add(outputStart + offset);
      }
    } else {
      for (let offset = 0; offset < encoded.length; offset += 1) {
        if (encoded[offset] === '%') {
          flexibleHex.add(outputStart + offset + 1);
          flexibleHex.add(outputStart + offset + 2);
        }
      }
    }
    inputIndex += characterLength;
  }
  return { value, flexibleHex };
}

function candidateKey(candidate: EncodedCandidate): string {
  return `${candidate.value}\u0000${[...candidate.flexibleHex].join(',')}`;
}

function encodedCandidatePattern(candidate: EncodedCandidate): RegExp {
  let pattern = '';
  for (let index = 0; index < candidate.value.length; index += 1) {
    const character = candidate.value[index];
    if (candidate.flexibleHex.has(index) && /[A-Fa-f]/.test(character)) {
      pattern += `[${character.toLowerCase()}${character.toUpperCase()}]`;
    } else {
      pattern += escapeRegularExpression(character);
    }
  }
  return new RegExp(pattern, 'g');
}

function escapeRegularExpression(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
