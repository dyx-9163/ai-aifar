import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  AppSnapshot,
  Approval,
  AppSettings,
  FileChangePreview,
  Item,
  LanguagePreference,
  MessageItem,
  ModelProfile,
  ModelProfileInput,
  ModelRunMetrics,
  ModelResponseSpeed,
  ReasoningItem,
  ReasoningProtocol,
  RuntimeSettingsInput,
  ThreadSummary,
  TurnRecord,
  UndoableTurnSummary,
  WorkspaceRecord,
  WorkspaceRegistrationInput,
  WorkspaceTrustLevel,
} from '../shared/domain.js';
import { normalizeModelBaseUrl } from '../shared/modelProfileUrl.js';
import {
  normalizeMaxConcurrency,
  normalizeMaxOutputTokens,
  normalizeModelCapabilities,
  normalizeProfileCapabilities,
  normalizeReasoningSettings,
} from './modelCapabilities.js';
import {
  isLegacyLocalQwenPlaceholder,
  LOCAL_QWEN_BASE_URL,
  LOCAL_QWEN_MODEL,
  localQwenProfileInput,
} from './localQwenProfile.js';

export interface AppDatabase {
  getSnapshot(): AppSnapshot;
  createThread(title: string, workspaceId?: string): ThreadSummary;
  deleteThread(threadId: string): void;
  setThreadPinned(threadId: string, pinned: boolean): void;
  bindThreadWorkspace(threadId: string, workspaceId: string): void;
  setThreadModel(threadId: string, modelProfileId?: string): void;
  setLanguage(language: LanguagePreference): void;
  updateSettings(settings: RuntimeSettingsInput): AppSettings;
  getThreadMessages(threadId: string, limit?: number): MessageItem[];
  createTurn(turn: TurnRecord): void;
  updateTurn(
    turnId: string,
    patch: Partial<Pick<TurnRecord, 'status' | 'startedAt' | 'completedAt' | 'error' | 'incomplete'>>,
  ): void;
  failTurn(turnId: string, completedAt: string, error: string): void;
  completeTurn(turnId: string, completedAt: string, metrics?: ModelRunMetrics): boolean;
  interruptUnfinishedTurns(): void;
  appendItem(item: Item): void;
  upsertApproval(approval: Approval): void;
  saveModelProfile(profile: ModelProfileInput): ModelProfile;
  deleteModelProfile(id: string): void;
  getModelProfileForRuntime(id?: string): RuntimeModelProfile | undefined;
  registerWorkspace(input: WorkspaceRegistrationInput): WorkspaceRecord;
  deleteWorkspace(workspaceId: string): void;
  setWorkspaceTrust(workspaceId: string, trustLevel: WorkspaceTrustLevel): WorkspaceRecord;
  getWorkspace(workspaceId: string): WorkspaceRecord | undefined;
  touchWorkspace(workspaceId: string): void;
  recordFileCheckpoint(input: FileCheckpointInput): void;
  listTurnCheckpoints(turnId: string): FileCheckpointRecord[];
  deleteTurnCheckpoints(turnId: string): void;
  close(): void;
}

export interface FileCheckpointInput {
  workspaceId: string;
  turnId: string;
  relativePath: string;
  previousAction: 'existed' | 'absent';
  /** The file content before the turn touched it; null when the file did not exist. */
  previousContent: string | null;
  /** SHA-256 of the pre-turn content; empty string when the file did not exist. */
  previousContentHash: string;
  /** SHA-256 of the content written by the latest patch in the turn. */
  latestContentHash: string;
}

export interface FileCheckpointRecord extends FileCheckpointInput {
  createdAt: string;
  updatedAt: string;
}

export type RuntimeModelProfile = ModelProfile & { apiKey?: string };

type ThreadRow = {
  id: string;
  workspace_id: string | null;
  pinned: number;
  title: string;
  status: ThreadSummary['status'];
  model_profile_id: string | null;
  created_at: string;
  updated_at: string;
};

type ItemRow = {
  thread_id: string;
  payload: string;
};

type TurnRow = {
  id: string;
  thread_id: string;
  model_profile_id: string | null;
  status: TurnRecord['status'];
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  incomplete: number;
  metrics: string | null;
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
  file_change: string | null;
};

type SettingRow = {
  key: string;
  value: string;
};

type WorkspaceRow = {
  id: string;
  display_name: string;
  root_path: string;
  canonical_root_path: string;
  trust_level: WorkspaceRecord['trustLevel'];
  network_policy: WorkspaceRecord['networkPolicy'];
  created_at: string;
  last_opened_at: string;
  updated_at: string;
};

type FileCheckpointRow = {
  workspace_id: string;
  turn_id: string;
  relative_path: string;
  previous_action: FileCheckpointRecord['previousAction'];
  previous_content: string | null;
  previous_content_hash: string;
  latest_content_hash: string;
  created_at: string;
  updated_at: string;
};

