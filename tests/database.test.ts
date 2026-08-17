import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Item, ReasoningItem, ReasoningOutputMode, TurnRecord } from '../src/shared/domain';
import { openDatabase } from '../src/agent/database';

let tempDirectories: string[] = [];

function createDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'private-ai-db-'));
  tempDirectories.push(directory);
  return join(directory, 'app.sqlite');
}

function userItem(threadId: string, text: string, id = 'item-1', turnId = 'turn-1'): Item {
  return {
    id,
    threadId,
    turnId,
    kind: 'message',
    role: 'user',
    text,
    createdAt: '2026-08-17T00:00:00.000Z',
  };
}

function turnRecord(id: string, threadId: string, modelProfileId: string, status: TurnRecord['status']): TurnRecord {
  return {
    id,
    threadId,
    modelProfileId,
    status,
    createdAt: '2026-08-17T00:00:00.000Z',
    incomplete: true,
  };
}

function reasoningItem(turnId: string, threadId: string, mode: ReasoningOutputMode, text: string): ReasoningItem {
  return {
    id: `item-${turnId}-reasoning-${mode}`,
    threadId,
    turnId,
    kind: 'reasoning',
    mode,
    text,
    incomplete: true,
    createdAt: '2026-08-17T00:00:01.000Z',
  };
}

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories = [];
});

