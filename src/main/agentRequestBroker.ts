export interface AgentRequestPort {
  postMessage(message: unknown): void;
}

export type AgentReply =
  | { type: 'agent.reply'; requestId: string; ok: true; data?: unknown }
  | { type: 'agent.reply'; requestId: string; ok: false; error: string };

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
  deadline: ReturnType<typeof setTimeout>;
}

export class AgentRequestBroker {
  private port: AgentRequestPort | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly deadlineMs: number) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  connect(port: AgentRequestPort): void {
    if (this.port && this.port !== port) {
      this.disconnect('Agent runtime connection was replaced.');
    }
    this.port = port;
  }

  request(request: unknown): Promise<unknown> {
    const port = this.port;
    if (!port) {
      return Promise.reject(new Error('Agent runtime is not ready.'));
    }

    const requestId = `request-${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        reject(new Error(`Agent request timed out after ${this.deadlineMs}ms.`));
      }, this.deadlineMs);
      this.pending.set(requestId, { resolve, reject, deadline });
      try {
        port.postMessage({ type: 'agent.request', requestId, request });
      } catch (error) {
        this.rejectRequest(requestId, error);
      }
    });
  }

  handleReply(reply: AgentReply): boolean {
    const pending = this.takeRequest(reply.requestId);
    if (!pending) return false;
    if (reply.ok) {
      pending.resolve(reply.data);
    } else {
      pending.reject(new Error(reply.error));
    }
    return true;
  }

  disconnect(reason: string | Error): void {
    this.port = undefined;
    const error = reason instanceof Error ? reason : new Error(reason);
    for (const requestId of [...this.pending.keys()]) {
      this.rejectRequest(requestId, error);
    }
  }

  private takeRequest(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    clearTimeout(pending.deadline);
    return pending;
  }

  private rejectRequest(requestId: string, reason: unknown): void {
    const pending = this.takeRequest(requestId);
    pending?.reject(reason);
  }
}
