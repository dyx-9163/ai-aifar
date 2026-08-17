import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from 'playwright/test';
import { openDatabase } from '../../src/agent/database';
import type { ReasoningDisplayMode, ReasoningOutputMode, ThreadSummary, TurnRecord } from '../../src/shared/domain';
import { startFakeModelServer, type FakeModelServer } from './fakeModelServer';

const packagedExecutable = join(process.cwd(), 'out', 'Private AI Desktop-win32-x64', 'Private AI Desktop.exe');
const evidenceDirectory = join(process.cwd(), 'test-results', 'task9-evidence');

interface SeededWorkspace {
  apiKey: string;
  databasePath: string;
  profileId: string;
  threads: ThreadSummary[];
}

test('fake model server holds and releases separate SSE streams', async () => {
  const server = await startFakeModelServer();
  try {
    const responsePromise = fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'task-9-fake', messages: [], stream: true }),
    });

    await expect.poll(() => server.requestCount()).toBe(1);
    server.releaseNext([
      { rawReasoning: 'raw trace' },
      { summary: 'native summary' },
      { answer: 'final answer' },
    ]);

    const response = await responsePromise;
    expect(response.ok).toBe(true);
    const body = await response.text();
    expect(body).toContain('"reasoning_content":"raw trace"');
    expect(body).toContain('"reasoning_summary":"native summary"');
    expect(body).toContain('"content":"final answer"');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  } finally {
    await server.close();
  }
});

test('queues FIFO at concurrency one and background completion does not steal focus', async () => {
  const userData = createUserData('fifo-one');
  const server = await startFakeModelServer();
  const seeded = seedWorkspace(userData, server, 1, ['Chat A', 'Chat B']);
  let app: ElectronApplication | undefined;
  try {
    app = await launchPackagedApp(userData);
    const page = await app.firstWindow();
    const [chatA, chatB] = seeded.threads;

    await submitOnThread(page, chatA.id, 'request A');
    await expect.poll(() => server.requestCount()).toBe(1);
    await expectThreadRuntime(page, chatA.id, 'running');

    await submitOnThread(page, chatB.id, 'request B');
    await expectThreadRuntime(page, chatB.id, 'queued', 1);
    await expect(threadRow(page, chatB.id)).toHaveClass(/active/);
    expect(server.requestCount()).toBe(1);

    server.releaseNext([{ answer: 'first complete' }]);
    await expect.poll(() => server.requestCount()).toBe(2);
    await expectThreadRuntime(page, chatB.id, 'running');
    await expect(threadRow(page, chatB.id)).toHaveClass(/active/);
    await expect(page.getByTestId('active-runtime-status')).toHaveAttribute('data-runtime-status', 'running');

    server.releaseNext([{ answer: 'second complete' }]);
    await expectThreadRuntime(page, chatA.id, 'completed');
    await expectThreadRuntime(page, chatB.id, 'completed');
    await captureEvidence(page, 'concurrency-one-fifo.png');
  } finally {
    await closeElectron(app);
    await server.close();
    removeUserData(userData);
  }
});

test('starts two independent chats at concurrency two', async () => {
  const userData = createUserData('concurrency-two');
  const server = await startFakeModelServer();
  const seeded = seedWorkspace(userData, server, 2, ['Parallel A', 'Parallel B']);
  let app: ElectronApplication | undefined;
  try {
    app = await launchPackagedApp(userData);
    const page = await app.firstWindow();
    const [chatA, chatB] = seeded.threads;

    await submitOnThread(page, chatA.id, 'parallel request A');
    await submitOnThread(page, chatB.id, 'parallel request B');
    await expect.poll(() => server.requestCount()).toBe(2);
    await expectThreadRuntime(page, chatA.id, 'running');
    await expectThreadRuntime(page, chatB.id, 'running');

    server.releaseNext([{ answer: 'parallel A complete' }]);
    server.releaseNext([{ answer: 'parallel B complete' }]);
    await expectThreadRuntime(page, chatA.id, 'completed');
    await expectThreadRuntime(page, chatB.id, 'completed');
    await captureEvidence(page, 'concurrency-two-running.png');
  } finally {
    await closeElectron(app);
    await server.close();
    removeUserData(userData);
  }
});

