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
  onCancelling?(turn: ScheduledTurn): Promise<void> | void;
  onCancelled(turn: ScheduledTurn, wasRunning: boolean): Promise<void> | void;
  onQueuePositions(
    modelProfileId: string,
    positions: ReadonlyMap<string, number>,
  ): Promise<void> | void;
}

type TurnSlot = {
  turn: ScheduledTurn;
  controller: AbortController;
};

type ModelOperationKind = 'drain';

type ModelOperation = {
  kind?: ModelOperationKind;
  run(): Promise<void> | void;
};

export class ModelTurnScheduler {
  private readonly queues = new Map<string, ScheduledTurn[]>();
  private readonly reserved = new Map<string, TurnSlot>();
  private readonly running = new Map<string, TurnSlot>();
  private readonly runningByModel = new Map<string, Set<string>>();
  private readonly activeThreads = new Set<string>();
  private readonly cancellingBeforeStart = new Set<string>();
  private readonly modelOperations = new Map<string, ModelOperation[]>();
  private readonly processingModels = new Set<string>();

  constructor(
    private readonly limitFor: (modelProfileId: string) => number,
    private readonly callbacks: SchedulerCallbacks,
  ) {}

  enqueue(turn: ScheduledTurn): void {
    if (this.activeThreads.has(turn.threadId)) {
      throw new Error(`Thread "${turn.threadId}" already has an active turn`);
    }

    this.activeThreads.add(turn.threadId);
    const queue = this.queueFor(turn.modelProfileId);
    const mustQueue = queue.length > 0 || this.slotCount(turn.modelProfileId) >= this.effectiveLimit(turn.modelProfileId);
    queue.push(turn);

    if (!mustQueue) {
      this.scheduleDrain(turn.modelProfileId);
      return;
    }

    this.scheduleModelOperation(turn.modelProfileId, {
      run: () => {
        const position = this.positionOf(turn);
        return position === undefined
          ? undefined
          : this.invoke(() => this.callbacks.onQueued(turn, position));
      },
    });
    this.scheduleQueuePositions(turn.modelProfileId);
    this.movePendingOperationToTail(turn.modelProfileId, 'drain');
  }

  cancel(turnId: string): boolean {
    if (this.cancellingBeforeStart.has(turnId)) {
      return false;
    }

    const running = this.running.get(turnId);
    if (running) {
      if (running.controller.signal.aborted) {
        return false;
      }
      running.controller.abort();
      this.scheduleModelOperation(running.turn.modelProfileId, {
        run: () => this.invoke(() => this.callbacks.onCancelling?.(running.turn)),
      });
      return true;
    }

    const reserved = this.reserved.get(turnId);
    if (reserved) {
      this.reserved.delete(turnId);
      reserved.controller.abort();
      this.releaseSlot(reserved.turn);
      this.schedulePreStartCancellation(reserved.turn, false);
      return true;
    }

    for (const [modelProfileId, queue] of this.queues) {
      const index = queue.findIndex((turn) => turn.turnId === turnId);
      if (index < 0) {
        continue;
      }

      const [turn] = queue.splice(index, 1);
      this.schedulePreStartCancellation(turn, true);
      this.movePendingOperationToTail(modelProfileId, 'drain');
      return true;
    }

    return false;
  }

  updateLimit(modelProfileId: string): void {
    this.scheduleDrain(modelProfileId);
  }

  hasActiveThread(threadId: string): boolean {
    return this.activeThreads.has(threadId);
  }

  private queueFor(modelProfileId: string): ScheduledTurn[] {
    let queue = this.queues.get(modelProfileId);
    if (!queue) {
      queue = [];
      this.queues.set(modelProfileId, queue);
    }
    return queue;
  }

  private positionOf(turn: ScheduledTurn): number | undefined {
    const index = (this.queues.get(turn.modelProfileId) ?? []).indexOf(turn);
    return index < 0 ? undefined : index + 1;
  }

  private effectiveLimit(modelProfileId: string): number {
    const configured = this.limitFor(modelProfileId);
    return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 1;
  }

  private slotCount(modelProfileId: string): number {
    return this.runningByModel.get(modelProfileId)?.size ?? 0;
  }

  private scheduleDrain(modelProfileId: string): void {
    this.scheduleUniqueModelOperation(modelProfileId, {
      kind: 'drain',
      run: () => this.drain(modelProfileId),
    });
  }

  private async drain(modelProfileId: string): Promise<void> {
    const queue = this.queues.get(modelProfileId);
    const promoted: TurnSlot[] = [];
    while (
      queue &&
      queue.length > 0 &&
      this.slotCount(modelProfileId) < this.effectiveLimit(modelProfileId)
    ) {
      const turn = queue.shift();
      if (!turn || !this.activeThreads.has(turn.threadId)) {
        continue;
      }

      const slot = { turn, controller: new AbortController() };
      this.reserved.set(turn.turnId, slot);
      this.reserveSlot(turn);
      promoted.push(slot);
    }

    if (promoted.length === 0) {
      return;
    }

    await this.notifyQueuePositions(modelProfileId);
    const excess: ScheduledTurn[] = [];
    for (const slot of promoted) {
      if (this.reserved.get(slot.turn.turnId) !== slot) {
        continue;
      }

      if (this.runningCount(modelProfileId) >= this.effectiveLimit(modelProfileId)) {
        this.reserved.delete(slot.turn.turnId);
        this.releaseSlot(slot.turn);
        excess.push(slot.turn);
        continue;
      }

      this.reserved.delete(slot.turn.turnId);
      this.running.set(slot.turn.turnId, slot);
      await this.invoke(() => this.callbacks.onStarted(slot.turn));
      void this.execute(slot);
    }

    if (excess.length > 0) {
      this.queueFor(modelProfileId).unshift(...excess);
      await this.notifyQueuePositions(modelProfileId);
    }
  }

