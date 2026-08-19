import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase, type FileCheckpointInput } from '../src/agent/database';
import { rollbackTurnFileChanges } from '../src/agent/workspace/fileCheckpoints';

const tempDirectories: string[] = [];
const openDatabases: AppDatabase[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    try {
      database.close();
    } catch {
      // A successful test may already have closed the database explicitly.
    }
  }
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex');
}

function createSetup(): { database: AppDatabase; workspaceId: string; threadId: string; turnId: string; rootPath: string } {
  const dbDir = mkdtempSync(join(tmpdir(), 'private-ai-checkpoint-db-'));
  tempDirectories.push(dbDir);
  const database = openDatabase(join(dbDir, 'app.db'));
  openDatabases.push(database);

  const rootPath = realpathSync.native(mkdtempSync(join(tmpdir(), 'private-ai-checkpoint-ws-')));
  tempDirectories.push(rootPath);
  const workspace = database.registerWorkspace({
    displayName: 'checkpoint-ws',
    rootPath,
    canonicalRootPath: rootPath,
    trustLevel: 'read-write',
  });

  const thread = database.createThread('Checkpoint thread');
  database.createTurn({
    id: 'turn-checkpoint',
    threadId: thread.id,
    status: 'completed',
    createdAt: new Date().toISOString(),
    incomplete: false,
  });

  return { database, workspaceId: workspace.id, threadId: thread.id, turnId: 'turn-checkpoint', rootPath };
}

function modifiedCheckpoint(setup: { workspaceId: string; turnId: string }): FileCheckpointInput {
  return {
    workspaceId: setup.workspaceId,
    turnId: setup.turnId,
    relativePath: 'main.ts',
    previousAction: 'existed',
    previousContent: 'original\n',
    previousContentHash: sha256('original\n'),
    latestContentHash: sha256('patched\n'),
  };
}

describe('file checkpoints', () => {
  it('keeps the first pre-turn state but advances the latest written hash', () => {
    const setup = createSetup();
    const checkpoint = modifiedCheckpoint(setup);
    setup.database.recordFileCheckpoint(checkpoint);
    setup.database.recordFileCheckpoint({
      ...checkpoint,
      previousContent: 'must be ignored',
      previousContentHash: sha256('must be ignored'),
      latestContentHash: sha256('patched-again\n'),
    });

    const records = setup.database.listTurnCheckpoints(setup.turnId);
    expect(records).toHaveLength(1);
    expect(records[0]?.previousContent).toBe('original\n');
    expect(records[0]?.latestContentHash).toBe(sha256('patched-again\n'));
  });

  it('aggregates undoable turns per workspace turn in the snapshot', () => {
    const setup = createSetup();
    setup.database.recordFileCheckpoint(modifiedCheckpoint(setup));
    setup.database.recordFileCheckpoint({
      ...modifiedCheckpoint(setup),
      relativePath: 'notes.md',
      previousAction: 'absent',
      previousContent: null,
      previousContentHash: '',
      latestContentHash: sha256('note'),
    });

    expect(setup.database.getSnapshot().undoableTurns).toEqual([
      { turnId: setup.turnId, workspaceId: setup.workspaceId, fileCount: 2 },
    ]);
  });

  it('restores a modified file and clears the checkpoints after rollback', () => {
    const setup = createSetup();
    const target = join(setup.rootPath, 'main.ts');
    writeFileSync(target, 'original\n');
    setup.database.recordFileCheckpoint(modifiedCheckpoint(setup));
    writeFileSync(target, 'patched\n');

    const report = rollbackTurnFileChanges(setup.database, setup.turnId);

    expect(report).toEqual({ restored: ['main.ts'], skipped: [] });
    expect(readFileSync(target, 'utf-8')).toBe('original\n');
    expect(setup.database.listTurnCheckpoints(setup.turnId)).toHaveLength(0);
    expect(setup.database.getSnapshot().undoableTurns).toHaveLength(0);
  });

  it('deletes a file that the turn created', () => {
    const setup = createSetup();
    const target = join(setup.rootPath, 'helper.ts');
    setup.database.recordFileCheckpoint({
      workspaceId: setup.workspaceId,
      turnId: setup.turnId,
      relativePath: 'helper.ts',
      previousAction: 'absent',
      previousContent: null,
      previousContentHash: '',
      latestContentHash: sha256('export const helper = true;'),
    });
    writeFileSync(target, 'export const helper = true;');

    const report = rollbackTurnFileChanges(setup.database, setup.turnId);

    expect(report).toEqual({ restored: ['helper.ts'], skipped: [] });
    expect(existsSync(target)).toBe(false);
  });

  it('skips files the user edited after the turn instead of clobbering them', () => {
    const setup = createSetup();
    const target = join(setup.rootPath, 'main.ts');
    writeFileSync(target, 'original\n');
    setup.database.recordFileCheckpoint(modifiedCheckpoint(setup));
    writeFileSync(target, 'user edited this later\n');

    const report = rollbackTurnFileChanges(setup.database, setup.turnId);

    expect(report).toEqual({ restored: [], skipped: ['main.ts'] });
    expect(readFileSync(target, 'utf-8')).toBe('user edited this later\n');
  });

  it('drops checkpoints when their thread is deleted', () => {
    const setup = createSetup();
    setup.database.recordFileCheckpoint(modifiedCheckpoint(setup));
    expect(setup.database.listTurnCheckpoints(setup.turnId)).toHaveLength(1);

    setup.database.deleteThread(setup.threadId);

    expect(setup.database.listTurnCheckpoints(setup.turnId)).toHaveLength(0);
  });

  it('drops checkpoints when their workspace is deleted', () => {
    const setup = createSetup();
    setup.database.recordFileCheckpoint(modifiedCheckpoint(setup));

    setup.database.deleteWorkspace(setup.workspaceId);

    expect(setup.database.listTurnCheckpoints(setup.turnId)).toHaveLength(0);
  });
});
