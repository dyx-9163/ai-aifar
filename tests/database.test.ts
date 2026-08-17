import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Item } from '../src/shared/domain';
import { openDatabase } from '../src/agent/database';

let tempDirectories: string[] = [];

function createDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'private-ai-db-'));
  tempDirectories.push(directory);
  return join(directory, 'app.sqlite');
}

function userItem(threadId: string, text: string): Item {
  return {
    id: 'item-1',
    threadId,
    turnId: 'turn-1',
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
});
