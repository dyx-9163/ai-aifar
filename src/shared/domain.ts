export type ThemePreference = 'system' | 'light' | 'dark';

export type ThreadStatus = 'ready' | 'running' | 'failed';

export interface ThreadSummary {
  id: string;
  title: string;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
}

export type ItemKind = 'message' | 'tool' | 'change';

export interface BaseItem {
  id: string;
  threadId: string;
  turnId?: string;
  kind: ItemKind;
  createdAt: string;
}

export interface MessageItem extends BaseItem {
  kind: 'message';
  role: 'user' | 'assistant' | 'system';
  text: string;
}

export interface ToolItem extends BaseItem {
  kind: 'tool';
  title: string;
  status: 'running' | 'completed' | 'failed';
  output?: string;
}

export interface ChangeItem extends BaseItem {
  kind: 'change';
  path: string;
  action: 'created' | 'modified' | 'deleted';
  summary: string;
}

export type Item = MessageItem | ToolItem | ChangeItem;

export interface Approval {
  id: string;
  threadId: string;
  turnId: string;
  title: string;
  description: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  respondedAt?: string;
}

export interface AppSettings {
  theme: ThemePreference;
}

export interface AppSnapshot {
  threads: ThreadSummary[];
  items: Record<string, Item[]>;
  approvals: Approval[];
  settings: AppSettings;
}
