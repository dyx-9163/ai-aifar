import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AppSnapshot, Approval, AppSettings, Item, ThreadSummary } from '../shared/domain.js';

export interface AppDatabase {
  getSnapshot(): AppSnapshot;
  createThread(title: string): ThreadSummary;
  appendItem(item: Item): void;
  upsertApproval(approval: Approval): void;
  close(): void;
}

type ThreadRow = {
  id: string;
  title: string;
  status: ThreadSummary['status'];
  created_at: string;
  updated_at: string;
};

type ItemRow = {
  thread_id: string;
  payload: string;
};

type ApprovalRow = {
  id: string;
  thread_id: string;
  turn_id: string;
  title: string;
  description: string;
  status: Approval['status'];
  created_at: string;
  responded_at: string | null;
};

type SettingRow = {
  key: string;
  value: string;
};

class SqliteAppDatabase implements AppDatabase {
  constructor(private readonly db: DatabaseSync) {
    this.configure();
    this.migrate();
  }

  getSnapshot(): AppSnapshot {
    const threads = this.db
      .prepare('SELECT id, title, status, created_at, updated_at FROM threads ORDER BY updated_at DESC')
      .all()
      .map((row) => mapThread(row as ThreadRow));

    const items: Record<string, Item[]> = {};
    for (const row of this.db.prepare('SELECT thread_id, payload FROM items ORDER BY created_at ASC, id ASC').all()) {
      const itemRow = row as ItemRow;
      items[itemRow.thread_id] ??= [];
      items[itemRow.thread_id].push(JSON.parse(itemRow.payload) as Item);
    }

    const approvals = this.db
      .prepare(
        'SELECT id, thread_id, turn_id, title, description, status, created_at, responded_at FROM approvals ORDER BY created_at ASC',
      )
      .all()
      .map((row) => mapApproval(row as ApprovalRow));

    return {
      threads,
      items,
      approvals,
      settings: this.readSettings(),
    };
  }

  createThread(title: string): ThreadSummary {
    const now = new Date().toISOString();
    const thread: ThreadSummary = {
      id: randomUUID(),
      title,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    };

    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO threads (id, title, status, created_at, updated_at) VALUES (:id, :title, :status, :createdAt, :updatedAt)',
        )
        .run({
          id: thread.id,
          title: thread.title,
          status: thread.status,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
        });
    });

    return thread;
  }

  appendItem(item: Item): void {
    this.transaction(() => {
      if (item.turnId) {
        this.db
          .prepare(
            'INSERT OR IGNORE INTO turns (id, thread_id, status, created_at, updated_at) VALUES (:id, :threadId, :status, :createdAt, :updatedAt)',
          )
          .run({
            id: item.turnId,
            threadId: item.threadId,
            status: 'running',
            createdAt: item.createdAt,
            updatedAt: item.createdAt,
          });
      }

      this.db
        .prepare(
          'INSERT INTO items (id, thread_id, turn_id, kind, payload, created_at) VALUES (:id, :threadId, :turnId, :kind, :payload, :createdAt)',
        )
        .run({
          id: item.id,
          threadId: item.threadId,
          turnId: item.turnId ?? null,
          kind: item.kind,
          payload: JSON.stringify(item),
          createdAt: item.createdAt,
        });

      this.db
        .prepare('UPDATE threads SET updated_at = :updatedAt WHERE id = :threadId')
        .run({ updatedAt: item.createdAt, threadId: item.threadId });
    });
  }

  upsertApproval(approval: Approval): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO approvals (id, thread_id, turn_id, title, description, status, created_at, responded_at)
           VALUES (:id, :threadId, :turnId, :title, :description, :status, :createdAt, :respondedAt)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             description = excluded.description,
             status = excluded.status,
             responded_at = excluded.responded_at`,
        )
        .run({
          id: approval.id,
          threadId: approval.threadId,
          turnId: approval.turnId,
          title: approval.title,
          description: approval.description,
          status: approval.status,
          createdAt: approval.createdAt,
          respondedAt: approval.respondedAt ?? null,
        });
    });
  }

  close(): void {
    this.db.close();
  }

  private configure(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        responded_at TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'));
      INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'system');
    `);
  }

  private readSettings(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as SettingRow[];
    const theme = rows.find((row) => row.key === 'theme')?.value;
    return {
      theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system',
    };
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function openDatabase(path: string): AppDatabase {
  return new SqliteAppDatabase(new DatabaseSync(path, { timeout: 5000 }));
}

function mapThread(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    respondedAt: row.responded_at ?? undefined,
  };
}