type UndoableTurnRow = {
  turn_id: string;
  workspace_id: string;
  file_count: number;
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
  max_concurrency: number;
  max_output_tokens: number;
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
    const threads = this.db
      .prepare(
        'SELECT id, workspace_id, pinned, title, status, model_profile_id, created_at, updated_at FROM threads WHERE deleted_at IS NULL ORDER BY updated_at DESC',
      )
      .all()
      .map((row) => mapThread(row as ThreadRow));

    const turns = this.db
      .prepare(
        `SELECT tr.id, tr.thread_id, tr.model_profile_id, tr.status, tr.created_at, tr.started_at, tr.completed_at, tr.error, tr.incomplete, tr.metrics
         FROM turns tr
         INNER JOIN threads t ON t.id = tr.thread_id
         WHERE t.deleted_at IS NULL
         ORDER BY tr.created_at ASC, tr.id ASC`,
      )
      .all()
      .map((row) => mapTurn(row as TurnRow));

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
        `SELECT a.id, a.thread_id, a.turn_id, a.title, a.description, a.status, a.created_at, a.responded_at, a.file_change
         FROM approvals a
         INNER JOIN threads t ON t.id = a.thread_id
         WHERE t.deleted_at IS NULL
         ORDER BY a.created_at ASC`,
      )
      .all()
      .map((row) => mapApproval(row as ApprovalRow));

    return {
      threads,
      turns,
      items,
      approvals,
      modelProfiles: this.readModelProfiles(false),
      settings: this.readSettings(),
      workspaces: this.readWorkspaces(),
      undoableTurns: this.db
        .prepare(
          `SELECT turn_id, workspace_id, COUNT(*) AS file_count
           FROM file_checkpoints
           GROUP BY turn_id, workspace_id`,
        )
        .all()
        .map((row) => mapUndoableTurn(row as UndoableTurnRow)),
    };
  }

  createThread(title: string, workspaceId?: string): ThreadSummary {
    const now = new Date().toISOString();
    const boundWorkspaceId = workspaceId === undefined || workspaceId === '' ? undefined : workspaceId;
    if (boundWorkspaceId !== undefined && !this.getWorkspace(boundWorkspaceId)) {
      throw new Error(`Workspace ${boundWorkspaceId} does not exist.`);
    }
    const thread: ThreadSummary = {
      id: randomUUID(),
      workspaceId: boundWorkspaceId,
      pinned: false,
      title,
      status: 'ready',
      modelProfileId: this.readSettings().activeModelProfileId,
      createdAt: now,
      updatedAt: now,
    };

    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO threads (id, workspace_id, pinned, title, status, model_profile_id, created_at, updated_at, deleted_at)
           VALUES (:id, :workspaceId, :pinned, :title, :status, :modelProfileId, :createdAt, :updatedAt, NULL)`,
        )
        .run({
          id: thread.id,
          workspaceId: thread.workspaceId ?? null,
          pinned: 0,
          title: thread.title,
          status: thread.status,
          modelProfileId: thread.modelProfileId ?? null,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
        });
    });

    return thread;
  }

  setThreadPinned(threadId: string, pinned: boolean): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare('UPDATE threads SET pinned = :pinned, updated_at = :updatedAt WHERE id = :threadId')
        .run({ threadId, pinned: pinned ? 1 : 0, updatedAt: now });
    });
  }

  bindThreadWorkspace(threadId: string, workspaceId: string): void {
    if (!this.getWorkspace(workspaceId)) {
      throw new Error(`Workspace ${workspaceId} does not exist.`);
    }
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare('UPDATE threads SET workspace_id = :workspaceId, updated_at = :updatedAt WHERE id = :threadId')
        .run({ threadId, workspaceId, updatedAt: now });
    });
  }

  deleteThread(threadId: string): void {
    const deletedAt = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare('UPDATE threads SET deleted_at = :deletedAt, updated_at = :deletedAt WHERE id = :threadId')
        .run({ threadId, deletedAt });
      this.db
        .prepare(
          `DELETE FROM file_checkpoints WHERE turn_id IN (
             SELECT id FROM turns WHERE thread_id = :threadId
           )`,
        )
        .run({ threadId });
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
      if (settings.reasoningDisplayMode === 'auto' || settings.reasoningDisplayMode === 'raw' || settings.reasoningDisplayMode === 'summary') {
        this.upsertSetting('reasoningDisplayMode', settings.reasoningDisplayMode);
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

  createTurn(turn: TurnRecord): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO turns (id, thread_id, model_profile_id, status, created_at, started_at, completed_at, error, incomplete, updated_at)
           VALUES (:id, :threadId, :modelProfileId, :status, :createdAt, :startedAt, :completedAt, :error, :incomplete, :updatedAt)`,
        )
        .run({
          id: turn.id,
          threadId: turn.threadId,
          modelProfileId: turn.modelProfileId ?? null,
          status: turn.status,
          createdAt: turn.createdAt,
          startedAt: turn.startedAt ?? null,
          completedAt: turn.completedAt ?? null,
          error: turn.error ?? null,
          incomplete: turn.incomplete ? 1 : 0,
          updatedAt: turn.completedAt ?? turn.startedAt ?? turn.createdAt,
        });
    });
  }

  updateTurn(
    turnId: string,
    patch: Partial<Pick<TurnRecord, 'status' | 'startedAt' | 'completedAt' | 'error' | 'incomplete'>>,
  ): void {
    const assignments: string[] = [];
    const values: Record<string, string | number | null> = { turnId, updatedAt: new Date().toISOString() };
    if (patch.status !== undefined) {
      assignments.push('status = :status');
      values.status = patch.status;
    }
    if (patch.startedAt !== undefined) {
      assignments.push('started_at = :startedAt');
      values.startedAt = patch.startedAt;
    }
    if (patch.completedAt !== undefined) {
      assignments.push('completed_at = :completedAt');
      values.completedAt = patch.completedAt;
    }
    if (patch.error !== undefined) {
      assignments.push('error = :error');
      values.error = patch.error;
    }
    if (patch.incomplete !== undefined) {
      assignments.push('incomplete = :incomplete');
      values.incomplete = patch.incomplete ? 1 : 0;
    }
    if (assignments.length === 0) {
      return;
    }

    this.transaction(() => {
      this.db
        .prepare(`UPDATE turns SET ${assignments.join(', ')}, updated_at = :updatedAt WHERE id = :turnId`)
        .run(values);
    });
  }

  failTurn(turnId: string, completedAt: string, error: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE turns
           SET status = 'failed', completed_at = :completedAt, error = :error, incomplete = 1, updated_at = :completedAt
           WHERE id = :turnId`,
        )
        .run({ turnId, completedAt, error });
      this.db
        .prepare(
          `UPDATE approvals
           SET status = 'rejected', responded_at = :respondedAt
           WHERE turn_id = :turnId AND status = 'pending'`,
        )
        .run({ turnId, respondedAt: completedAt });
    });
  }

  completeTurn(turnId: string, completedAt: string, metrics?: ModelRunMetrics): boolean {
    let completed = false;
    this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE turns
           SET status = 'completed', completed_at = :completedAt, incomplete = 0,
               metrics = COALESCE(:metrics, metrics), updated_at = :completedAt
           WHERE id = :turnId AND status = 'running'`,
        )
        .run({ turnId, completedAt, metrics: metrics ? JSON.stringify(metrics) : null });
      if (result.changes !== 1) return;
      completed = true;

      const rows = this.db
        .prepare(`SELECT id, payload FROM items WHERE turn_id = :turnId AND kind IN ('message', 'reasoning')`)
        .all({ turnId }) as Array<{ id: string; payload: string }>;
      const updatePayload = this.db.prepare('UPDATE items SET payload = :payload WHERE id = :id');
      for (const row of rows) {
        const item = parseItem(row.payload);
        if (item && ((item.kind === 'reasoning') || (item.kind === 'message' && item.role === 'assistant'))) {
          updatePayload.run({ id: row.id, payload: JSON.stringify({ ...item, incomplete: false }) });
        }
      }
    });
    return completed;
  }

  interruptUnfinishedTurns(): void {
    const interruptedAt = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE turns
           SET status = 'interrupted', updated_at = :updatedAt
           WHERE status IN ('queued', 'running', 'cancelling')`,
        )
        .run({ updatedAt: interruptedAt });
      this.db
        .prepare(
          `UPDATE approvals
           SET status = 'rejected', responded_at = :respondedAt
           WHERE status = 'pending'
             AND turn_id IN (
               SELECT id FROM turns
               WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted')
             )`,
        )
        .run({ respondedAt: interruptedAt });
    });
  }

  appendItem(item: Item): void {
    this.transaction(() => {
      if (item.turnId) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO turns (id, thread_id, status, created_at, incomplete, updated_at)
             VALUES (:id, :threadId, :status, :createdAt, :incomplete, :updatedAt)`,
          )
          .run({
            id: item.turnId,
            threadId: item.threadId,
            status: 'running',
            createdAt: item.createdAt,
            incomplete: 1,
            updatedAt: item.createdAt,
          });
      }

      this.insertOrMergeItem(item);

      this.db
        .prepare('UPDATE threads SET updated_at = :updatedAt WHERE id = :threadId')
        .run({ updatedAt: item.createdAt, threadId: item.threadId });
    });
  }

  upsertApproval(approval: Approval): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO approvals (id, thread_id, turn_id, title, description, status, created_at, responded_at, file_change)
           VALUES (:id, :threadId, :turnId, :title, :description, :status, :createdAt, :respondedAt, :fileChange)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             description = excluded.description,
             status = excluded.status,
             responded_at = excluded.responded_at,
             file_change = excluded.file_change`,
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
          fileChange: approval.fileChange ? JSON.stringify(approval.fileChange) : null,
        });
    });
  }

  saveModelProfile(input: ModelProfileInput): ModelProfile {
    const now = new Date().toISOString();
    const existing = input.id ? this.getModelProfileForRuntime(input.id) : undefined;
    const reasoningInput = { ...existing?.reasoning, ...input.reasoning };
    const capabilities = normalizeProfileCapabilities(
      input.capabilities,
      existing?.capabilities,
      reasoningInput.protocol ?? 'none',
    );
    const reasoning = normalizeReasoningSettings(reasoningInput, capabilities);
    const profile: RuntimeModelProfile = {
      id: input.id ?? randomUUID(),
      name: requireTrimmed(input.name, 'Model profile name'),
      provider: input.provider,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      model: requireTrimmed(input.model, 'Model name'),
      apiKey: input.apiKey?.trim() || existing?.apiKey,
      apiKeyConfigured: Boolean(input.apiKey?.trim() || existing?.apiKey),
      capabilities,
      reasoning,
      maxConcurrency: normalizeMaxConcurrency(
        input.maxConcurrency ?? existing?.maxConcurrency ?? capabilities.concurrency.defaultLimit,
        capabilities,
      ),
      maxOutputTokens: normalizeMaxOutputTokens(input.maxOutputTokens ?? existing?.maxOutputTokens),
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
          `INSERT INTO model_profiles (id, name, provider, base_url, model, api_key, capabilities, reasoning, max_concurrency, max_output_tokens, response_speed, is_default, created_at, updated_at)
           VALUES (:id, :name, :provider, :baseUrl, :model, :apiKey, :capabilities, :reasoning, :maxConcurrency, :maxOutputTokens, :responseSpeed, :isDefault, :createdAt, :updatedAt)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             provider = excluded.provider,
             base_url = excluded.base_url,
             model = excluded.model,
             api_key = excluded.api_key,
             capabilities = excluded.capabilities,
             reasoning = excluded.reasoning,
             max_concurrency = excluded.max_concurrency,
             max_output_tokens = excluded.max_output_tokens,
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
          maxConcurrency: profile.maxConcurrency,
          maxOutputTokens: profile.maxOutputTokens,
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

  registerWorkspace(input: WorkspaceRegistrationInput): WorkspaceRecord {
    const now = new Date().toISOString();
    const canonicalRootPath = requireTrimmed(input.canonicalRootPath, 'Workspace path');
    const existing = this.db
      .prepare('SELECT * FROM workspaces WHERE canonical_root_path = :canonicalRootPath')
      .get({ canonicalRootPath }) as WorkspaceRow | undefined;

    if (existing) {
      this.transaction(() => {
        this.db
          .prepare(
            `UPDATE workspaces
             SET display_name = :displayName, trust_level = :trustLevel, last_opened_at = :lastOpenedAt, updated_at = :updatedAt
             WHERE id = :id`,
          )
          .run({
            id: existing.id,
            displayName: requireTrimmed(input.displayName, 'Workspace name'),
            trustLevel: input.trustLevel,
            lastOpenedAt: now,
            updatedAt: now,
          });
      });
      return mapWorkspace({
        ...existing,
        display_name: requireTrimmed(input.displayName, 'Workspace name'),
        trust_level: input.trustLevel,
        last_opened_at: now,
        updated_at: now,
      });
    }

    const record: WorkspaceRecord = {
      id: randomUUID(),
      displayName: requireTrimmed(input.displayName, 'Workspace name'),
      rootPath: requireTrimmed(input.rootPath, 'Workspace path'),
      canonicalRootPath,
      trustLevel: input.trustLevel,
      networkPolicy: 'disabled',
      createdAt: now,
      lastOpenedAt: now,
    };

    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workspaces (id, display_name, root_path, canonical_root_path, trust_level, network_policy, created_at, last_opened_at, updated_at)
           VALUES (:id, :displayName, :rootPath, :canonicalRootPath, :trustLevel, :networkPolicy, :createdAt, :lastOpenedAt, :updatedAt)`,
        )
        .run({
          id: record.id,
          displayName: record.displayName,
          rootPath: record.rootPath,
          canonicalRootPath: record.canonicalRootPath,
          trustLevel: record.trustLevel,
          networkPolicy: record.networkPolicy,
          createdAt: record.createdAt,
          lastOpenedAt: record.lastOpenedAt,
          updatedAt: now,
        });
    });

    return record;
  }

  deleteWorkspace(workspaceId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM workspaces WHERE id = :workspaceId').run({ workspaceId });
      this.db.prepare('DELETE FROM file_checkpoints WHERE workspace_id = :workspaceId').run({ workspaceId });
      this.db.prepare('UPDATE threads SET workspace_id = NULL WHERE workspace_id = :workspaceId').run({ workspaceId });
    });
  }

  setWorkspaceTrust(workspaceId: string, trustLevel: WorkspaceTrustLevel): WorkspaceRecord {
    if (!this.getWorkspace(workspaceId)) {
      throw new Error(`Workspace ${workspaceId} does not exist.`);
    }
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare('UPDATE workspaces SET trust_level = :trustLevel, updated_at = :updatedAt WHERE id = :workspaceId')
        .run({ workspaceId, trustLevel, updatedAt: now });
    });
    const updated = this.getWorkspace(workspaceId);
    if (!updated) {
      throw new Error(`Workspace ${workspaceId} does not exist.`);
    }
    return updated;
  }

  getWorkspace(workspaceId: string): WorkspaceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = :workspaceId').get({ workspaceId }) as
      | WorkspaceRow
      | undefined;
    return row ? mapWorkspace(row) : undefined;
  }

  touchWorkspace(workspaceId: string): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare('UPDATE workspaces SET last_opened_at = :lastOpenedAt, updated_at = :updatedAt WHERE id = :workspaceId')
        .run({ workspaceId, lastOpenedAt: now, updatedAt: now });
    });
  }

  recordFileCheckpoint(input: FileCheckpointInput): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT id FROM file_checkpoints
           WHERE workspace_id = :workspaceId AND turn_id = :turnId AND relative_path = :relativePath`,
        )
        .get({ workspaceId: input.workspaceId, turnId: input.turnId, relativePath: input.relativePath });
      if (existing) {
        // The pre-turn state is immutable; only the latest written hash moves forward.
        this.db
          .prepare(
            `UPDATE file_checkpoints SET latest_content_hash = :latestContentHash, updated_at = :updatedAt
             WHERE workspace_id = :workspaceId AND turn_id = :turnId AND relative_path = :relativePath`,
          )
          .run({
            latestContentHash: input.latestContentHash,
            updatedAt: now,
            workspaceId: input.workspaceId,
            turnId: input.turnId,
            relativePath: input.relativePath,
          });
        return;
      }
      this.db
        .prepare(
          `INSERT INTO file_checkpoints (
             workspace_id, turn_id, relative_path, previous_action, previous_content,
             previous_content_hash, latest_content_hash, created_at, updated_at
           ) VALUES (
             :workspaceId, :turnId, :relativePath, :previousAction, :previousContent,
             :previousContentHash, :latestContentHash, :createdAt, :updatedAt
           )`,
        )
        .run({
          workspaceId: input.workspaceId,
          turnId: input.turnId,
          relativePath: input.relativePath,
          previousAction: input.previousAction,
          previousContent: input.previousContent,
          previousContentHash: input.previousContentHash,
          latestContentHash: input.latestContentHash,
          createdAt: now,
          updatedAt: now,
        });
    });
  }

  listTurnCheckpoints(turnId: string): FileCheckpointRecord[] {
    return this.db
      .prepare('SELECT * FROM file_checkpoints WHERE turn_id = :turnId ORDER BY id ASC')
      .all({ turnId })
      .map((row) => mapFileCheckpoint(row as FileCheckpointRow));
  }

  deleteTurnCheckpoints(turnId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM file_checkpoints WHERE turn_id = :turnId').run({ turnId });
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
        model_profile_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error TEXT,
        incomplete INTEGER NOT NULL DEFAULT 1,
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
        responded_at TEXT,
        file_change TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        canonical_root_path TEXT NOT NULL UNIQUE,
        trust_level TEXT NOT NULL,
        network_policy TEXT NOT NULL DEFAULT 'disabled',
        created_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        previous_action TEXT NOT NULL,
        previous_content TEXT,
        previous_content_hash TEXT NOT NULL,
        latest_content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, turn_id, relative_path)
      );

      CREATE TABLE IF NOT EXISTS model_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key TEXT,
        capabilities TEXT NOT NULL,
        max_concurrency INTEGER NOT NULL DEFAULT 1,
        max_output_tokens INTEGER NOT NULL DEFAULT 2048,
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
      INSERT OR IGNORE INTO settings (key, value) VALUES ('reasoningDisplayMode', 'auto');
    `);
    this.ensureColumn('threads', 'model_profile_id', 'ALTER TABLE threads ADD COLUMN model_profile_id TEXT');
    this.ensureColumn('threads', 'deleted_at', 'ALTER TABLE threads ADD COLUMN deleted_at TEXT');
    this.ensureColumn('turns', 'model_profile_id', 'ALTER TABLE turns ADD COLUMN model_profile_id TEXT');
    this.ensureColumn('turns', 'started_at', 'ALTER TABLE turns ADD COLUMN started_at TEXT');
    this.ensureColumn('turns', 'completed_at', 'ALTER TABLE turns ADD COLUMN completed_at TEXT');
    this.ensureColumn('turns', 'error', 'ALTER TABLE turns ADD COLUMN error TEXT');
    this.ensureColumn('turns', 'incomplete', 'ALTER TABLE turns ADD COLUMN incomplete INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn(
      'model_profiles',
      'reasoning',
      'ALTER TABLE model_profiles ADD COLUMN reasoning TEXT NOT NULL DEFAULT \'{"mode":"disabled","protocol":"none","effort":"medium"}\'',
    );
    this.ensureColumn(
      'model_profiles',
      'max_concurrency',
      'ALTER TABLE model_profiles ADD COLUMN max_concurrency INTEGER NOT NULL DEFAULT 1',
    );
    this.ensureColumn(
      'model_profiles',
      'response_speed',
      "ALTER TABLE model_profiles ADD COLUMN response_speed TEXT NOT NULL DEFAULT 'standard'",
    );
    this.applyMigration(2, () => this.compactAssistantMessageFragments());
    this.applyMigration(3, () => this.migrateLegacyTurnCompletion());
    this.applyMigration(4, () => this.ensureColumn('turns', 'metrics', 'ALTER TABLE turns ADD COLUMN metrics TEXT'));
    this.applyMigration(5, () => this.repairMislabelledLegacyCompletion());
    this.applyMigration(6, () => this.ensureColumn(
      'model_profiles',
      'max_output_tokens',
      'ALTER TABLE model_profiles ADD COLUMN max_output_tokens INTEGER NOT NULL DEFAULT 2048',
    ));
    this.applyMigration(8, () => this.ensureColumn('approvals', 'file_change', 'ALTER TABLE approvals ADD COLUMN file_change TEXT'));
    this.applyMigration(7, () => this.repairOrSeedLocalQwenProfile());
    this.applyMigration(9, () => {
      this.ensureColumn('threads', 'workspace_id', 'ALTER TABLE threads ADD COLUMN workspace_id TEXT');
      this.ensureColumn('threads', 'pinned', 'ALTER TABLE threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    });
    this.interruptUnfinishedTurns();
  }

  private readWorkspaces(): WorkspaceRecord[] {
    return this.db
      .prepare('SELECT * FROM workspaces ORDER BY last_opened_at DESC, display_name ASC')
      .all()
      .map((row) => mapWorkspace(row as WorkspaceRow));
  }

  private readSettings(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as SettingRow[];
    const theme = rows.find((row) => row.key === 'theme')?.value;
    const language = rows.find((row) => row.key === 'language')?.value;
    const showModelMetrics = rows.find((row) => row.key === 'showModelMetrics')?.value;
    const contextMessageLimit = rows.find((row) => row.key === 'contextMessageLimit')?.value;
    const reasoningDisplayMode = rows.find((row) => row.key === 'reasoningDisplayMode')?.value;
    const configuredActiveModelProfileId = rows.find((row) => row.key === 'activeModelProfileId')?.value || undefined;
    const activeModelProfileId = configuredActiveModelProfileId || this.defaultModelProfileId();
    return {
      theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system',
      language: language === 'zh-CN' || language === 'en-US' ? language : 'en-US',
      activeModelProfileId,
      showModelMetrics: showModelMetrics === undefined ? true : showModelMetrics === 'true',
      contextMessageLimit: clampContextLimit(Number.parseInt(contextMessageLimit ?? '20', 10)),
      reasoningDisplayMode:
        reasoningDisplayMode === 'raw' || reasoningDisplayMode === 'summary' ? reasoningDisplayMode : 'auto',
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

  private upsertSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (:key, :value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ key, value });
  }

  private insertOrMergeItem(item: Item): void {
    const streamKey = logicalStreamKey(item);
    if (streamKey) {
      const candidates = this.db
        .prepare(
          `SELECT id, payload
           FROM items
           WHERE thread_id = :threadId AND turn_id = :turnId
           ORDER BY created_at ASC, id ASC`,
        )
        .all({ threadId: item.threadId, turnId: item.turnId ?? null }) as Array<{ id: string; payload: string }>;
      const existing = candidates
        .map((candidate) => ({ ...candidate, item: parseItem(candidate.payload) }))
        .find((candidate) => candidate.item && logicalStreamKey(candidate.item) === streamKey);
      if (existing?.item && isTextStreamItem(existing.item) && isTextStreamItem(item)) {
        this.db
          .prepare('UPDATE items SET payload = :payload WHERE id = :id')
          .run({ id: existing.id, payload: JSON.stringify({ ...existing.item, text: existing.item.text + item.text }) });
        return;
      }
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
  }

  private applyMigration(version: number, work: () => void): void {
    const applied = this.db.prepare('SELECT version FROM schema_migrations WHERE version = :version').get({ version });
    if (applied) {
      return;
    }

    this.transaction(() => {
      work();
      this.db
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (:version, :appliedAt)')
        .run({ version, appliedAt: new Date().toISOString() });
    });
  }

  private compactAssistantMessageFragments(): void {
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, turn_id, payload
         FROM items
         WHERE kind = 'message' AND turn_id IS NOT NULL
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as Array<{ id: string; thread_id: string; turn_id: string; payload: string }>;
    const groups = new Map<string, Array<{ id: string; item: MessageItem }>>();

    for (const row of rows) {
      const item = parseMessageItem(row.payload);
      if (!item || item.role !== 'assistant') {
        continue;
      }
      const key = `${row.thread_id}\u0000${row.turn_id}`;
      const group = groups.get(key) ?? [];
      group.push({ id: row.id, item });
      groups.set(key, group);
    }

    const update = this.db.prepare('UPDATE items SET payload = :payload WHERE id = :id');
    const remove = this.db.prepare('DELETE FROM items WHERE id = :id');
    for (const group of groups.values()) {
      if (group.length < 2) {
        continue;
      }
      const [first, ...fragments] = group;
      const merged = { ...first.item, text: group.map((entry) => entry.item.text).join('') };
      update.run({ id: first.id, payload: JSON.stringify(merged) });
      for (const fragment of fragments) {
        remove.run({ id: fragment.id });
      }
    }
  }

  private migrateLegacyTurnCompletion(): void {
    this.completeLegacyTurns('running');
  }

  private repairMislabelledLegacyCompletion(): void {
    this.completeLegacyTurns('interrupted');
  }

  private repairOrSeedLocalQwenProfile(): void {
    const preset = localQwenProfileInput();
    const rows = this.db
      .prepare('SELECT id, provider, base_url, model, capabilities FROM model_profiles')
      .all() as Array<{ id: string; provider: ModelProfile['provider']; base_url: string; model: string; capabilities: string }>;
    const placeholders = rows.filter((row) => isLegacyLocalQwenPlaceholder({
      provider: row.provider,
      baseUrl: row.base_url,
      model: row.model,
    }));

    if (placeholders.length > 0) {
      const update = this.db.prepare(`
        UPDATE model_profiles
        SET model = :model,
            capabilities = :capabilities,
            reasoning = :reasoning,
            max_concurrency = :maxConcurrency,
            max_output_tokens = :maxOutputTokens,
            updated_at = :updatedAt
        WHERE id = :id
      `);
      const updatedAt = new Date().toISOString();
      for (const placeholder of placeholders) {
        update.run({
          id: placeholder.id,
          model: preset.model,
          capabilities: JSON.stringify(preset.capabilities),
          reasoning: JSON.stringify(preset.reasoning),
          maxConcurrency: preset.maxConcurrency,
          maxOutputTokens: preset.maxOutputTokens,
          updatedAt,
        });
      }
      return;
    }

    const equivalentRows = rows.filter((row) =>
      row.provider === 'openai-compatible' &&
      row.base_url === LOCAL_QWEN_BASE_URL &&
      row.model === LOCAL_QWEN_MODEL);
    if (equivalentRows.length > 0) {
      const updateCapabilities = this.db.prepare(`
        UPDATE model_profiles
        SET capabilities = :capabilities,
            updated_at = :updatedAt
        WHERE id = :id
      `);
      const updatedAt = new Date().toISOString();
      for (const row of equivalentRows) {
        const capabilities = parseCapabilities(row.capabilities, 'qwen');
        if (!capabilities.vision) {
          updateCapabilities.run({
            id: row.id,
            capabilities: JSON.stringify({ ...capabilities, vision: true }),
            updatedAt,
          });
        }
      }
      return;
    }

    const occupiedIds = new Set(rows.map((row) => row.id));
    let presetId = preset.id;
    for (let suffix = 2; occupiedIds.has(presetId); suffix += 1) {
      presetId = `${preset.id}-${suffix}`;
    }

    const now = new Date().toISOString();
    const isDefault = this.defaultModelProfileId() === undefined;
    this.db.prepare(`
      INSERT INTO model_profiles (
        id, name, provider, base_url, model, api_key, capabilities, reasoning,
        max_concurrency, max_output_tokens, response_speed, is_default, created_at, updated_at
      ) VALUES (
        :id, :name, :provider, :baseUrl, :model, NULL, :capabilities, :reasoning,
        :maxConcurrency, :maxOutputTokens, 'standard', :isDefault, :createdAt, :updatedAt
      )
    `).run({
      id: presetId,
      name: preset.name,
      provider: preset.provider,
      baseUrl: preset.baseUrl,
      model: preset.model,
      capabilities: JSON.stringify(preset.capabilities),
      reasoning: JSON.stringify(preset.reasoning),
      maxConcurrency: preset.maxConcurrency,
      maxOutputTokens: preset.maxOutputTokens,
      isDefault: isDefault ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    });
    if (isDefault) {
      this.upsertSetting('activeModelProfileId', presetId);
    }
  }

  private completeLegacyTurns(status: 'running' | 'interrupted'): void {
    const rows = this.db
      .prepare(
        `SELECT tr.id AS turn_id, i.id AS item_id, i.payload, i.created_at
         FROM turns tr
         INNER JOIN items i ON i.turn_id = tr.id
         WHERE tr.status = :status
           AND tr.incomplete = 1
           AND tr.completed_at IS NULL
           AND tr.error IS NULL
           AND i.kind = 'message'
         ORDER BY i.created_at ASC, i.id ASC`,
      )
      .all({ status }) as Array<{ turn_id: string; item_id: string; payload: string; created_at: string }>;
    const candidates = new Map<string, {
      completedAt: string;
      assistantItems: Array<{ id: string; item: MessageItem }>;
      hasExplicitStreamState: boolean;
    }>();
    for (const row of rows) {
      const item = parseMessageItem(row.payload);
      if (!item || item.role !== 'assistant') continue;
      const entry = candidates.get(row.turn_id) ?? {
        completedAt: row.created_at,
        assistantItems: [],
        hasExplicitStreamState: false,
      };
      entry.completedAt = row.created_at;
      entry.assistantItems.push({ id: row.item_id, item });
      entry.hasExplicitStreamState ||= Object.prototype.hasOwnProperty.call(item, 'incomplete');
      candidates.set(row.turn_id, entry);
    }

    const updateTurn = this.db.prepare(
      `UPDATE turns
       SET status = 'completed', completed_at = :completedAt, incomplete = 0, updated_at = :completedAt
       WHERE id = :turnId
         AND status = :status
         AND incomplete = 1
         AND completed_at IS NULL
         AND error IS NULL`,
    );
    const updateItem = this.db.prepare('UPDATE items SET payload = :payload WHERE id = :id');
    for (const [turnId, entry] of candidates) {
      // Before streamed rows gained an explicit `incomplete` flag, a non-empty
      // assistant row was the only durable evidence that the legacy run had
      // delivered its final answer. Any explicit stream state is ambiguous and
      // stays interrupted so a genuinely partial answer is never promoted.
      if (entry.hasExplicitStreamState || !entry.assistantItems.some(({ item }) => item.text.trim().length > 0)) {
        continue;
      }
      const result = updateTurn.run({ turnId, completedAt: entry.completedAt, status });
      if (result.changes !== 1) continue;
      for (const assistant of entry.assistantItems) {
        updateItem.run({ id: assistant.id, payload: JSON.stringify({ ...assistant.item, incomplete: false }) });
      }
    }
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

function parseMessageItem(payload: string): MessageItem | undefined {
  try {
    const item = JSON.parse(payload) as Partial<MessageItem>;
    return item.kind === 'message' && typeof item.text === 'string' && typeof item.role === 'string'
      ? (item as MessageItem)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseItem(payload: string): Item | undefined {
  try {
    const item = JSON.parse(payload) as Partial<Item>;
    return typeof item.kind === 'string' && typeof item.id === 'string' && typeof item.threadId === 'string'
      ? (item as Item)
      : undefined;
  } catch {
    return undefined;
  }
}

function logicalStreamKey(item: Item): string | undefined {
  if (item.kind === 'message' && item.role === 'assistant' && item.turnId) {
    return `answer:${item.turnId}`;
  }
  if (item.kind === 'reasoning' && item.turnId) {
    return `reasoning:${item.mode}:${item.turnId}`;
  }
  return undefined;
}

function isTextStreamItem(item: Item): item is MessageItem | ReasoningItem {
  return item.kind === 'reasoning' || (item.kind === 'message' && item.role === 'assistant');
}

function mapTurn(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    modelProfileId: row.model_profile_id ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    incomplete: row.incomplete === 1,
    metrics: parseModelRunMetrics(row.metrics),
  };
}

function parseModelRunMetrics(value: string | null): ModelRunMetrics | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<ModelRunMetrics>;
    if (
      typeof parsed !== 'object'
      || parsed === null
      || !Number.isFinite(parsed.durationMs)
      || !['auto', 'enabled', 'disabled'].includes(parsed.reasoningRequested ?? '')
      || !['none', 'qwen', 'openai', 'custom'].includes(parsed.reasoningProtocol ?? '')
      || typeof parsed.reasoningObserved !== 'boolean'
      || !['server', 'client', 'unavailable'].includes(parsed.speedSource ?? '')
      || !['server', 'client', 'unavailable'].includes(parsed.usageSource ?? '')
    ) {
      return undefined;
    }
    return parsed as ModelRunMetrics;
  } catch {
    return undefined;
  }
}

function mapThread(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    pinned: row.pinned === 1,
    title: row.title,
    status: row.status,
    modelProfileId: row.model_profile_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFileCheckpoint(row: FileCheckpointRow): FileCheckpointRecord {
  return {
    workspaceId: row.workspace_id,
    turnId: row.turn_id,
    relativePath: row.relative_path,
    previousAction: row.previous_action,
    previousContent: row.previous_content,
    previousContentHash: row.previous_content_hash,
    latestContentHash: row.latest_content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapUndoableTurn(row: UndoableTurnRow): UndoableTurnSummary {
  return {
    turnId: row.turn_id,
    workspaceId: row.workspace_id,
    fileCount: Number(row.file_count),
  };
}

function mapWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    rootPath: row.root_path,
    canonicalRootPath: row.canonical_root_path,
    trustLevel: row.trust_level === 'read-write' ? 'read-write' : 'read-only',
    networkPolicy: row.network_policy === 'allowlisted' ? 'allowlisted' : 'disabled',
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
  };
}

function mapApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    title: row.title,
    description: row.description,
    ...(row.file_change ? { fileChange: JSON.parse(row.file_change) as FileChangePreview } : {}),
    status: row.status,
    createdAt: row.created_at,
    respondedAt: row.responded_at ?? undefined,
  };
}

function mapModelProfile(row: ModelProfileRow, includeApiKey: true): RuntimeModelProfile;
function mapModelProfile(row: ModelProfileRow, includeApiKey: false): ModelProfile;
function mapModelProfile(row: ModelProfileRow, includeApiKey: boolean): RuntimeModelProfile | ModelProfile {
  const reasoningInput = parseReasoningInput(row.reasoning);
  const capabilities = parseCapabilities(row.capabilities, reasoningInput.protocol ?? 'none');
  const reasoning = normalizeReasoningSettings(reasoningInput, capabilities);
  const profile: RuntimeModelProfile = {
    id: row.id,
    name: row.name,
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    apiKey: includeApiKey ? (row.api_key ?? undefined) : undefined,
    apiKeyConfigured: Boolean(row.api_key),
    capabilities,
    reasoning,
    maxConcurrency: normalizeMaxConcurrency(row.max_concurrency, capabilities),
    maxOutputTokens: normalizeMaxOutputTokens(row.max_output_tokens),
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

function parseCapabilities(value: string, reasoningProtocol: ReasoningProtocol) {
  try {
    return normalizeModelCapabilities(JSON.parse(value), reasoningProtocol);
  } catch {
    return normalizeModelCapabilities(undefined, reasoningProtocol);
  }
}

function parseReasoningInput(value: string | null | undefined): NonNullable<ModelProfileInput['reasoning']> {
  try {
    const parsed = JSON.parse(value || '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as NonNullable<ModelProfileInput['reasoning']>
      : {};
  } catch {
    return {};
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
  return normalizeModelBaseUrl(trimmed);
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
