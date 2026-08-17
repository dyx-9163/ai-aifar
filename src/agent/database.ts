import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  AppSnapshot,
  Approval,
  ChatGroup,
  AppSettings,
  Item,
  LanguagePreference,
  MessageItem,
  ModelCapabilities,
  ModelReasoningSettings,
  ModelProfile,
  ModelProfileInput,
  ModelResponseSpeed,
  RuntimeSettingsInput,
  ThreadSummary,
} from '../shared/domain.js';

export interface AppDatabase {
  getSnapshot(): AppSnapshot;
  createGroup(name: string): ChatGroup;
  deleteGroup(groupId: string): void;
  createThread(title: string, groupId?: string): ThreadSummary;
  deleteThread(threadId: string): void;
  setThreadModel(threadId: string, modelProfileId?: string): void;
  setLanguage(language: LanguagePreference): void;
  updateSettings(settings: RuntimeSettingsInput): AppSettings;
  getThreadMessages(threadId: string, limit?: number): MessageItem[];
  appendItem(item: Item): void;
  upsertApproval(approval: Approval): void;
  saveModelProfile(profile: ModelProfileInput): ModelProfile;
  deleteModelProfile(id: string): void;
  getModelProfileForRuntime(id?: string): RuntimeModelProfile | undefined;
  close(): void;
}

export type RuntimeModelProfile = ModelProfile & { apiKey?: string };

type ThreadRow = {
  id: string;
  group_id: string;
  title: string;
  status: ThreadSummary['status'];
  model_profile_id: string | null;
  created_at: string;
  updated_at: string;
};

