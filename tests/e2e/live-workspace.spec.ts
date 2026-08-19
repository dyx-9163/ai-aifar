import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from 'playwright/test';
import { openDatabase } from '../../src/agent/database';

const liveBaseUrl = (process.env.PRIVATE_AI_LIVE_MODEL_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
const liveModelName = process.env.PRIVATE_AI_LIVE_MODEL_NAME ?? 'Qwen3.5-9B';
const liveApiKey = process.env.PRIVATE_AI_LIVE_MODEL_API_KEY?.trim();
const liveOptIn = process.env.PRIVATE_AI_LIVE_MODEL_E2E === '1';
const packagedExecutable = join(process.cwd(), 'out', 'Private AI Desktop-win32-x64', 'Private AI Desktop.exe');

test('a real agent turn writes into a read-write workspace and undo restores it', async () => {
  test.setTimeout(300_000);
  test.skip(
    !liveOptIn,
    'Live model skipped: set PRIVATE_AI_LIVE_MODEL_E2E=1 to opt in to the real endpoint.',
  );
  const probe = await probeLiveEndpoint();
  test.skip(!probe.reachable, probe.reason);

  const workspaceRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'private-ai-live-ws-')));
  writeFileSync(join(workspaceRoot, 'README.md'), '# live workspace\n');
  const before = snapshotDirectory(workspaceRoot);

  const userData = mkdtempSync(join(tmpdir(), 'private-ai-live-ws-app-'));
  const database = openDatabase(join(userData, 'app.sqlite'));
  const profile = database.saveModelProfile({
    name: 'Live Qwen workspace',
    provider: 'openai-compatible',
    baseUrl: liveBaseUrl,
    model: liveModelName,
    apiKey: liveApiKey,
    capabilities: {
      text: true,
      vision: false,
      longContext: false,
      reasoning: { inputMode: 'toggle', effortOptions: [], outputModes: ['raw'] },
      concurrency: { defaultLimit: 1, configurable: true, maxLimit: 4 },
      streaming: true,
      usage: { tokens: true, reasoningTokens: true },
    },
    reasoning: { mode: 'disabled', protocol: 'none' },
    maxConcurrency: 1,
    maxOutputTokens: 4096,
    isDefault: true,
  });
  const workspace = database.registerWorkspace({
    displayName: 'live-workspace',
    rootPath: workspaceRoot,
    canonicalRootPath: workspaceRoot,
    trustLevel: 'read-write',
  });
  const thread = database.createThread('Live workspace turn');
  database.close();

  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      executablePath: packagedExecutable,
      args: [],
      env: { ...process.env, PRIVATE_AI_DESKTOP_USER_DATA: userData },
    });
    const page = await app.firstWindow();

    await page.getByTestId(`thread-row-${thread.id}`).getByRole('button').first().click();
    await page.getByTestId('composer-workspace-select').selectOption(workspace.id);
    await page.getByTestId('composer-input').fill(
      '请使用 apply_patch 工具在工作区根目录创建一个新文件 hello.ts，内容只有一行：export const hello = "world"; '
      + '创建成功后用一句简短中文确认，不要再调用其他工具。',
    );
    await page.getByTestId('composer-send').click();

    // apply_patch is gated by approval; the panel must show the diff first.
    const approveButton = page.getByTestId('approval-approve-button');
    await expect(approveButton).toBeVisible({ timeout: 240_000 });
    const fileChange = page.getByTestId('approval-file-change');
    await expect(fileChange).toBeVisible();
    await expect(page.getByTestId('approval-file-change-path')).toContainText('hello.ts');
    await expect(fileChange).toContainText('export const hello');
    await approveButton.click();

    const runtime = page.getByTestId(`thread-row-${thread.id}`).getByTestId('thread-runtime-status');
    await expect.poll(
      () => runtime.getAttribute('data-runtime-status'),
      { timeout: 240_000 },
    ).toMatch(/^(completed|failed)$/);

    const snapshot = await page.evaluate(() => window.desktop.getSnapshot());
    const turn = snapshot.turns.find((candidate) => candidate.threadId === thread.id);
    expect(turn?.status, 'the real model must finish the workspace turn').toBe('completed');

    const after = snapshotDirectory(workspaceRoot);
    expect(after, 'the agent turn must change at least one workspace file').not.toEqual(before);
    expect(
      existsSync(join(workspaceRoot, 'hello.ts')),
      'the agent should create hello.ts as instructed',
    ).toBe(true);
    expect(readFileSync(join(workspaceRoot, 'hello.ts'), 'utf-8')).toContain('hello');

    expect(snapshot.undoableTurns).toContainEqual(
      expect.objectContaining({ turnId: turn?.id, workspaceId: workspace.id }),
    );

    const undoButton = page.getByTestId('undo-turn-button');
    await expect(undoButton).toBeVisible({ timeout: 10_000 });
    await undoButton.click();
    await expect(undoButton).toBeHidden({ timeout: 10_000 });

    expect(snapshotDirectory(workspaceRoot)).toEqual(before);
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function snapshotDirectory(root: string): Record<string, string> {
  const state: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        walk(absolute);
      } else if (stat.isFile()) {
        const relative = absolute.slice(root.length + 1).split('\\').join('/');
        state[relative] = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      }
    }
  };
  walk(root);
  return state;
}

async function probeLiveEndpoint(): Promise<{ reachable: boolean; reason: string }> {
  const headers: Record<string, string> = {};
  if (liveApiKey) headers.Authorization = `Bearer ${liveApiKey}`;
  try {
    const response = await fetch(`${liveBaseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return {
        reachable: false,
        reason: `Live model skipped: ${liveBaseUrl}/models returned HTTP ${response.status}.`,
      };
    }
    const payload = await response.json() as { data?: unknown; models?: unknown };
    const listed: unknown[] = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.models)
        ? payload.models
        : [];
    const modelIds = listed.flatMap((entry): string[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === 'string'
        ? record.id
        : typeof record.model === 'string'
          ? record.model
          : undefined;
      return id ? [id] : [];
    });
    if (!modelIds.includes(liveModelName)) {
      return {
        reachable: false,
        reason: `Live model skipped: ${liveBaseUrl}/models does not list configured model "${liveModelName}".`,
      };
    }
    return { reachable: true, reason: `Live model reachable at ${liveBaseUrl}.` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      reachable: false,
      reason: `Live model skipped: ${liveBaseUrl}/models is unreachable (${detail}).`,
    };
  }
}