test('queued and running cancellation each release capacity once', async () => {
  const userData = createUserData('cancellation');
  const server = await startFakeModelServer();
  const seeded = seedWorkspace(userData, server, 1, ['Cancel A', 'Cancel B', 'Cancel C', 'Cancel D']);
  let app: ElectronApplication | undefined;
  try {
    app = await launchPackagedApp(userData);
    const page = await app.firstWindow();
    const [chatA, chatB, chatC, chatD] = seeded.threads;

    await submitOnThread(page, chatA.id, 'running request');
    await submitOnThread(page, chatB.id, 'queued request B');
    await submitOnThread(page, chatC.id, 'queued request C');
    await submitOnThread(page, chatD.id, 'queued request D');
    await expect.poll(() => server.requestCount()).toBe(1);
    await expectThreadRuntime(page, chatB.id, 'queued', 1);
    await expectThreadRuntime(page, chatC.id, 'queued', 2);
    await expectThreadRuntime(page, chatD.id, 'queued', 3);

    await selectThread(page, chatB.id);
    await expect(page.getByTestId('composer-send')).toHaveAttribute('data-action', 'cancel');
    await page.getByTestId('composer-send').click();
    await expectThreadRuntime(page, chatB.id, 'cancelled');
    await expectThreadRuntime(page, chatC.id, 'queued', 1);
    await expectThreadRuntime(page, chatD.id, 'queued', 2);
    expect(server.requestCount()).toBe(1);

    await selectThread(page, chatA.id);
    await expect(page.getByTestId('composer-send')).toHaveAttribute('data-action', 'stop');
    await page.getByTestId('composer-send').click();
    await expectThreadRuntime(page, chatA.id, 'cancelled');
    await expect.poll(() => server.requestCount()).toBe(2);
    await expectThreadRuntime(page, chatC.id, 'running');
    await expectThreadRuntime(page, chatD.id, 'queued', 1);

    server.releaseNext([{ answer: 'C complete' }]);
    await expect.poll(() => server.requestCount()).toBe(3);
    await expectThreadRuntime(page, chatD.id, 'running');
    server.releaseNext([{ answer: 'D complete' }]);
    await expectThreadRuntime(page, chatD.id, 'completed');
    await captureEvidence(page, 'cancellation-single-release.png');
  } finally {
    await closeElectron(app);
    await server.close();
    removeUserData(userData);
  }
});