type ChatGroupRow = {
  id: string;
  name: string;
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

type ModelProfileRow = {
  id: string;
  name: string;
  provider: ModelProfile['provider'];
  base_url: string;
  model: string;
  api_key: string | null;
  capabilities: string;
  reasoning: string;
  response_speed: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
};

class SqliteAppDatabase implements AppDatabase {
  constructor(private readonly db: DatabaseSync) {
    this.configure();
    this.migrate();
  }

  getSnapshot(): AppSnapshot {
    const groups = this.db
      .prepare('SELECT id, name, created_at, updated_at FROM chat_groups WHERE deleted_at IS NULL ORDER BY updated_at DESC, name ASC')
      .all()
      .map((row) => mapChatGroup(row as ChatGroupRow));

    const threads = this.db
      .prepare(
        'SELECT id, group_id, title, status, model_profile_id, created_at, updated_at FROM threads WHERE deleted_at IS NULL ORDER BY updated_at DESC',
      )
      .all()
      .map((row) => mapThread(row as ThreadRow));

    const items: Record<string, Item[]> = {};
    for (const row of this.db
      .prepare(
        `SELECT i.thread_id, i.payload
         FROM items i
         INNER JOIN threads t ON t.id = i.thread_id
         WHERE t.deleted_at IS NULL
         ORDER BY i.created_at ASC, i.id ASC`,
      )
      .all()) {
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
      groups,
      threads,
      items,
      approvals,
      modelProfiles: this.readModelProfiles(false),
      settings: this.readSettings(),
    };
  }

  createGroup(name: string): ChatGroup {
    const now = new Date().toISOString();
    const group: ChatGroup = {
      id: randomUUID(),
      name: requireTrimmed(name, 'Chat group name'),
      createdAt: now,
      updatedAt: now,
    };

    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO chat_groups (id, name, created_at, updated_at, deleted_at)
           VALUES (:id, :name, :createdAt, :updatedAt, NULL)`,
        )
        .run({
          id: group.id,
          name: group.name,
          createdAt: group.createdAt,
          updatedAt: group.updatedAt,
        });
    });

    return group;
  }

  deleteGroup(groupId: string): void {
    const deletedAt = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare('UPDATE chat_groups SET deleted_at = :deletedAt, updated_at = :deletedAt WHERE id = :groupId').run({
        groupId,
        deletedAt,
      });
      this.db.prepare('UPDATE threads SET deleted_at = :deletedAt, updated_at = :deletedAt WHERE group_id = :groupId').run({
        groupId,
        deletedAt,
      });
    });
  }

  createThread(title: string, groupId?: string): ThreadSummary {
    const now = new Date().toISOString();
    const selectedGroupId = groupId ?? this.defaultGroupId();
    assertKnownGroup(this.db, selectedGroupId);
    const thread: ThreadSummary = {
      id: randomUUID(),
      groupId: selectedGroupId,
      title,
      status: 'ready',
      modelProfileId: this.readSettings().activeModelProfileId,
      createdAt: now,
      updatedAt: now,
    };

    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO threads (id, group_id, title, status, model_profile_id, created_at, updated_at, deleted_at)
           VALUES (:id, :groupId, :title, :status, :modelProfileId, :createdAt, :updatedAt, NULL)`,
        )
        .run({
          id: thread.id,
          groupId: thread.groupId,
          title: thread.title,
          status: thread.status,
          modelProfileId: thread.modelProfileId ?? null,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
        });
    });

    return thread;
  }

  deleteThread(threadId: string): void {
    const deletedAt = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare('UPDATE threads SET deleted_at = :deletedAt, updated_at = :deletedAt WHERE id = :threadId')
        .run({ threadId, deletedAt });
    });
  }

  setThreadModel(threadId: string, modelProfileId?: string): void {
    this.transaction(() => {
      if (modelProfileId) {
        assertKnownModelProfile(this.db, modelProfileId);
      }
      this.db
        .prepare('UPDATE threads SET model_profile_id = :modelProfileId, updated_at = :updatedAt WHERE id = :threadId')
        .run({ threadId, modelProfileId: modelProfileId ?? null, updatedAt: new Date().toISOString() });
      this.upsertSetting('activeModelProfileId', modelProfileId ?? '');
    });
  }

  setLanguage(language: LanguagePreference): void {
    this.transaction(() => {
      this.upsertSetting('language', language);
    });
  }

  updateSettings(settings: RuntimeSettingsInput): AppSettings {
    this.transaction(() => {
      if (typeof settings.showModelMetrics === 'boolean') {
        this.upsertSetting('showModelMetrics', String(settings.showModelMetrics));
      }
      if (typeof settings.contextMessageLimit === 'number') {
        this.upsertSetting('contextMessageLimit', String(clampContextLimit(settings.contextMessageLimit)));
      }
    });

    return this.readSettings();
  }

  getThreadMessages(threadId: string, limit = 20): MessageItem[] {
    const rows = this.db
      .prepare(
        `SELECT i.payload
         FROM items i
         INNER JOIN threads t ON t.id = i.thread_id
         WHERE i.thread_id = :threadId AND i.kind = :kind AND t.deleted_at IS NULL
         ORDER BY i.created_at ASC, i.id ASC`,
      )
      .all({ threadId, kind: 'message' }) as { payload: string }[];
    const merged: MessageItem[] = [];

    for (const row of rows) {
      const item = JSON.parse(row.payload) as MessageItem;
      const previous = merged.at(-1);
      if (previous?.role === 'assistant' && item.role === 'assistant' && previous.turnId && previous.turnId === item.turnId) {
        previous.text += item.text;
        continue;
      }
      merged.push(item);
    }

    return merged.slice(Math.max(0, merged.length - limit));
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

  saveModelProfile(input: ModelProfileInput): ModelProfile {
    const now = new Date().toISOString();
    const existing = input.id ? this.getModelProfileForRuntime(input.id) : undefined;
    const profile: RuntimeModelProfile = {
      id: input.id ?? randomUUID(),
      name: requireTrimmed(input.name, 'Model profile name'),
      provider: input.provider,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      model: requireTrimmed(input.model, 'Model name'),
      apiKey: input.apiKey?.trim() || existing?.apiKey,
      apiKeyConfigured: Boolean(input.apiKey?.trim() || existing?.apiKey),
      capabilities: normalizeCapabilities(input.capabilities),
      reasoning: normalizeReasoning(input.reasoning ?? existing?.reasoning),
      responseSpeed: normalizeResponseSpeed(input.responseSpeed ?? existing?.responseSpeed),
      isDefault: Boolean(input.isDefault),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.transaction(() => {
      if (profile.isDefault) {
        this.db.prepare('UPDATE model_profiles SET is_default = 0').run();
        this.upsertSetting('activeModelProfileId', profile.id);
      }
      this.db
        .prepare(
          `INSERT INTO model_profiles (id, name, provider, base_url, model, api_key, capabilities, reasoning, response_speed, is_default, created_at, updated_at)
           VALUES (:id, :name, :provider, :baseUrl, :model, :apiKey, :capabilities, :reasoning, :responseSpeed, :isDefault, :createdAt, :updatedAt)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             provider = excluded.provider,
             base_url = excluded.base_url,
             model = excluded.model,
             api_key = excluded.api_key,
             capabilities = excluded.capabilities,
             reasoning = excluded.reasoning,
             response_speed = excluded.response_speed,
             is_default = excluded.is_default,
             updated_at = excluded.updated_at`,
        )
        .run({
          id: profile.id,
          name: profile.name,
          provider: profile.provider,
          baseUrl: profile.baseUrl,
          model: profile.model,
          apiKey: profile.apiKey ?? null,
          capabilities: JSON.stringify(profile.capabilities),
          reasoning: JSON.stringify(profile.reasoning),
          responseSpeed: profile.responseSpeed,
          isDefault: profile.isDefault ? 1 : 0,
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt,
        });

      const defaultId = this.defaultModelProfileId();
      if (!defaultId) {
        this.db.prepare('UPDATE model_profiles SET is_default = 1 WHERE id = :id').run({ id: profile.id });
        this.upsertSetting('activeModelProfileId', profile.id);
        profile.isDefault = true;
      }
    });

    return redactModelProfile(profile);
  }

  deleteModelProfile(id: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM model_profiles WHERE id = :id').run({ id });
      this.db.prepare('UPDATE threads SET model_profile_id = NULL WHERE model_profile_id = :id').run({ id });
      const defaultId = this.defaultModelProfileId();
      this.upsertSetting('activeModelProfileId', defaultId ?? '');
    });
  }

  getModelProfileForRuntime(id?: string): RuntimeModelProfile | undefined {
    const selectedId = id || this.readSettings().activeModelProfileId || this.defaultModelProfileId();
    const row = selectedId
      ? this.db.prepare('SELECT * FROM model_profiles WHERE id = :id').get({ id: selectedId })
      : this.db.prepare('SELECT * FROM model_profiles WHERE is_default = 1 ORDER BY updated_at DESC LIMIT 1').get();
    return row ? mapModelProfile(row as ModelProfileRow, true) : undefined;
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
        group_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        model_profile_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS chat_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
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

      CREATE TABLE IF NOT EXISTS model_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key TEXT,
        capabilities TEXT NOT NULL,
        is_default INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'));
      INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'system');
      INSERT OR IGNORE INTO settings (key, value) VALUES ('language', 'en-US');
      INSERT OR IGNORE INTO settings (key, value) VALUES ('activeModelProfileId', '');
      INSERT OR IGNORE INTO settings (key, value) VALUES ('showModelMetrics', 'true');
      INSERT OR IGNORE INTO settings (key, value) VALUES ('contextMessageLimit', '20');
    `);
    this.ensureColumn('threads', 'model_profile_id', 'ALTER TABLE threads ADD COLUMN model_profile_id TEXT');
    this.ensureColumn('threads', 'group_id', 'ALTER TABLE threads ADD COLUMN group_id TEXT');
    this.ensureColumn('threads', 'deleted_at', 'ALTER TABLE threads ADD COLUMN deleted_at TEXT');
    this.ensureColumn(
      'model_profiles',
      'reasoning',
      'ALTER TABLE model_profiles ADD COLUMN reasoning TEXT NOT NULL DEFAULT \'{"mode":"disabled","protocol":"none","effort":"medium"}\'',
    );
    this.ensureColumn(
      'model_profiles',
      'response_speed',
      "ALTER TABLE model_profiles ADD COLUMN response_speed TEXT NOT NULL DEFAULT 'standard'",
    );
    this.ensureDefaultGroup();
  }

  private readSettings(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as SettingRow[];
    const theme = rows.find((row) => row.key === 'theme')?.value;
    const language = rows.find((row) => row.key === 'language')?.value;
    const showModelMetrics = rows.find((row) => row.key === 'showModelMetrics')?.value;
    const contextMessageLimit = rows.find((row) => row.key === 'contextMessageLimit')?.value;
    const configuredActiveModelProfileId = rows.find((row) => row.key === 'activeModelProfileId')?.value || undefined;
    const activeModelProfileId = configuredActiveModelProfileId || this.defaultModelProfileId();
    return {
      theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system',
      language: language === 'zh-CN' || language === 'en-US' ? language : 'en-US',
      activeModelProfileId,
      showModelMetrics: showModelMetrics === undefined ? true : showModelMetrics === 'true',
      contextMessageLimit: clampContextLimit(Number.parseInt(contextMessageLimit ?? '20', 10)),
    };
  }

  private readModelProfiles(includeApiKey: true): RuntimeModelProfile[];
  private readModelProfiles(includeApiKey: false): ModelProfile[];
  private readModelProfiles(includeApiKey: boolean): RuntimeModelProfile[] | ModelProfile[] {
    return this.db
      .prepare('SELECT * FROM model_profiles ORDER BY is_default DESC, updated_at DESC')
      .all()
      .map((row) =>
        includeApiKey ? mapModelProfile(row as ModelProfileRow, true) : mapModelProfile(row as ModelProfileRow, false),
      );
  }

  private defaultModelProfileId(): string | undefined {
    const row = this.db.prepare('SELECT id FROM model_profiles WHERE is_default = 1 ORDER BY updated_at DESC LIMIT 1').get() as
      | { id: string }
      | undefined;
    return row?.id;
  }

  private defaultGroupId(): string {
    this.ensureDefaultGroup();
    return 'default-group';
  }

  private ensureDefaultGroup(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO chat_groups (id, name, created_at, updated_at, deleted_at)
         VALUES ('default-group', 'Workspace', :createdAt, :updatedAt, NULL)`,
      )
      .run({ createdAt: now, updatedAt: now });
    this.db.prepare("UPDATE threads SET group_id = 'default-group' WHERE group_id IS NULL OR group_id = ''").run();
  }

  private upsertSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (:key, :value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ key, value });
  }

  private ensureColumn(table: string, column: string, sql: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!rows.some((row) => row.name === column)) {
      this.db.exec(sql);
    }
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
    groupId: row.group_id,
    title: row.title,
    status: row.status,
    modelProfileId: row.model_profile_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapChatGroup(row: ChatGroupRow): ChatGroup {
  return {
    id: row.id,
    name: row.name,
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

function mapModelProfile(row: ModelProfileRow, includeApiKey: true): RuntimeModelProfile;
function mapModelProfile(row: ModelProfileRow, includeApiKey: false): ModelProfile;
function mapModelProfile(row: ModelProfileRow, includeApiKey: boolean): RuntimeModelProfile | ModelProfile {
  const profile: RuntimeModelProfile = {
    id: row.id,
    name: row.name,
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    apiKey: includeApiKey ? (row.api_key ?? undefined) : undefined,
    apiKeyConfigured: Boolean(row.api_key),
    capabilities: parseCapabilities(row.capabilities),
    reasoning: parseReasoning(row.reasoning),
    responseSpeed: normalizeResponseSpeed(row.response_speed),
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  return includeApiKey ? profile : redactModelProfile(profile);
}

function redactModelProfile(profile: RuntimeModelProfile): ModelProfile {
  const { apiKey: _apiKey, ...redacted } = profile;
  return redacted;
}

function normalizeCapabilities(input?: Partial<ModelCapabilities>): ModelCapabilities {
  return {
    text: input?.text ?? true,
    vision: input?.vision ?? false,
    longContext: input?.longContext ?? false,
    reasoning: input?.reasoning ?? false,
    streamingUsage: input?.streamingUsage ?? false,
  };
}

function parseCapabilities(value: string): ModelCapabilities {
  try {
    const parsed = JSON.parse(value) as Partial<ModelCapabilities>;
    return normalizeCapabilities(parsed);
  } catch {
    return normalizeCapabilities();
  }
}

function normalizeReasoning(input?: Partial<ModelReasoningSettings>): ModelReasoningSettings {
  return {
    mode: input?.mode === 'auto' || input?.mode === 'enabled' || input?.mode === 'disabled' ? input.mode : 'disabled',
    protocol:
      input?.protocol === 'qwen' || input?.protocol === 'openai' || input?.protocol === 'custom' ? input.protocol : 'none',
    effort: input?.effort === 'low' || input?.effort === 'high' || input?.effort === 'xhigh' ? input.effort : 'medium',
  };
}

function parseReasoning(value: string | null | undefined): ModelReasoningSettings {
  try {
    return normalizeReasoning(JSON.parse(value || '{}') as Partial<ModelReasoningSettings>);
  } catch {
    return normalizeReasoning();
  }
}

function clampContextLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 20;
  }
  return Math.min(200, Math.max(1, Math.trunc(value)));
}

function normalizeResponseSpeed(value: unknown): ModelResponseSpeed {
  return value === 'fast' || value === 'quality' ? value : 'standard';
}

function normalizeBaseUrl(value: string): string {
  const trimmed = requireTrimmed(value, 'Base URL');
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function requireTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

function assertKnownModelProfile(db: DatabaseSync, id: string): void {
  const row = db.prepare('SELECT id FROM model_profiles WHERE id = :id').get({ id });
  if (!row) {
    throw new Error(`Model profile ${id} does not exist.`);
  }
}

function assertKnownGroup(db: DatabaseSync, id: string): void {
  const row = db.prepare('SELECT id FROM chat_groups WHERE id = :id AND deleted_at IS NULL').get({ id });
  if (!row) {
    throw new Error(`Chat group ${id} does not exist.`);
  }
}
