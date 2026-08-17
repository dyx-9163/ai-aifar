export {};

import type { AppSnapshot, ThreadSummary } from '../shared/domain';
import type { AgentEvent } from '../shared/protocol';

declare global {
  interface Window {
    desktop: {
      health(): Promise<{ ok: true; version: string }>;
      getSnapshot(): Promise<AppSnapshot>;
      createThread(title: string): Promise<ThreadSummary>;
      startTurn(threadId: string, text: string): Promise<void>;
      respondApproval(approvalId: string, approved: boolean): Promise<void>;
      subscribe(listener: (event: AgentEvent) => void): () => void;
    };
  }
}
