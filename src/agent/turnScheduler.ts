export interface ScheduledTurn {
  turnId: string;
  threadId: string;
  modelProfileId: string;
  title: string;
  run(signal: AbortSignal): Promise<void>;
}

export interface SchedulerCallbacks {
  onQueued(turn: ScheduledTurn, position: number): Promise<void> | void;
  onStarted(turn: ScheduledTurn): Promise<void> | void;
  onCancelled(turn: ScheduledTurn, wasRunning: boolean): Promise<void> | void;
  onQueuePositions(
    modelProfileId: string,
    positions: ReadonlyMap<string, number>,
  ): Promise<void> | void;
}

type RunningTurn = {
  turn: ScheduledTurn;
  controller: AbortController;
};

export class ModelTurnScheduler {
  private readonly queues = new Map<string, ScheduledTurn[]>();
  private readonly running = new Map<string, RunningTurn>();
  private readonly runningByModel = new Map<string, Set<string>>();
  private readonly cancellationRequested = new Set<string>();
  private readonly queuedTurnIds = new Set<string>();
  private readonly queuedCallbacks = new Map<string, Promise<void>>();
  private readonly queuePositionCallbacks = new Map<string, Promise<void>>();

  constructor(
    private readonly limitFor: (modelProfileId: string) => number,
    private readonly callbacks: SchedulerCallbacks,
  ) {}

  enqueue(turn: ScheduledTurn): void {
    if (this.hasActiveThread(turn.threadId)) {
      throw new Error(`Thread "${turn.threadId}" already has an active turn`);
    }

    const queue = this.queueFor(turn.modelProfileId);
    queue.push(turn);
    this.drain(turn.modelProfileId, false);

    const queuedIndex = queue.findIndex((candidate) => candidate.turnId === turn.turnId);
    if (queuedIndex >= 0) {
      this.queuedTurnIds.add(turn.turnId);
      const pending = this.invokeMaybeAsync(() => this.callbacks.onQueued(turn, queuedIndex + 1));
      if (pending) {
        this.trackQueuedCallback(turn.turnId, pending);
      }
    }
    this.emitQueuePositions(turn.modelProfileId);
  }

  cancel(turnId: string): boolean {
    const running = this.running.get(turnId);
    if (running) {
      if (this.cancellationRequested.has(turnId)) {
        return false;
      }
      this.cancellationRequested.add(turnId);
      running.controller.abort();
      return true;
    }

    for (const [modelProfileId, queue] of this.queues) {
      const index = queue.findIndex((turn) => turn.turnId === turnId);
      if (index < 0) {
        continue;
      }

      const [turn] = queue.splice(index, 1);
      this.queuedTurnIds.delete(turn.turnId);
      const queuedCallback = this.queuedCallbacks.get(turn.turnId);
      this.queuedCallbacks.delete(turn.turnId);
      void this.invoke(async () => {
        await queuedCallback;
        await this.callbacks.onCancelled(turn, false);
      });
      this.emitQueuePositions(modelProfileId);
      return true;
    }

    return false;
  }

  updateLimit(modelProfileId: string): void {
    this.drain(modelProfileId);
  }

  hasActiveThread(threadId: string): boolean {
    for (const { turn } of this.running.values()) {
      if (turn.threadId === threadId) {
        return true;
      }
    }

    for (const queue of this.queues.values()) {
      if (queue.some((turn) => turn.threadId === threadId)) {
        return true;
      }
    }

    return false;
  }

  private queueFor(modelProfileId: string): ScheduledTurn[] {
    let queue = this.queues.get(modelProfileId);
    if (!queue) {
      queue = [];
      this.queues.set(modelProfileId, queue);
    }
    return queue;
  }

  private effectiveLimit(modelProfileId: string): number {
    const configured = this.limitFor(modelProfileId);
    return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 1;
  }