test('keeps answer raw reasoning and summary separate through UI copy and SQLite', async () => {
  const userData = createUserData('stream-separation');
  const server = await startFakeModelServer();
  const seeded = seedWorkspace(userData, server, 1, ['Three streams'], ['raw', 'summary'], 'raw');
  let app: ElectronApplication | undefined;
  let eventFixture = '';
  let turnId = '';
  try {
    app = await launchPackagedApp(userData);
    const page = await app.firstWindow();
    const [thread] = seeded.threads;
    await page.evaluate(() => {
      const target = window as typeof window & { __task9Events?: unknown[] };
      target.__task9Events = [];
      window.desktop.subscribe((event) => target.__task9Events?.push(event));
    });

    await submitOnThread(page, thread.id, 'separate all streams');
    await expect.poll(() => server.requestCount()).toBe(1);
    server.releaseNext([
      { rawReasoning: 'raw-part-1 ' },
      { rawReasoning: 'raw-part-2' },
      { summary: 'summary-part-1 ' },
      { summary: 'summary-part-2' },
      { answer: 'answer-part-1 ' },
      { answer: 'answer-part-2' },
    ]);
    await expectThreadRuntime(page, thread.id, 'completed');

    const rawPanel = page.getByTestId('reasoning-panel');
    await rawPanel.click();
    await expect(rawPanel.getByTestId('reasoning-content')).toHaveText('raw-part-1 raw-part-2');
    const answer = page.getByTestId('assistant-message-content');
    await expect(answer).toHaveText('answer-part-1 answer-part-2');
    await expect(answer).not.toContainText('raw-part');
    await expect(answer).not.toContainText('summary-part');

    await page.evaluate(() => {
      const target = window as typeof window & { __task9CopiedText?: string };
      target.__task9CopiedText = '';
      document.addEventListener('copy', () => {
        target.__task9CopiedText = window.getSelection()?.toString() ?? '';
      }, { once: true });
    });
    await answer.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.keyboard.press('Control+C');
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __task9CopiedText?: string }
    ).__task9CopiedText)).toBe('answer-part-1 answer-part-2');

    const clipboardResult = await page.evaluate(async () => {
      try {
        return { available: true, text: await navigator.clipboard.readText() };
      } catch (error) {
        return { available: false, text: error instanceof Error ? error.message : String(error) };
      }
    });
    if (clipboardResult.available) {
      expect(clipboardResult.text).toBe('answer-part-1 answer-part-2');
    } else {
      test.info().annotations.push({
        type: 'clipboard-boundary',
        description: `OS clipboard read unavailable; browser copy event verified: ${clipboardResult.text}`,
      });
    }

    const snapshot = await page.evaluate(() => window.desktop.getSnapshot());
    turnId = snapshot.turns.find((turn) => turn.threadId === thread.id)?.id ?? '';
    eventFixture = await page.evaluate(() => JSON.stringify((
      window as typeof window & { __task9Events?: unknown[] }
    ).__task9Events ?? []));

    await page.evaluate(() => window.desktop.updateSettings({ reasoningDisplayMode: 'summary' }));
    await page.reload();
    const summaryPanel = page.getByTestId('reasoning-panel');
    await summaryPanel.click();
    await expect(summaryPanel.getByTestId('reasoning-content')).toHaveText('summary-part-1 summary-part-2');
    await expect(page.getByTestId('assistant-message-content')).toHaveText('answer-part-1 answer-part-2');
    await captureEvidence(page, 'three-streams-separated.png');

    await closeElectron(app);
    app = undefined;
    verifyPersistedTurn(seeded.databasePath, turnId, seeded.apiKey, eventFixture);
  } finally {
    await closeElectron(app);
    await server.close();
    removeUserData(userData);
  }
});

test('marks unfinished work interrupted on restart without a model request', async () => {
  const userData = createUserData('restart');
  const server = await startFakeModelServer();
  const seeded = seedWorkspace(userData, server, 1, ['Restart recovery']);
  const [thread] = seeded.threads;
  const seededTurn: TurnRecord = {
    id: 'task9-unfinished-turn',
    threadId: thread.id,
    modelProfileId: seeded.profileId,
    status: 'running',
    createdAt: '2026-08-18T00:00:00.000Z',
    startedAt: '2026-08-18T00:00:01.000Z',
    incomplete: true,
  };
  const seedDb = openDatabase(seeded.databasePath);
  seedDb.createTurn(seededTurn);
  seedDb.close();

  let app: ElectronApplication | undefined;
  try {
    app = await launchPackagedApp(userData);
    const page = await app.firstWindow();
    await expectThreadRuntime(page, thread.id, 'interrupted');
    expect(server.requestCount()).toBe(0);
    await captureEvidence(page, 'restart-interrupted.png');
    const snapshot = await page.evaluate(() => window.desktop.getSnapshot());
    expect(snapshot.turns.find((turn) => turn.id === seededTurn.id)?.status).toBe('interrupted');
    expect(server.requestCount()).toBe(0);
  } finally {
    await closeElectron(app);
    await server.close();
    removeUserData(userData);
  }
});

function createUserData(name: string): string {
  return mkdtempSync(join(tmpdir(), `private-ai-task9-${name}-`));
}

