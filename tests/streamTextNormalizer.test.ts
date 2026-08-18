import { describe, expect, it } from 'vitest';
import { createStreamTextNormalizer } from '../src/agent/streamTextNormalizer';

describe('createStreamTextNormalizer', () => {
  it('preserves every ordinary incremental delta even when payload text repeats or overlaps', () => {
    const stream = createStreamTextNormalizer();

    expect(['A', 'AB', 'AB', 'ABC'].map((chunk) => stream.push(chunk)))
      .toEqual(['A', 'AB', 'AB', 'ABC']);
    expect(stream.value()).toBe('AABABABC');
  });

  it('normalizes cumulative snapshots only when that transport mode is declared explicitly', () => {
    const stream = createStreamTextNormalizer('cumulative');

    expect(['A', 'AB', 'AB', 'ABC'].map((chunk) => stream.push(chunk)))
      .toEqual(['A', 'B', undefined, 'C']);
    expect(stream.value()).toBe('ABC');
  });

  it('preserves immediate and later semantic repetition in incremental mode', () => {
    const stream = createStreamTextNormalizer();

    expect(['ha', 'ha', ' ', 'ha'].map((chunk) => stream.push(chunk)))
      .toEqual(['ha', 'ha', ' ', 'ha']);
    expect(stream.value()).toBe('haha ha');
  });

  it('preserves a suffix payload because text equality is not retransmission identity', () => {
    const stream = createStreamTextNormalizer();

    expect(['Hello', ' world', 'world'].map((chunk) => stream.push(chunk)))
      .toEqual(['Hello', ' world', 'world']);
    expect(stream.value()).toBe('Hello worldworld');
  });

  it('preserves partial overlaps as ordinary semantic deltas', () => {
    const stream = createStreamTextNormalizer();

    expect(['abc', 'cde'].map((chunk) => stream.push(chunk))).toEqual(['abc', 'cde']);
    expect(stream.value()).toBe('abccde');
  });

  it('preserves whitespace and Unicode exactly', () => {
    const stream = createStreamTextNormalizer();

    expect(['你', '你好', '  ', '好'].map((chunk) => stream.push(chunk)))
      .toEqual(['你', '你好', '  ', '好']);
    expect(stream.value()).toBe('你你好  好');
  });

  it('does not let an empty no-op suppress the next identical incremental delta', () => {
    const stream = createStreamTextNormalizer();

    expect([stream.push('same'), stream.push(''), stream.push('same')])
      .toEqual(['same', undefined, 'same']);
    expect(stream.value()).toBe('samesame');
  });

  it('keeps normalization state independent between channels', () => {
    const answer = createStreamTextNormalizer();
    const rawReasoning = createStreamTextNormalizer();
    const summary = createStreamTextNormalizer();

    expect(answer.push('相同')).toBe('相同');
    expect(rawReasoning.push('相同')).toBe('相同');
    expect(summary.push('相同')).toBe('相同');
    expect(answer.value()).toBe('相同');
    expect(rawReasoning.value()).toBe('相同');
    expect(summary.value()).toBe('相同');
  });
});