  private drain(modelProfileId: string, emitPositions = true): void {
    const queue = this.queues.get(modelProfileId);
    if (queue) {
      while (
        queue.length > 0 &&
        (this.runningByModel.get(modelProfileId)?.size ?? 0) < this.effectiveLimit(modelProfileId)
      ) {
        const turn = queue.shift();
        if (turn) {
          this.start(turn);
        }
      }
    }

    if (emitPositions) {
      this.emitQueuePositions(modelProfileId);
    }
  }

  private start(turn: ScheduledTurn): void {
    const controller = new AbortController();
    this.running.set(turn.turnId, { turn, controller });

    let runningIds = this.runningByModel.get(turn.modelProfileId);
    if (!runningIds) {
      runningIds = new Set<string>();
      this.runningByModel.set(turn.modelProfileId, runningIds);
    }
    runningIds.add(turn.turnId);

    void this.execute(turn, controller);
  }

  private async execute(turn: ScheduledTurn, controller: AbortController): Promise<void> {
    try {
      if (this.queuedTurnIds.delete(turn.turnId)) {
        const queuedCallback = this.queuedCallbacks.get(turn.turnId);
        if (queuedCallback) {
          await queuedCallback;
          this.queuedCallbacks.delete(turn.turnId);
        }

        const queuePositionCallback = this.queuePositionCallbacks.get(turn.modelProfileId);
        if (queuePositionCallback) {
          await queuePositionCallback;
        }
      }
      await this.invoke(() => this.callbacks.onStarted(turn));
      if (!controller.signal.aborted) {
        await turn.run(controller.signal);
      }
    } catch {
      // Turn execution owns failure reporting. The scheduler only owns capacity.
    } finally {
      if (controller.signal.aborted) {
        await this.invoke(() => this.callbacks.onCancelled(turn, true));
      }
      this.settle(turn);
    }
  }

  private settle(turn: ScheduledTurn): void {
    const running = this.running.get(turn.turnId);
    if (!running || running.turn !== turn) {
      return;
    }

    this.running.delete(turn.turnId);
    this.cancellationRequested.delete(turn.turnId);

    const runningIds = this.runningByModel.get(turn.modelProfileId);
    runningIds?.delete(turn.turnId);
    if (runningIds?.size === 0) {
      this.runningByModel.delete(turn.modelProfileId);
    }

    this.drain(turn.modelProfileId, false);
    this.emitQueuePositions(turn.modelProfileId);
  }

  private emitQueuePositions(modelProfileId: string): void {
    const positions = new Map<string, number>();
    const queue = this.queues.get(modelProfileId) ?? [];
    queue.forEach((turn, index) => positions.set(turn.turnId, index + 1));

    const previous = this.queuePositionCallbacks.get(modelProfileId);
    if (previous) {
      this.trackQueuePositionCallback(
        modelProfileId,
        previous.then(() => this.invoke(() => this.callbacks.onQueuePositions(modelProfileId, positions))),
      );
      return;
    }

    const pending = this.invokeMaybeAsync(
      () => this.callbacks.onQueuePositions(modelProfileId, positions),
    );
    if (pending) {
      this.trackQueuePositionCallback(modelProfileId, pending);
    }
  }

  private trackQueuedCallback(turnId: string, pending: Promise<void>): void {
    this.queuedCallbacks.set(turnId, pending);
    void pending.then(() => {
      if (this.queuedCallbacks.get(turnId) === pending) {
        this.queuedCallbacks.delete(turnId);
      }
    });
  }

  private trackQueuePositionCallback(modelProfileId: string, pending: Promise<void>): void {
    this.queuePositionCallbacks.set(modelProfileId, pending);
    void pending.then(() => {
      if (this.queuePositionCallbacks.get(modelProfileId) === pending) {
        this.queuePositionCallbacks.delete(modelProfileId);
      }
    });
  }

  private invoke(callback: () => Promise<void> | void): Promise<void> {
    return this.invokeMaybeAsync(callback) ?? Promise.resolve();
  }

  private invokeMaybeAsync(callback: () => Promise<void> | void): Promise<void> | undefined {
    try {
      const result = callback();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Callback failures must not become unhandled rejections or leak a slot.
    }
    return undefined;
  }
}