function removeUserData(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function seedWorkspace(
  userData: string,
  server: FakeModelServer,
  maxConcurrency: number,
  titles: string[],
  outputModes: ReasoningOutputMode[] = ['raw'],
  reasoningDisplayMode: ReasoningDisplayMode = 'auto',
): SeededWorkspace {
  const databasePath = join(userData, 'app.sqlite');
  const database = openDatabase(databasePath);
  const apiKey = `task9-${randomUUID()}`;
  database.updateSettings({ reasoningDisplayMode });
  const profile = database.saveModelProfile({
    name: `Task 9 fake ${maxConcurrency}`,
    provider: 'openai-compatible',
    baseUrl: server.baseUrl,
    model: 'task-9-fake',
    apiKey,
    capabilities: {
      text: true,
      vision: false,
      longContext: false,
      reasoning: { inputMode: 'toggle', effortOptions: [], outputModes },
      concurrency: { defaultLimit: 1, configurable: true, maxLimit: 4 },
      streaming: true,
      usage: { tokens: true, reasoningTokens: true },
    },
    reasoning: { mode: 'enabled', protocol: 'qwen', display: 'auto' },
    maxConcurrency,
    isDefault: true,
  });
  const threads = titles.map((title) => database.createThread(title));
  database.close();
  return { apiKey, databasePath, profileId: profile.id, threads };
}

async function launchPackagedApp(userData: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: packagedExecutable,
    args: [],
    env: {
      ...process.env,
      PRIVATE_AI_DESKTOP_USER_DATA: userData,
    },
  });
}

async function closeElectron(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  await app.close().catch(() => undefined);
}

function threadRow(page: Page, threadId: string) {
  return page.getByTestId(`thread-row-${threadId}`);
}

function threadStatus(page: Page, threadId: string) {
  return threadRow(page, threadId).getByTestId('thread-runtime-status');
}

async function expectThreadRuntime(
  page: Page,
  threadId: string,
  status: string,
  queuePosition?: number,
): Promise<void> {
  const runtime = threadStatus(page, threadId);
  await expect(runtime).toHaveAttribute('data-runtime-status', status);
  if (queuePosition === undefined) {
    await expect(runtime).not.toHaveAttribute('data-queue-position');
  } else {
    await expect(runtime).toHaveAttribute('data-queue-position', String(queuePosition));
  }
}

async function selectThread(page: Page, threadId: string): Promise<void> {
  const row = threadRow(page, threadId);
  await row.getByRole('button').first().click();
  await expect(row).toHaveClass(/active/);
}

async function submitOnThread(page: Page, threadId: string, prompt: string): Promise<void> {
  await selectThread(page, threadId);
  await page.getByTestId('composer-input').fill(prompt);
  await page.getByTestId('composer-send').click();
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  mkdirSync(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: join(evidenceDirectory, filename), fullPage: true });
}

function verifyPersistedTurn(databasePath: string, turnId: string, apiKey: string, eventFixture: string): void {
  expect(turnId).not.toBe('');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare('SELECT kind, payload FROM items WHERE turn_id = ?').all(turnId) as Array<{
      kind: string;
      payload: string;
    }>;
    const items = rows.map((row) => JSON.parse(row.payload) as { kind: string; role?: string; mode?: string });
    expect(items.filter((item) => item.kind === 'message' && item.role === 'user')).toHaveLength(1);
    expect(items.filter((item) => item.kind === 'message' && item.role === 'assistant')).toHaveLength(1);
    expect(items.filter((item) => item.kind === 'reasoning' && item.mode === 'raw')).toHaveLength(1);
    expect(items.filter((item) => item.kind === 'reasoning' && item.mode === 'summary')).toHaveLength(1);

    const turnErrors = database.prepare('SELECT error FROM turns WHERE error IS NOT NULL').all() as Array<{ error: string }>;
    expect(rows.map((row) => row.payload).join('\n')).not.toContain(apiKey);
    expect(turnErrors.map((row) => row.error).join('\n')).not.toContain(apiKey);
    expect(eventFixture).not.toContain(apiKey);
  } finally {
    database.close();
  }
}