  private reserveSlot(turn: ScheduledTurn): void {
    let turnIds = this.runningByModel.get(turn.modelProfileId);
    if (!turnIds) {
      turnIds = new Set<string>();
      this.runningByModel.set(turn.modelProfileId, turnIds);
    }
    turnIds.add(turn.turnId);
  }

  private releaseSlot(turn: ScheduledTurn): void {
    const turnIds = this.runningByModel.get(turn.modelProfileId);
    turnIds?.delete(turn.turnId);
    if (turnIds?.size === 0) {
      this.runningByModel.delete(turn.modelProfileId);
    }
  }

  private runningCount(modelProfileId: string): number {
    let count = 0;
    for (const { turn } of this.running.values()) {
      if (turn.modelProfileId === modelProfileId) {
        count += 1;
      }
    }
    return count;
  }

  private async execute(slot: TurnSlot): Promise<void> {
    try {
      if (!slot.controller.signal.aborted) {
        await slot.turn.run(slot.controller.signal);
      }
    } catch {
      // Turn execution owns failure reporting. The scheduler only owns capacity.
    } finally {
      this.scheduleModelOperation(slot.turn.modelProfileId, {
        run: () => this.finishRunning(slot),
      });
    }
  }

  private async finishRunning(slot: TurnSlot): Promise<void> {
    if (this.running.get(slot.turn.turnId) !== slot) {
      return;
    }

    if (slot.controller.signal.aborted) {
      await this.invoke(() => this.callbacks.onCancelled(slot.turn, true));
    }
    this.settle(slot);
  }

  private settle(slot: TurnSlot): void {
    if (this.running.get(slot.turn.turnId) !== slot) {
      return;
    }

    this.running.delete(slot.turn.turnId);
    this.releaseSlot(slot.turn);
    this.activeThreads.delete(slot.turn.threadId);
    this.scheduleDrain(slot.turn.modelProfileId);
  }

  private schedulePreStartCancellation(turn: ScheduledTurn, queueChanged: boolean): void {
    this.cancellingBeforeStart.add(turn.turnId);
    this.scheduleModelOperation(turn.modelProfileId, {
      run: async () => {
        await this.invoke(() => this.callbacks.onCancelled(turn, false));
        this.cancellingBeforeStart.delete(turn.turnId);
        this.activeThreads.delete(turn.threadId);
      },
    });
    if (queueChanged) {
      this.scheduleQueuePositions(turn.modelProfileId);
    }
    this.scheduleDrain(turn.modelProfileId);
  }

  private scheduleQueuePositions(modelProfileId: string): void {
    const positions = this.queuePositions(modelProfileId);
    this.scheduleModelOperation(modelProfileId, {
      run: () => this.invoke(() => this.callbacks.onQueuePositions(modelProfileId, positions)),
    });
  }

  private notifyQueuePositions(modelProfileId: string): Promise<void> {
    const positions = this.queuePositions(modelProfileId);
    return this.invoke(() => this.callbacks.onQueuePositions(modelProfileId, positions));
  }

  private queuePositions(modelProfileId: string): ReadonlyMap<string, number> {
    const positions = new Map<string, number>();
    const queue = this.queues.get(modelProfileId) ?? [];
    queue.forEach((turn, index) => positions.set(turn.turnId, index + 1));
    return positions;
  }

  private scheduleUniqueModelOperation(modelProfileId: string, operation: ModelOperation): void {
    const operations = this.operationQueueFor(modelProfileId);
    const existingIndex = operations.findIndex((candidate) => candidate.kind === operation.kind);
    if (existingIndex >= 0) {
      const [existing] = operations.splice(existingIndex, 1);
      operations.push(existing);
      return;
    }
    operations.push(operation);
    this.processModelOperations(modelProfileId);
  }

  private movePendingOperationToTail(modelProfileId: string, kind: ModelOperationKind): void {
    const operations = this.modelOperations.get(modelProfileId);
    const index = operations?.findIndex((operation) => operation.kind === kind) ?? -1;
    if (!operations || index < 0) {
      return;
    }
    const [operation] = operations.splice(index, 1);
    operations.push(operation);
  }

  private scheduleModelOperation(modelProfileId: string, operation: ModelOperation): void {
    this.operationQueueFor(modelProfileId).push(operation);
    this.processModelOperations(modelProfileId);
  }

  private operationQueueFor(modelProfileId: string): ModelOperation[] {
    let operations = this.modelOperations.get(modelProfileId);
    if (!operations) {
      operations = [];
      this.modelOperations.set(modelProfileId, operations);
    }
    return operations;
  }

  private processModelOperations(modelProfileId: string): void {
    if (this.processingModels.has(modelProfileId)) {
      return;
    }
    this.processingModels.add(modelProfileId);
    this.continueModelOperations(modelProfileId);
  }

  private continueModelOperations(modelProfileId: string): void {
    const operations = this.modelOperations.get(modelProfileId);
    while (operations && operations.length > 0) {
      const operation = operations.shift();
      if (!operation) {
        continue;
      }

      const pending = this.invokeMaybeAsync(operation.run);
      if (pending) {
        void pending.then(() => this.continueModelOperations(modelProfileId));
        return;
      }
    }

    this.processingModels.delete(modelProfileId);
    this.modelOperations.delete(modelProfileId);
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
