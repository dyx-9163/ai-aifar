export interface StreamTextNormalizer {
  push(chunk: string): string | undefined;
  value(): string;
}

export type StreamTextMode = 'incremental' | 'cumulative';

export function createStreamTextNormalizer(mode: StreamTextMode = 'incremental'): StreamTextNormalizer {
  let accumulated = '';

  return {
    push(chunk) {
      if (!chunk) {
        return undefined;
      }

      if (mode === 'incremental') {
        accumulated += chunk;
        return chunk;
      }

      if (!chunk.startsWith(accumulated)) {
        throw new Error('Cumulative stream text did not extend the previously declared snapshot.');
      }
      const emitted = chunk.slice(accumulated.length) || undefined;
      accumulated = chunk;
      return emitted;
    },
    value() {
      return accumulated;
    },
  };
}
