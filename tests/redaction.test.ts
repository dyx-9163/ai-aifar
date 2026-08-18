import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from '../src/shared/redaction';

describe('sensitive text redaction', () => {
  it('redacts raw JSON and bounded URL/form encodings with independently mixed hex case', () => {
    const secret = ['key ', '«', ' "', '\\', '?/[]'].join('');
    const representations = secretRepresentations(secret);
    const unrelated = 'keep unrelated path=a%2Fb and value%20here';
    const redacted = redactSensitiveText(`${representations.join(' | ')} | ${unrelated}`, [secret]);

    for (const representation of representations) {
      expect(redacted).not.toContain(representation);
    }
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).toContain(unrelated);
  });
});

function secretRepresentations(secret: string): string[] {
  const once = encodeURIComponent(secret);
  const formOnce = once.replace(/%20/g, '+');
  return [
    secret,
    JSON.stringify(secret).slice(1, -1),
    mixedPercentCase(once),
    mixedPercentCase(encodeURIComponent(once)),
    mixedPercentCase(formOnce),
    mixedPercentCase(encodeURIComponent(formOnce)),
  ];
}

function mixedPercentCase(value: string): string {
  let letter = 0;
  return value.replace(/%([0-9A-F]{2})/g, (_escape, hex: string) => `%${[...hex].map((digit) => {
    if (!/[A-F]/.test(digit)) return digit;
    const mixed = letter % 2 === 0 ? digit.toLowerCase() : digit.toUpperCase();
    letter += 1;
    return mixed;
  }).join('')}`);
}
