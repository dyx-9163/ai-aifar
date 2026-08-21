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
      // Legacy threads migrate into the unlinked section without backfill.
      expect(snapshot.threads).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'legacy-success-thread', workspaceId: undefined, pinned: false }),
      ]));
    } finally {
      db.close();
    }
  });

  it('repairs the v1-v4 state produced when 088906a interrupted successful legacy history', () => {
    const path = createDbPath();
    createMislabelledV4Database(path);

    const db = openDatabase(path);
    try {
      const snapshot = db.getSnapshot();
      expect(snapshot.turns).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'mislabelled-success', status: 'completed', incomplete: false }),
        expect.objectContaining({ id: 'genuine-partial', status: 'interrupted', incomplete: true }),
      ]));
      expect(snapshot.items['v4-history-thread']).toEqual(expect.arrayContaining([
        expect.objectContaining({
          turnId: 'mislabelled-success', role: 'assistant', text: 'complete legacy answer', incomplete: false,
        }),
        expect.objectContaining({
          turnId: 'genuine-partial', role: 'assistant', text: 'partial streamed answer', incomplete: true,
        }),
      ]));
    } finally {
      db.close();
    }

    const migrated = new DatabaseSync(path);
    try {
      expect(migrated.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
        { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 },
      ]);
    } finally {
      migrated.close();
    }
  });

  it('seeds one default local Qwen preset in a fresh database', () => {
    const db = openDatabase(createDbPath());
    try {
      const snapshot = db.getSnapshot();
      expect(snapshot.modelProfiles).toHaveLength(1);
      expect(snapshot.modelProfiles[0]).toMatchObject({
        id: 'local-qwen35',
        name: 'Local Qwen3.5-9B',
        provider: 'openai-compatible',
        deploymentType: 'private',
        runtimeType: 'llama.cpp',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'Qwen3.5-9B',
        maxConcurrency: 1,
        maxOutputTokens: 8192,
        reasoning: { mode: 'disabled', protocol: 'qwen', display: 'auto' },
        capabilities: { reasoning: { inputMode: 'toggle', outputModes: ['raw'] } },
        isDefault: true,
      });
      expect(snapshot.modelProfiles[0]).not.toHaveProperty('apiKey');
      expect(snapshot.settings.activeModelProfileId).toBe('local-qwen35');
    } finally {
      db.close();
    }
  });

  it('does not duplicate the local Qwen preset when reopened', () => {
    const path = createDbPath();
    const first = openDatabase(path);
    first.close();

    const second = openDatabase(path);
    try {
      expect(second.getSnapshot().modelProfiles.filter((profile) =>
        profile.provider === 'openai-compatible' &&
        profile.baseUrl === 'http://127.0.0.1:8080/v1' &&
        profile.model === 'Qwen3.5-9B')).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it('seeds the preset without replacing an existing custom default', () => {
    const path = createDbPath();
    createV5ModelProfileDatabase(path);
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`
        DELETE FROM model_profiles WHERE id = 'legacy-local';
        UPDATE model_profiles SET is_default = CASE WHEN id = 'local-custom' THEN 1 ELSE 0 END;
      `);
    } finally {
      legacy.close();
    }

    const db = openDatabase(path);
    try {
      const snapshot = db.getSnapshot();
      expect(snapshot.modelProfiles.find((profile) => profile.id === 'local-custom')).toMatchObject({
        model: 'my-custom-model',
        isDefault: true,
      });
      expect(snapshot.modelProfiles.find((profile) => profile.id === 'local-qwen35')).toMatchObject({
        model: 'Qwen3.5-9B',
        isDefault: false,
      });
      expect(snapshot.settings.activeModelProfileId).toBe('local-custom');
    } finally {
      db.close();
    }
  });

  it('uses a deterministic fallback ID without overwriting a custom row that owns the preset ID', () => {
    const path = createDbPath();
    createV5ModelProfileDatabase(path);
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`
        DELETE FROM model_profiles WHERE id = 'legacy-local';
        UPDATE model_profiles SET is_default = CASE WHEN id = 'local-custom' THEN 1 ELSE 0 END;
        INSERT INTO model_profiles (
          id, name, provider, base_url, model, api_key, capabilities, reasoning,
          max_concurrency, response_speed, is_default, created_at, updated_at
        ) VALUES (
          'local-qwen35', 'Reserved ID custom model', 'openai-compatible', 'https://custom.example.com/v1',
          'custom-collision-model', 'collision-secret', '{"marker":"collision"}',
          '{"mode":"disabled","protocol":"none","display":"auto"}', 4, 'quality', 0,
          '2026-08-17T00:00:03.000Z', '2026-08-17T00:00:03.000Z'
        );
      `);
    } finally {
      legacy.close();
    }

    const first = openDatabase(path);
    try {
      expect(first.getModelProfileForRuntime('local-qwen35')).toMatchObject({
        id: 'local-qwen35',
        name: 'Reserved ID custom model',
        baseUrl: 'https://custom.example.com/v1',
        model: 'custom-collision-model',
        apiKey: 'collision-secret',
        maxConcurrency: 4,
      });
      expect(first.getSnapshot().modelProfiles.filter((profile) =>
        profile.provider === 'openai-compatible' &&
        profile.baseUrl === 'http://127.0.0.1:8080/v1' &&
        profile.model === 'Qwen3.5-9B')).toEqual([
        expect.objectContaining({ id: 'local-qwen35-2', isDefault: false }),
      ]);
    } finally {
      first.close();
    }

    const second = openDatabase(path);
    try {
      expect(second.getSnapshot().modelProfiles.map((profile) => profile.id).sort()).toEqual([
        'local-custom',
        'local-qwen35',
        'local-qwen35-2',
        'remote-placeholder',
      ]);
      expect(second.getSnapshot().modelProfiles.filter((profile) =>
        profile.baseUrl === 'http://127.0.0.1:8080/v1' && profile.model === 'Qwen3.5-9B')).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it('repairs only the exact v5 local placeholder while preserving identity, default, and API key', () => {
    const path = createDbPath();
    createV5ModelProfileDatabase(path);

    const db = openDatabase(path);
    try {
      const snapshot = db.getSnapshot();
      const repaired = snapshot.modelProfiles.find((profile) => profile.id === 'legacy-local');
      expect(repaired).toMatchObject({
        id: 'legacy-local',
        name: 'Legacy local endpoint',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'Qwen3.5-9B',
        maxConcurrency: 1,
        maxOutputTokens: 8192,
        reasoning: { mode: 'disabled', protocol: 'qwen', display: 'auto' },
        capabilities: { reasoning: { inputMode: 'toggle', outputModes: ['raw'] } },
        isDefault: true,
        createdAt: '2026-08-17T00:00:00.000Z',
        apiKeyConfigured: true,
      });
      expect(repaired).not.toHaveProperty('apiKey');
      expect(db.getModelProfileForRuntime('legacy-local')?.apiKey).toBe('keep-this-secret');
      expect(snapshot.settings.activeModelProfileId).toBe('legacy-local');
      expect(snapshot.modelProfiles.filter((profile) => profile.model === 'Qwen3.5-9B')).toHaveLength(1);
    } finally {
      db.close();
    }

    const migrated = new DatabaseSync(path);
    try {
      expect(migrated.prepare(`
        SELECT id, name, provider, base_url, model, api_key, capabilities, reasoning,
               max_concurrency, response_speed, is_default, created_at, updated_at
        FROM model_profiles
        WHERE id IN ('remote-placeholder', 'local-custom')
        ORDER BY id
      `).all()).toEqual([
        {
          id: 'local-custom',
          name: 'Custom local model',
          provider: 'openai-compatible',
          base_url: 'http://127.0.0.1:8080/v1',
          model: 'my-custom-model',
          api_key: 'custom-key',
          capabilities: '{"marker":"local-custom"}',
          reasoning: '{"mode":"disabled","protocol":"none","display":"auto"}',
          max_concurrency: 3,
          response_speed: 'quality',
          is_default: 0,
          created_at: '2026-08-17T00:00:02.000Z',
          updated_at: '2026-08-17T00:00:02.000Z',
        },
        {
          id: 'remote-placeholder',
          name: 'Remote placeholder',
          provider: 'openai-compatible',
          base_url: 'https://models.example.com/v1',
          model: 'your-model-name',
          api_key: 'remote-key',
          capabilities: '{"marker":"remote-placeholder"}',
          reasoning: '{"mode":"disabled","protocol":"none","display":"auto"}',
          max_concurrency: 2,
          response_speed: 'fast',
          is_default: 0,
          created_at: '2026-08-17T00:00:01.000Z',
          updated_at: '2026-08-17T00:00:01.000Z',
        },
      ]);
      expect(migrated.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
        { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 },
      ]);
    } finally {
      migrated.close();
    }
  });

  it('retains and narrowly repairs multiple exact legacy local placeholders', () => {
    const path = createDbPath();
    createV5ModelProfileDatabase(path);
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`
        INSERT INTO model_profiles (
          id, name, provider, base_url, model, api_key, capabilities, reasoning,
          max_concurrency, response_speed, is_default, created_at, updated_at
        ) VALUES (
          'legacy-local-copy', 'Second legacy local endpoint', 'openai-compatible',
          'http://127.0.0.1:8080/v1', 'your-model-name', 'second-secret',
          '{"marker":"second-legacy"}', '{"mode":"auto","protocol":"none","display":"summary"}',
          5, 'fast', 0, '2026-08-17T00:00:04.000Z', '2026-08-17T00:00:04.000Z'
        );
      `);
    } finally {
      legacy.close();
    }

    const db = openDatabase(path);
    try {
      const snapshot = db.getSnapshot();
      const repaired = snapshot.modelProfiles
        .filter((profile) => profile.baseUrl === 'http://127.0.0.1:8080/v1' && profile.model === 'Qwen3.5-9B')
        .sort((left, right) => left.id.localeCompare(right.id));
      expect(repaired).toEqual([
        expect.objectContaining({ id: 'legacy-local', name: 'Legacy local endpoint', isDefault: true }),
        expect.objectContaining({ id: 'legacy-local-copy', name: 'Second legacy local endpoint', isDefault: false }),
      ]);
      expect(db.getModelProfileForRuntime('legacy-local')?.apiKey).toBe('keep-this-secret');
      expect(db.getModelProfileForRuntime('legacy-local-copy')?.apiKey).toBe('second-secret');
      expect(snapshot.settings.activeModelProfileId).toBe('legacy-local');
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
    first.upsertToolItem({
      id: 'item-turn-1-tool-command',
      threadId: thread.id,
      turnId: 'turn-1',
      kind: 'tool',
      toolId: 'command',
      title: 'run_command',
      status: 'running',
      createdAt: '2026-08-17T00:00:01.000Z',
    });
    first.createTurn({ ...turnRecord('turn-completed', thread.id, 'model-1', 'completed'), incomplete: false });
    first.createTurn({ ...turnRecord('turn-failed', thread.id, 'model-1', 'failed'), incomplete: false });
    first.createTurn({ ...turnRecord('turn-cancelled', thread.id, 'model-1', 'cancelled'), incomplete: false });
    first.close();

    const second = openDatabase(path);
    expect(second.getSnapshot().turns).toContainEqual(expect.objectContaining({
      id: 'turn-1', status: 'interrupted', incomplete: true,
    }));
    expect(second.getSnapshot().items[thread.id]).toContainEqual(expect.objectContaining({
      id: 'item-turn-1-tool-command', status: 'interrupted',
    }));
    expect(second.getSnapshot().turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'turn-completed', status: 'completed', incomplete: false }),
      expect.objectContaining({ id: 'turn-failed', status: 'failed', incomplete: false }),
      expect.objectContaining({ id: 'turn-cancelled', status: 'cancelled', incomplete: false }),
    ]));
    second.close();
  });

  it('repairs pending approvals that already belong to terminal turns on startup', () => {
    const path = createDbPath();
    const first = openDatabase(path);
    const thread = first.createThread('Terminal approvals');
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const turnId = `turn-${status}`;
      first.createTurn({
        ...turnRecord(turnId, thread.id, 'model-1', status),
        completedAt: '2026-08-17T00:00:03.000Z',
        incomplete: status !== 'completed',
      });
      first.upsertApproval({
        id: `approval-${status}`,
        threadId: thread.id,
        turnId,
        title: status,
        description: 'Stale pending approval',
        status: 'pending',
        createdAt: '2026-08-17T00:00:02.000Z',
      });
    }
    first.close();

    const second = openDatabase(path);
    try {
      expect(second.getSnapshot().approvals).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'approval-completed', status: 'rejected', respondedAt: expect.any(String) }),
        expect.objectContaining({ id: 'approval-failed', status: 'rejected', respondedAt: expect.any(String) }),
        expect.objectContaining({ id: 'approval-cancelled', status: 'rejected', respondedAt: expect.any(String) }),
      ]));
    } finally {
      second.close();
    }
  });

  it('rolls back turn failure when rejecting its pending approval cannot commit', () => {
    const path = createDbPath();
    const db = openDatabase(path);
    try {
      const thread = db.createThread('Atomic failure');
      db.createTurn(turnRecord('turn-atomic', thread.id, 'model-1', 'running'));
      db.upsertApproval({
        id: 'approval-atomic', threadId: thread.id, turnId: 'turn-atomic', title: 'Approve',
        description: 'Must settle atomically', status: 'pending', createdAt: '2026-08-17T00:00:01.000Z',
      });
      const raw = new DatabaseSync(path);
      raw.exec(`
        CREATE TRIGGER reject_approval_settlement
        BEFORE UPDATE ON approvals
        WHEN OLD.id = 'approval-atomic'
        BEGIN
          SELECT RAISE(ABORT, 'forced approval failure');
        END;
      `);
      raw.close();

      expect(() => db.failTurn('turn-atomic', '2026-08-17T00:00:02.000Z', 'provider failed'))
        .toThrow('forced approval failure');
      expect(db.getSnapshot().turns).toContainEqual(expect.objectContaining({ id: 'turn-atomic', status: 'running' }));
      expect(db.getSnapshot().approvals).toContainEqual(expect.objectContaining({ id: 'approval-atomic', status: 'pending' }));
    } finally {
      db.close();
    }
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

  it('persists completed model metrics in the terminal transaction and returns them after reopen', () => {
    const path = createDbPath();
    const first = openDatabase(path);
    const finalMetrics = {
      modelProfileId: 'model-1',
      modelName: 'Model 1',
      reasoningRequested: 'enabled' as const,
      reasoningProtocol: 'qwen' as const,
      reasoningObserved: true,
      durationMs: 2_000,
      completionTokens: 40,
      tokensPerSecond: 20,
      speedSource: 'client' as const,
      usageSource: 'server' as const,
      finishReason: 'stop',
    };
    try {
      const thread = first.createThread('Persisted metrics');
      first.createTurn(turnRecord('turn-metrics', thread.id, 'model-1', 'running'));
      first.completeTurn('turn-metrics', '2026-08-17T00:00:03.000Z', finalMetrics);
      expect(first.getSnapshot().turns).toContainEqual(expect.objectContaining({
        id: 'turn-metrics', status: 'completed', incomplete: false, metrics: finalMetrics,
      }));
    } finally {
      first.close();
    }

    const second = openDatabase(path);
    try {
      expect(second.getSnapshot().turns).toContainEqual(expect.objectContaining({
        id: 'turn-metrics', status: 'completed', metrics: finalMetrics,
      }));
    } finally {
      second.close();
    }
  });

  it('refuses to complete a turn once authoritative cancellation has started', () => {
    const db = openDatabase(createDbPath());
    try {
      const thread = db.createThread('Cancellation CAS');
      db.createTurn(turnRecord('turn-cancelling', thread.id, 'model-1', 'running'));
      db.appendItem({
        id: 'item-turn-cancelling-assistant', threadId: thread.id, turnId: 'turn-cancelling',
        kind: 'message', role: 'assistant', text: 'partial', incomplete: true,
        createdAt: '2026-08-17T00:00:01.000Z',
      });
      db.updateTurn('turn-cancelling', { status: 'cancelling', incomplete: true });

      expect(db.completeTurn('turn-cancelling', '2026-08-17T00:00:03.000Z', {
        reasoningRequested: 'enabled', reasoningProtocol: 'qwen', reasoningObserved: true,
        durationMs: 2_000, speedSource: 'client', usageSource: 'unavailable',
      })).toBe(false);
      expect(db.getSnapshot().turns).toContainEqual(expect.objectContaining({
        id: 'turn-cancelling', status: 'cancelling', incomplete: true, metrics: undefined,
      }));
      expect(db.getSnapshot().items[thread.id]).toContainEqual(expect.objectContaining({
        id: 'item-turn-cancelling-assistant', incomplete: true,
      }));
    } finally {
      db.close();
    }
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

  it('binds threads to workspaces, supports pinning, and hides deleted chats from snapshots and context', () => {
    const db = openDatabase(createDbPath());
    try {
      const workspace = db.registerWorkspace({
        displayName: 'Demo Project',
        rootPath: 'D:\\Projects\\demo',
        canonicalRootPath: 'd:\\projects\\demo',
        trustLevel: 'read-only',
      });
      const keptThread = db.createThread('Redis', workspace.id);
      const deletedThread = db.createThread('MySQL', workspace.id);
      const unlinkedThread = db.createThread('Loose chat');
      db.appendItem(userItem(keptThread.id, 'redis question', 'item-kept', 'turn-kept'));
      db.appendItem(userItem(deletedThread.id, 'mysql question', 'item-deleted', 'turn-deleted'));

      expect(keptThread).toMatchObject({ workspaceId: workspace.id, pinned: false });
      expect(unlinkedThread.workspaceId).toBeUndefined();

      db.setThreadPinned(keptThread.id, true);
      expect(db.getSnapshot().threads.find((candidate) => candidate.id === keptThread.id)?.pinned).toBe(true);

      db.bindThreadWorkspace(unlinkedThread.id, workspace.id);
      expect(db.getSnapshot().threads.find((candidate) => candidate.id === unlinkedThread.id)?.workspaceId)
        .toBe(workspace.id);

      db.deleteThread(deletedThread.id);
      const snapshotAfterThreadDelete = db.getSnapshot();
      expect(snapshotAfterThreadDelete.threads.map((thread) => thread.id)).toContain(keptThread.id);
      expect(snapshotAfterThreadDelete.threads.map((thread) => thread.id)).not.toContain(deletedThread.id);
      expect(db.getThreadMessages(deletedThread.id)).toEqual([]);

      db.deleteWorkspace(workspace.id);
      const snapshotAfterWorkspaceDelete = db.getSnapshot();
      expect(snapshotAfterWorkspaceDelete.workspaces.map((candidate) => candidate.id)).not.toContain(workspace.id);
      expect(snapshotAfterWorkspaceDelete.threads.find((thread) => thread.id === keptThread.id)?.workspaceId)
        .toBeUndefined();
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
      deploymentType: 'private',
      runtimeType: 'llama.cpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'Qwen3.5-9B',
      apiKey: 'local-not-used',
      isDefault: true,
    });

    const firstSnapshot = first.getSnapshot();
    expect(firstSnapshot.modelProfiles[0]).toMatchObject({
      id: saved.id,
      name: 'AIFAR Qwen',
      deploymentType: 'private',
      runtimeType: 'llama.cpp',
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
    expect(snapshot.modelProfiles[0]).toMatchObject({ deploymentType: 'private', runtimeType: 'llama.cpp' });
    expect(snapshot.settings.activeModelProfileId).toBe(saved.id);
    expect(second.getModelProfileForRuntime(saved.id)?.apiKey).toBe('local-not-used');
    second.close();
  });

  it('normalizes DashScope compatible-mode model profile base URLs to the OpenAI-compatible v1 endpoint', () => {
    const db = openDatabase(createDbPath());
    try {
      const saved = db.saveModelProfile({
        name: 'DashScope DeepSeek',
        provider: 'openai-compatible',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
        model: 'deepseek-v4-pro',
        apiKey: 'secret',
      });

      expect(saved.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
      expect(db.getModelProfileForRuntime(saved.id)?.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    } finally {
      db.close();
    }
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

  it('excludes approvals that belong to a soft-deleted thread', () => {
    const db = openDatabase(createDbPath());
    try {
      const thread = db.createThread('Deleted approval');
      db.createTurn(turnRecord('turn-deleted', thread.id, 'model-1', 'running'));
      db.upsertApproval({
        id: 'approval-deleted',
        threadId: thread.id,
        turnId: 'turn-deleted',
        title: 'Approve',
        description: 'Must not survive in the visible snapshot.',
        status: 'pending',
        createdAt: '2026-08-17T00:00:01.000Z',
      });

      db.deleteThread(thread.id);

      expect(db.getSnapshot().approvals).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('round-trips the approval file-change diff across reopen', () => {
    const dbPath = createDbPath();
    const fileChanges = [{
      relativePath: 'src/new.ts',
      action: 'created' as const,
      lines: [{ kind: 'added' as const, text: 'export const fresh = true;' }],
    }];
    const first = openDatabase(dbPath);
    let threadId = '';
    try {
      const thread = first.createThread('Diff approval');
      threadId = thread.id;
      first.createTurn(turnRecord('turn-diff', thread.id, 'model-1', 'running'));
      first.upsertApproval({
        id: 'approval-diff',
        threadId: thread.id,
        turnId: 'turn-diff',
        title: 'Edit file: src/new.ts',
        description: 'Preview must survive a restart.',
        fileChanges,
        status: 'pending',
        createdAt: '2026-08-17T00:00:01.000Z',
      });
    } finally {
      first.close();
    }

    const second = openDatabase(dbPath);
    try {
      const approval = second.getSnapshot().approvals.find((candidate) => candidate.id === 'approval-diff');
      expect(approval?.fileChanges).toEqual(fileChanges);
      expect(approval?.threadId).toBe(threadId);
    } finally {
      second.close();
    }
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

  it('persists a non-default output limit across a partial update and reopen', () => {
    const dbPath = createDbPath();
    const first = openDatabase(dbPath);
    const saved = first.saveModelProfile({
      name: 'Bounded custom model',
      provider: 'openai-compatible',
      baseUrl: 'https://models.example.com/v1',
      model: 'custom-model',
      maxOutputTokens: 4096,
    });
    const updated = first.saveModelProfile({
      id: saved.id,
      name: 'Renamed bounded model',
      provider: saved.provider,
      baseUrl: saved.baseUrl,
      model: saved.model,
    });
    expect(updated).toMatchObject({ maxOutputTokens: 4096, isDefault: false });
    first.close();

    const second = openDatabase(dbPath);
    try {
      expect(second.getModelProfileForRuntime(saved.id)).toMatchObject({
        name: 'Renamed bounded model',
        maxOutputTokens: 4096,
        isDefault: false,
      });
    } finally {
      second.close();
    }
  });

  it('raises legacy profiles stuck on the 2048 output default while keeping deliberate values', () => {
    const dbPath = createDbPath();
    const first = openDatabase(dbPath);
    const legacy = first.saveModelProfile({
      name: 'Legacy default model',
      provider: 'openai-compatible',
      baseUrl: 'https://models.example.com/v1',
      model: 'legacy-model',
      maxOutputTokens: 2048,
    });
    const deliberate = first.saveModelProfile({
      name: 'Deliberately small model',
      provider: 'openai-compatible',
      baseUrl: 'https://models.example.com/v1',
      model: 'small-model',
      maxOutputTokens: 1024,
    });
    first.close();

    // Pretend the database predates the raise so the migration reruns on reopen.
    const raw = new DatabaseSync(dbPath);
    raw.prepare('DELETE FROM schema_migrations WHERE version = 10').run();
    raw.close();

    const second = openDatabase(dbPath);
    try {
      expect(second.getModelProfileForRuntime(legacy.id)?.maxOutputTokens).toBe(8192);
      expect(second.getModelProfileForRuntime(deliberate.id)?.maxOutputTokens).toBe(1024);
    } finally {
      second.close();
    }
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

  it('stores provider credentials outside snapshots and resolves joined runtime models', () => {
    const db = openDatabase(createDbPath());
    const provider = db.saveModelProvider({
      name: 'DashScope',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      protocol: 'openai-chat-completions',
      apiKey: 'provider-secret',
      maxConcurrency: 3,
      requestTimeoutMs: 300_000,
      allowImages: true,
      toolCallingMode: 'native',
      thinkingMode: 'model-default',
    });
    const [model] = db.addProviderModels(provider.id, [{
      modelId: 'deepseek-v4-pro',
      contextWindowTokens: 65_536,
      maxOutputTokens: 8192,
      isDefault: true,
    }]);

    const snapshot = db.getSnapshot();
    expect(snapshot.modelProviders).toContainEqual(expect.objectContaining({
      id: provider.id,
      apiKeyConfigured: true,
      protocol: 'openai-chat-completions',
    }));
    expect(JSON.stringify(snapshot)).not.toContain('provider-secret');
    expect(db.getModelProfileForRuntime(model.id)).toMatchObject({
      providerId: provider.id,
      providerName: 'DashScope',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      protocol: 'openai-chat-completions',
      apiKey: 'provider-secret',
      model: 'deepseek-v4-pro',
      contextWindowTokens: 65_536,
      maxOutputTokens: 8192,
    });
    db.close();
  });

  it('marks unadvertised configured models missing without deleting them', () => {
    const db = openDatabase(createDbPath());
    const provider = db.saveModelProvider({
      name: 'Catalog provider',
      baseUrl: 'https://example.test/v1',
      protocol: 'openai-chat-completions',
      maxConcurrency: 1,
      requestTimeoutMs: 30_000,
      allowImages: false,
      toolCallingMode: 'text-fallback',
      thinkingMode: 'model-default',
    });
    db.addProviderModels(provider.id, [{ modelId: 'model-a' }, { modelId: 'model-b' }]);

    db.refreshProviderCatalogState(provider.id, ['model-a']);

    expect(db.getSnapshot().modelProfiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: provider.id, model: 'model-a', catalogState: 'available' }),
      expect.objectContaining({ providerId: provider.id, model: 'model-b', catalogState: 'missing' }),
    ]));
    db.close();
  });

  it('migrates legacy model rows to providers without changing model ids or keys', () => {
    const path = createDbPath();
    createV5ModelProfileDatabase(path);
    const db = openDatabase(path);
    const snapshot = db.getSnapshot();

    expect(snapshot.modelProfiles.length).toBeGreaterThan(0);
    expect(snapshot.modelProfiles.every((profile) => Boolean(profile.providerId))).toBe(true);
    expect(snapshot.modelProviders?.length).toBeGreaterThan(0);
    expect(db.getModelProfileForRuntime('legacy-local')).toMatchObject({
      id: 'legacy-local',
      apiKey: 'keep-this-secret',
      protocol: 'openai-chat-completions',
    });
    db.close();
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

function createV5ModelProfileDatabase(path: string): void {
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE model_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      api_key TEXT,
      capabilities TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      response_speed TEXT NOT NULL DEFAULT 'standard',
      is_default INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE turns (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      model_profile_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      incomplete INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      metrics TEXT
    );
    INSERT INTO schema_migrations (version, applied_at) VALUES
      (1, '2026-08-16T00:00:00.000Z'),
      (2, '2026-08-16T00:00:01.000Z'),
      (3, '2026-08-17T00:00:00.000Z'),
      (4, '2026-08-18T00:00:00.000Z'),
      (5, '2026-08-18T00:00:01.000Z');
    INSERT INTO model_profiles (
      id, name, provider, base_url, model, api_key, capabilities, reasoning,
      max_concurrency, response_speed, is_default, created_at, updated_at
    ) VALUES
      (
        'legacy-local', 'Legacy local endpoint', 'openai-compatible', 'http://127.0.0.1:8080/v1',
        'your-model-name', 'keep-this-secret', '{"marker":"legacy-local"}',
        '{"mode":"auto","protocol":"none","display":"summary"}', 7, 'fast', 1,
        '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z'
      ),
      (
        'remote-placeholder', 'Remote placeholder', 'openai-compatible', 'https://models.example.com/v1',
        'your-model-name', 'remote-key', '{"marker":"remote-placeholder"}',
        '{"mode":"disabled","protocol":"none","display":"auto"}', 2, 'fast', 0,
        '2026-08-17T00:00:01.000Z', '2026-08-17T00:00:01.000Z'
      ),
      (
        'local-custom', 'Custom local model', 'openai-compatible', 'http://127.0.0.1:8080/v1',
        'my-custom-model', 'custom-key', '{"marker":"local-custom"}',
        '{"mode":"disabled","protocol":"none","display":"auto"}', 3, 'quality', 0,
        '2026-08-17T00:00:02.000Z', '2026-08-17T00:00:02.000Z'
      );
  `);
  legacy.close();
}

function createMislabelledV4Database(path: string): void {
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
      model_profile_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      incomplete INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      metrics TEXT
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
      (2, '2026-08-16T00:00:01.000Z'),
      (3, '2026-08-17T00:00:00.000Z'),
      (4, '2026-08-18T00:00:00.000Z');
    INSERT INTO threads (
      id, group_id, title, status, model_profile_id, created_at, updated_at, deleted_at
    ) VALUES (
      'v4-history-thread', NULL, 'Base to head history', 'ready', NULL,
      '2026-08-16T01:00:00.000Z', '2026-08-17T01:00:00.000Z', NULL
    );
    INSERT INTO turns (
      id, thread_id, model_profile_id, status, created_at, started_at, completed_at,
      error, incomplete, updated_at, metrics
    ) VALUES
      (
        'mislabelled-success', 'v4-history-thread', NULL, 'interrupted',
        '2026-08-16T01:00:00.000Z', NULL, NULL, NULL, 1, '2026-08-17T01:00:00.000Z', NULL
      ),
      (
        'genuine-partial', 'v4-history-thread', NULL, 'interrupted',
        '2026-08-16T02:00:00.000Z', NULL, NULL, NULL, 1, '2026-08-17T01:00:00.000Z', NULL
      );
  `);
  const insertItem = legacy.prepare(`
    INSERT INTO items (id, thread_id, turn_id, kind, payload, created_at)
    VALUES (?, 'v4-history-thread', ?, 'message', ?, ?)
  `);
  insertItem.run(
    'mislabelled-success-assistant',
    'mislabelled-success',
    JSON.stringify({
      id: 'mislabelled-success-assistant',
      threadId: 'v4-history-thread',
      turnId: 'mislabelled-success',
      kind: 'message',
      role: 'assistant',
      text: 'complete legacy answer',
      createdAt: '2026-08-16T01:00:01.000Z',
    }),
    '2026-08-16T01:00:01.000Z',
  );
  insertItem.run(
    'genuine-partial-assistant',
    'genuine-partial',
    JSON.stringify({
      id: 'genuine-partial-assistant',
      threadId: 'v4-history-thread',
      turnId: 'genuine-partial',
      kind: 'message',
      role: 'assistant',
      text: 'partial streamed answer',
      incomplete: true,
      createdAt: '2026-08-16T02:00:01.000Z',
    }),
    '2026-08-16T02:00:01.000Z',
  );
  legacy.close();
}

describe('workspace persistence', () => {
  const registration = {
    displayName: 'Demo Project',
    rootPath: 'D:\\Projects\\demo',
    canonicalRootPath: 'd:\\projects\\demo',
    trustLevel: 'read-only' as const,
  };

  it('registers a workspace and exposes it through the snapshot', () => {
    const db = openDatabase(createDbPath());
    try {
      const record = db.registerWorkspace(registration);
      expect(record).toMatchObject({
        displayName: 'Demo Project',
        rootPath: 'D:\\Projects\\demo',
        canonicalRootPath: 'd:\\projects\\demo',
        trustLevel: 'read-only',
        networkPolicy: 'disabled',
      });

      const snapshot = db.getSnapshot();
      expect(snapshot.workspaces).toHaveLength(1);
      expect(snapshot.workspaces[0]).toMatchObject({ id: record.id, displayName: 'Demo Project' });
      expect(db.getWorkspace(record.id)?.canonicalRootPath).toBe('d:\\projects\\demo');
    } finally {
      db.close();
    }
  });

  it('upserts instead of duplicating when the canonical root is registered again', () => {
    const db = openDatabase(createDbPath());
    try {
      const first = db.registerWorkspace(registration);
      const second = db.registerWorkspace({ ...registration, displayName: 'Renamed', trustLevel: 'read-write' });

      expect(second.id).toBe(first.id);
      expect(second.trustLevel).toBe('read-write');
      expect(second.displayName).toBe('Renamed');
      expect(db.getSnapshot().workspaces).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('persists workspaces across database reopens', () => {
    const path = createDbPath();
    const first = openDatabase(path);
    let workspaceId: string;
    try {
      workspaceId = first.registerWorkspace(registration).id;
    } finally {
      first.close();
    }

    const reopened = openDatabase(path);
    try {
      expect(reopened.getWorkspace(workspaceId)).toMatchObject({ id: workspaceId, trustLevel: 'read-only' });
    } finally {
      reopened.close();
    }
  });

  it('touchWorkspace advances lastOpenedAt and deleteWorkspace removes the record', () => {
    const db = openDatabase(createDbPath());
    try {
      const record = db.registerWorkspace(registration);
      db.touchWorkspace(record.id);
      const touched = db.getWorkspace(record.id);
      expect(touched).toBeDefined();
      expect(touched!.lastOpenedAt >= record.lastOpenedAt).toBe(true);

      db.deleteWorkspace(record.id);
      expect(db.getWorkspace(record.id)).toBeUndefined();
      expect(db.getSnapshot().workspaces).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('rejects registration with blank names or paths', () => {
    const db = openDatabase(createDbPath());
    try {
      expect(() => db.registerWorkspace({ ...registration, displayName: '  ' })).toThrow();
      expect(() => db.registerWorkspace({ ...registration, canonicalRootPath: ' ' })).toThrow();
      expect(db.getSnapshot().workspaces).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('updates a workspace trust level in place and rejects unknown workspaces', () => {
    const db = openDatabase(createDbPath());
    try {
      const record = db.registerWorkspace(registration);
      const upgraded = db.setWorkspaceTrust(record.id, 'read-write');
      expect(upgraded).toMatchObject({ id: record.id, trustLevel: 'read-write' });
      expect(db.getSnapshot().workspaces[0]).toMatchObject({ id: record.id, trustLevel: 'read-write' });

      const downgraded = db.setWorkspaceTrust(record.id, 'read-only');
      expect(downgraded.trustLevel).toBe('read-only');

      expect(() => db.setWorkspaceTrust('missing-workspace', 'read-write')).toThrow('does not exist');
    } finally {
      db.close();
    }
  });
});