describe('sqlite app database', () => {
  it('preserves successful assistant history when migrating an exact pre-v3 database', () => {
    const path = createDbPath();
    createPreV3Database(path);

    const db = openDatabase(path);
    try {
      const snapshot = db.getSnapshot();

      expect(snapshot.turns).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'legacy-success', status: 'completed', incomplete: false }),
        expect.objectContaining({ id: 'legacy-unfinished', status: 'interrupted', incomplete: true }),
      ]));
      expect(snapshot.items['legacy-success-thread']).toContainEqual(expect.objectContaining({
        turnId: 'legacy-success',
        kind: 'message',
        role: 'assistant',
        text: 'historical answer',
        incomplete: false,
      }));
    } finally {
      db.close();
    }
  });

  it('merges reasoning fragments into one logical item', () => {
    const db = openDatabase(createDbPath());
    const thread = db.createThread('Reasoning');
    db.createTurn(turnRecord('turn-1', thread.id, 'model-1', 'running'));
    db.appendItem(reasoningItem('turn-1', thread.id, 'raw', '第一段'));
    db.appendItem(reasoningItem('turn-1', thread.id, 'raw', '第二段'));

    const reasoning = db.getSnapshot().items[thread.id].filter((item) => item.kind === 'reasoning');
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({ mode: 'raw', text: '第一段第二段', incomplete: true });
    db.close();
  });

  it('marks unfinished turns interrupted on reopen without replaying them', () => {
    const path = createDbPath();
    const first = openDatabase(path);
    const thread = first.createThread('Interrupted');
    first.createTurn(turnRecord('turn-1', thread.id, 'model-1', 'queued'));
    first.createTurn({ ...turnRecord('turn-completed', thread.id, 'model-1', 'completed'), incomplete: false });
    first.createTurn({ ...turnRecord('turn-failed', thread.id, 'model-1', 'failed'), incomplete: false });
    first.createTurn({ ...turnRecord('turn-cancelled', thread.id, 'model-1', 'cancelled'), incomplete: false });
    first.close();

    const second = openDatabase(path);
    expect(second.getSnapshot().turns).toContainEqual(expect.objectContaining({
      id: 'turn-1', status: 'interrupted', incomplete: true,
    }));
    expect(second.getSnapshot().turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'turn-completed', status: 'completed', incomplete: false }),
      expect.objectContaining({ id: 'turn-failed', status: 'failed', incomplete: false }),
      expect.objectContaining({ id: 'turn-cancelled', status: 'cancelled', incomplete: false }),
    ]));
    second.close();
  });

  it('keeps one reasoning and assistant row per streamed turn', () => {
    const db = openDatabase(createDbPath());
    const thread = db.createThread('Bounded stream');
    db.createTurn(turnRecord('turn-1', thread.id, 'model-1', 'running'));

    for (let index = 0; index < 100; index += 1) {
      db.appendItem(reasoningItem('turn-1', thread.id, 'raw', String(index)));
      db.appendItem({
        id: `item-turn-1-answer-${index}`,
        threadId: thread.id,
        turnId: 'turn-1',
        kind: 'message',
        role: 'assistant',
        text: String(index),
        incomplete: true,
        createdAt: `2026-08-17T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      });
    }

    const streamedItems = db.getSnapshot().items[thread.id].filter((item) => item.turnId === 'turn-1');
    expect(streamedItems.filter((item) => item.kind === 'reasoning' && item.mode === 'raw')).toHaveLength(1);
    expect(streamedItems.filter((item) => item.kind === 'message' && item.role === 'assistant')).toHaveLength(1);
    db.close();
  });

  it('completes a turn and its streamed payloads atomically', () => {
    const db = openDatabase(createDbPath());
    const thread = db.createThread('Complete stream');
    db.createTurn(turnRecord('turn-1', thread.id, 'model-1', 'running'));
    db.appendItem(reasoningItem('turn-1', thread.id, 'raw', 'thinking'));
    db.appendItem({
      id: 'item-turn-1-answer',
      threadId: thread.id,
      turnId: 'turn-1',
      kind: 'message',
      role: 'assistant',
      text: 'answer',
      incomplete: true,
      createdAt: '2026-08-17T00:00:02.000Z',
    });

    db.completeTurn('turn-1', '2026-08-17T00:00:03.000Z');

    expect(db.getSnapshot().turns).toContainEqual(expect.objectContaining({
      id: 'turn-1', status: 'completed', completedAt: '2026-08-17T00:00:03.000Z', incomplete: false,
    }));
    expect(db.getSnapshot().items[thread.id].filter((item) => item.turnId === 'turn-1')).toEqual([
      expect.objectContaining({ kind: 'reasoning', incomplete: false }),
      expect.objectContaining({ kind: 'message', role: 'assistant', incomplete: false }),
    ]);
    db.close();
  });

  it('updates only the supplied persisted turn lifecycle fields', () => {
    const db = openDatabase(createDbPath());
    const thread = db.createThread('Turn lifecycle');
    db.createTurn(turnRecord('turn-1', thread.id, 'model-1', 'queued'));

    db.updateTurn('turn-1', { status: 'running', startedAt: '2026-08-17T00:00:01.000Z' });

    expect(db.getSnapshot().turns).toContainEqual(expect.objectContaining({
      id: 'turn-1',
      modelProfileId: 'model-1',
      status: 'running',
      startedAt: '2026-08-17T00:00:01.000Z',
      incomplete: true,
    }));
    db.close();
  });

  it('persists a thread and items across reopen', () => {
    const dbPath = createDbPath();
    const first = openDatabase(dbPath);
    const thread = first.createThread('Deployment review');
    first.appendItem(userItem(thread.id, 'Inspect the release'));
    first.close();

    const second = openDatabase(dbPath);
    const snapshot = second.getSnapshot();

    expect(snapshot.threads[0]?.title).toBe('Deployment review');
    expect(snapshot.items[thread.id]).toHaveLength(1);
    second.close();
  });

  it('returns merged message history for only the selected thread', () => {
    const db = openDatabase(createDbPath());
    const firstThread = db.createThread('First');
    const secondThread = db.createThread('Second');
    db.appendItem(userItem(firstThread.id, 'first user'));
    db.appendItem({
      id: 'item-turn-1-assistant-1',
      threadId: firstThread.id,
      turnId: 'turn-1',
      kind: 'message',
      role: 'assistant',
      text: 'hello ',
      createdAt: '2026-08-17T00:00:01.000Z',
    });
    db.appendItem({
      id: 'item-turn-1-assistant-2',
      threadId: firstThread.id,
      turnId: 'turn-1',
      kind: 'message',
      role: 'assistant',
      text: 'there',
      createdAt: '2026-08-17T00:00:02.000Z',
    });
    db.appendItem(userItem(secondThread.id, 'second user', 'item-2', 'turn-2'));

    expect(db.getThreadMessages(firstThread.id).map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:first user',
      'assistant:hello there',
    ]);
    db.close();
  });

  it('stores streamed assistant fragments as one snapshot message', () => {
    const db = openDatabase(createDbPath());
    try {
      const thread = db.createThread('Streaming');
      db.appendItem(userItem(thread.id, 'hello'));
      db.appendItem({
        id: 'item-turn-1-assistant-1',
        threadId: thread.id,
        turnId: 'turn-1',
        kind: 'message',
        role: 'assistant',
        text: 'stream ',
        createdAt: '2026-08-17T00:00:01.000Z',
      });
      db.appendItem({
        id: 'item-turn-1-assistant-2',
        threadId: thread.id,
        turnId: 'turn-1',
        kind: 'message',
        role: 'assistant',
        text: 'complete',
        createdAt: '2026-08-17T00:00:02.000Z',
      });

      const assistantItems = db
        .getSnapshot()
        .items[thread.id]?.filter((item) => item.kind === 'message' && item.role === 'assistant');
      expect(assistantItems).toHaveLength(1);
      expect(assistantItems?.[0]).toMatchObject({ text: 'stream complete', turnId: 'turn-1' });
    } finally {
      db.close();
    }
  });

  it('compacts legacy assistant fragments when reopening the database', () => {
    const dbPath = createDbPath();
    const first = openDatabase(dbPath);
    const thread = first.createThread('Legacy streaming');
    first.appendItem(userItem(thread.id, 'hello'));
    first.appendItem({
      id: 'legacy-assistant-1',
      threadId: thread.id,
      turnId: 'turn-1',
      kind: 'message',
      role: 'assistant',
      text: 'old ',
      createdAt: '2026-08-17T00:00:01.000Z',
    });
    first.close();

    const legacy = new DatabaseSync(dbPath);
    const legacyItem: Item = {
      id: 'legacy-assistant-2',
      threadId: thread.id,
      turnId: 'turn-1',
      kind: 'message',
      role: 'assistant',
      text: 'fragments',
      createdAt: '2026-08-17T00:00:02.000Z',
    };
    legacy
      .prepare('INSERT INTO items (id, thread_id, turn_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(legacyItem.id, legacyItem.threadId, legacyItem.turnId, legacyItem.kind, JSON.stringify(legacyItem), legacyItem.createdAt);
    legacy.prepare('DELETE FROM schema_migrations WHERE version = 2').run();
    legacy.close();

    const second = openDatabase(dbPath);
    const assistantItems = second
      .getSnapshot()
      .items[thread.id]?.filter((item) => item.kind === 'message' && item.role === 'assistant');
    expect(assistantItems).toHaveLength(1);
    expect(assistantItems?.[0]).toMatchObject({ text: 'old fragments', turnId: 'turn-1' });
    second.close();
  });

  it('creates chat groups and hides deleted chats from snapshots and context', () => {
    const db = openDatabase(createDbPath());
    try {
      const group = db.createGroup('运维问答');
      const keptThread = db.createThread('Redis', group.id);
      const deletedThread = db.createThread('MySQL', group.id);
      db.appendItem(userItem(keptThread.id, 'redis question', 'item-kept', 'turn-kept'));
      db.appendItem(userItem(deletedThread.id, 'mysql question', 'item-deleted', 'turn-deleted'));

      db.deleteThread(deletedThread.id);
      const snapshotAfterThreadDelete = db.getSnapshot();
      expect(snapshotAfterThreadDelete.groups.find((candidate) => candidate.id === group.id)).toMatchObject({
        id: group.id,
        name: '运维问答',
      });
      expect(snapshotAfterThreadDelete.threads.map((thread) => thread.id)).toContain(keptThread.id);
      expect(snapshotAfterThreadDelete.threads.map((thread) => thread.id)).not.toContain(deletedThread.id);
      expect(db.getThreadMessages(deletedThread.id)).toEqual([]);

      db.deleteGroup(group.id);
      const snapshotAfterGroupDelete = db.getSnapshot();
      expect(snapshotAfterGroupDelete.groups.map((candidate) => candidate.id)).not.toContain(group.id);
      expect(snapshotAfterGroupDelete.threads.map((thread) => thread.id)).not.toContain(keptThread.id);
    } finally {
      db.close();
    }
  });

  it('persists model profiles while redacting API keys from snapshots', () => {
    const dbPath = createDbPath();
    const first = openDatabase(dbPath);

    const saved = first.saveModelProfile({
      name: 'AIFAR Qwen',
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'Qwen3.5-9B',
      apiKey: 'local-not-used',
      isDefault: true,
    });

    const firstSnapshot = first.getSnapshot();
    expect(firstSnapshot.modelProfiles[0]).toMatchObject({
      id: saved.id,
      name: 'AIFAR Qwen',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'Qwen3.5-9B',
      apiKeyConfigured: true,
      isDefault: true,
    });
    expect(firstSnapshot.modelProfiles[0]).not.toHaveProperty('apiKey');
    first.close();

    const second = openDatabase(dbPath);
    const snapshot = second.getSnapshot();
    expect(snapshot.modelProfiles[0]?.apiKeyConfigured).toBe(true);
    expect(snapshot.settings.activeModelProfileId).toBe(saved.id);
    expect(second.getModelProfileForRuntime(saved.id)?.apiKey).toBe('local-not-used');
    second.close();
  });

  it('persists runtime settings across reopen', () => {
    const dbPath = createDbPath();
    const first = openDatabase(dbPath);
    expect(first.getSnapshot().settings).toMatchObject({ showModelMetrics: true, contextMessageLimit: 20 });

    first.updateSettings({ showModelMetrics: false, contextMessageLimit: 50 });
    first.close();

    const second = openDatabase(dbPath);
    expect(second.getSnapshot().settings).toMatchObject({ showModelMetrics: false, contextMessageLimit: 50 });
    second.close();
  });

  it('clamps runtime context message limits', () => {
    const db = openDatabase(createDbPath());
    expect(db.updateSettings({ contextMessageLimit: -1 }).contextMessageLimit).toBe(1);
    expect(db.updateSettings({ contextMessageLimit: 500 }).contextMessageLimit).toBe(200);
    db.close();
  });

  it('persists model profile reasoning settings while redacting API keys', () => {
    const db = openDatabase(createDbPath());
    const saved = db.saveModelProfile({
      name: 'Local reasoning model',
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'reasoner',
      apiKey: 'secret',
      reasoning: { mode: 'enabled', protocol: 'qwen', effort: 'xhigh', display: 'auto' },
      responseSpeed: 'fast',
      capabilities: {
        text: true,
        vision: false,
        longContext: false,
        reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] },
        concurrency: { defaultLimit: 1, configurable: true, maxLimit: 32 },
        streaming: true,
        usage: { tokens: true, reasoningTokens: true },
      },
    });

    expect(saved.reasoning).toEqual({ mode: 'enabled', protocol: 'qwen', effort: 'xhigh', display: 'auto' });
    expect(saved.responseSpeed).toBe('fast');
    expect(saved).not.toHaveProperty('apiKey');
    expect(db.getModelProfileForRuntime(saved.id)?.reasoning).toEqual({ mode: 'enabled', protocol: 'qwen', effort: 'xhigh', display: 'auto' });
    expect(db.getModelProfileForRuntime(saved.id)?.responseSpeed).toBe('fast');
    db.close();
  });

  it('persists normalized model profile concurrency across reopen', () => {
    const dbPath = createDbPath();
    const first = openDatabase(dbPath);
    const saved = first.saveModelProfile({
      name: 'Concurrent model',
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'concurrent-model',
      maxConcurrency: 99,
      capabilities: {
        concurrency: { defaultLimit: 1, configurable: true, maxLimit: 32 },
      },
      isDefault: true,
    });
    expect(saved.maxConcurrency).toBe(32);
    first.close();

    const second = openDatabase(dbPath);
    expect(second.getModelProfileForRuntime(saved.id)?.maxConcurrency).toBe(32);
    second.close();
  });

  it('preserves nested capability declarations when saving a partial update', () => {
    const db = openDatabase(createDbPath());
    const saved = db.saveModelProfile({
      name: 'Partial capability model',
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'partial-model',
      capabilities: {
        vision: true,
        reasoning: { inputMode: 'effort', effortOptions: ['low', 'max'], outputModes: ['summary'], defaultEffort: 'max' },
        usage: { tokens: false, reasoningTokens: true },
      },
      isDefault: true,
    });

    const updated = db.saveModelProfile({
      id: saved.id,
      name: saved.name,
      provider: saved.provider,
      baseUrl: saved.baseUrl,
      model: saved.model,
      capabilities: {
        reasoning: { outputModes: ['raw'] },
        usage: { reasoningTokens: false },
      },
      isDefault: true,
    });

    expect(updated.capabilities).toMatchObject({
      vision: true,
      reasoning: { inputMode: 'effort', effortOptions: ['low', 'max'], outputModes: ['raw'], defaultEffort: 'max' },
      usage: { tokens: false, reasoningTokens: false },
    });
    db.close();
  });

  it('stores the selected model profile on a thread', () => {
    const db = openDatabase(createDbPath());
    const profile = db.saveModelProfile({
      name: 'AIFAR Qwen',
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'Qwen3.5-9B',
    });
    const thread = db.createThread('Model test');

    db.setThreadModel(thread.id, profile.id);

    const snapshot = db.getSnapshot();
    expect(snapshot.threads.find((candidate) => candidate.id === thread.id)?.modelProfileId).toBe(profile.id);
    db.close();
  });

  it('persists the selected language across reopen', () => {
    const dbPath = createDbPath();
    const first = openDatabase(dbPath);
    first.setLanguage('zh-CN');
    first.close();

    const second = openDatabase(dbPath);
    expect(second.getSnapshot().settings.language).toBe('zh-CN');
    second.close();
  });
});

function createPreV3Database(path: string): void {
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      group_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      model_profile_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE turns (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations (version, applied_at) VALUES
      (1, '2026-08-16T00:00:00.000Z'),
      (2, '2026-08-16T00:00:01.000Z');
  `);

  const insertThread = legacy.prepare(`
    INSERT INTO threads (id, group_id, title, status, model_profile_id, created_at, updated_at, deleted_at)
    VALUES (?, NULL, ?, 'ready', NULL, ?, ?, NULL)
  `);
  const insertTurn = legacy.prepare(`
    INSERT INTO turns (id, thread_id, status, created_at, updated_at)
    VALUES (?, ?, 'running', ?, ?)
  `);
  const insertItem = legacy.prepare(`
    INSERT INTO items (id, thread_id, turn_id, kind, payload, created_at)
    VALUES (?, ?, ?, 'message', ?, ?)
  `);
  const createdAt = '2026-08-16T01:00:00.000Z';
  insertThread.run('legacy-success-thread', 'Successful history', createdAt, createdAt);
  insertTurn.run('legacy-success', 'legacy-success-thread', createdAt, createdAt);
  insertItem.run('legacy-success-user', 'legacy-success-thread', 'legacy-success', JSON.stringify({
    id: 'legacy-success-user', threadId: 'legacy-success-thread', turnId: 'legacy-success',
    kind: 'message', role: 'user', text: 'historical question', createdAt,
  }), createdAt);
  insertItem.run('legacy-success-assistant', 'legacy-success-thread', 'legacy-success', JSON.stringify({
    id: 'legacy-success-assistant', threadId: 'legacy-success-thread', turnId: 'legacy-success',
    kind: 'message', role: 'assistant', text: 'historical answer', createdAt: '2026-08-16T01:00:01.000Z',
  }), '2026-08-16T01:00:01.000Z');

  insertThread.run('legacy-unfinished-thread', 'Unfinished history', createdAt, createdAt);
  insertTurn.run('legacy-unfinished', 'legacy-unfinished-thread', createdAt, createdAt);
  insertItem.run('legacy-unfinished-user', 'legacy-unfinished-thread', 'legacy-unfinished', JSON.stringify({
    id: 'legacy-unfinished-user', threadId: 'legacy-unfinished-thread', turnId: 'legacy-unfinished',
    kind: 'message', role: 'user', text: 'unfinished question', createdAt,
  }), createdAt);
  legacy.close();
}
