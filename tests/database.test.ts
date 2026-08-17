import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Item } from '../src/shared/domain';
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

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories = [];
});

describe('sqlite app database', () => {
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
        reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] },
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
