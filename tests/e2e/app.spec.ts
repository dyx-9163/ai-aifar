import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from 'playwright/test';
import { openDatabase } from '../../src/agent/database';
import { qwenCapabilities } from '../../src/agent/modelCapabilities';
import {
  LOCAL_QWEN_BASE_URL,
  LOCAL_QWEN_MODEL,
  LOCAL_QWEN_PROFILE_ID,
} from '../../src/agent/localQwenProfile';
import type { ReasoningDisplayMode, ReasoningOutputMode, ThreadSummary, TurnRecord } from '../../src/shared/domain';
import type { AgentEvent } from '../../src/shared/protocol';
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

test('fake model server releases a controlled provider HTTP failure', async () => {
  const server = await startFakeModelServer();
  try {
    const responsePromise = fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'task-9-fake', messages: [], stream: true }),
    });

    await expect.poll(() => server.requestCount()).toBe(1);
    server.failNext(429, { error: { message: 'controlled failure' } });

    const response = await responsePromise;
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: { message: 'controlled failure' } });
  } finally {
    await server.close();
  }
});

test('shows output bounds and read-only direct-service diagnostics in Settings', async () => {
  const userData = createUserData('settings-diagnostics');
  const server = await startFakeModelServer(8080);
  server.setConnectionState({ modelIds: [LOCAL_QWEN_MODEL], slots: 1 });
  const seedDb = openDatabase(join(userData, 'app.sqlite'));
  seedDb.saveModelProfile({
    id: LOCAL_QWEN_PROFILE_ID,
    name: 'Local Qwen3.5-9B',
    provider: 'openai-compatible',
    baseUrl: LOCAL_QWEN_BASE_URL,
    model: LOCAL_QWEN_MODEL,
    capabilities: qwenCapabilities(),
    reasoning: { mode: 'disabled', protocol: 'qwen', display: 'auto' },
    maxConcurrency: 1,
    maxOutputTokens: 2048,
    isDefault: true,
  });
  seedDb.close();
  let app: ElectronApplication | undefined;
  let serverClosed = false;
  try {
    app = await launchPackagedApp(userData);
    const page = await app.firstWindow();
    await page.getByTitle('Open settings').click();
    const maxOutputTokens = page.getByTestId('max-output-tokens-input');
    await expect(maxOutputTokens).toHaveValue('2048', { timeout: 2_000 });
    for (const invalid of ['0', '1.5', '32769']) {
      await maxOutputTokens.fill(invalid);
      await expect(page.getByTestId('capability-validation-error')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    }
    await maxOutputTokens.fill('2048');
    await expect(page.getByTestId('capability-validation-error')).toHaveCount(0);

    const testConnection = page.getByRole('button', { name: 'Test connection' });
    const status = page.getByTestId('capability-test-status');
    const diagnostic = page.getByTestId('model-connection-diagnostic');

    await testConnection.click();
    await expect(status).toHaveAttribute('data-state', 'connected');
    await expect(diagnostic).toContainText(LOCAL_QWEN_MODEL);

    server.setConnectionState({ modelIds: [LOCAL_QWEN_MODEL], slots: 3 });
    await testConnection.click();
    await expect(status).toHaveAttribute('data-state', 'concurrency-warning');
    await expect(diagnostic).toContainText('3');
    await expect(diagnostic).toContainText('1');

    server.setConnectionState({ modelIds: [LOCAL_QWEN_MODEL], slotsStatus: 404 });
    await testConnection.click();
    await expect(status).toHaveAttribute('data-state', 'slots-unverified');

    server.setConnectionState({ modelIds: ['another-model'], slots: 1 });
    await testConnection.click();
    await expect(status).toHaveAttribute('data-state', 'model-mismatch');
    await expect(diagnostic).toContainText(LOCAL_QWEN_MODEL);

    await server.close();
    serverClosed = true;
    await testConnection.click();
    await expect(status).toHaveAttribute('data-state', 'offline');
    await expect(diagnostic).toContainText('model-runtime\\start-model.ps1');
    await expect(diagnostic.locator('button')).toHaveCount(0);
    await expect(diagnostic.locator('a')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Start|Stop|Restart|Status)$/ })).toHaveCount(0);
  } finally {
    await closeElectron(app);
    if (!serverClosed) await server.close();
    removeUserData(userData);
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

    page.once('dialog', (dialog) => dialog.accept());
    await threadRow(page, chatA.id).locator('.delete-chat-button').click();
    await expect(threadRow(page, chatA.id).getByTestId('thread-delete-error')).toHaveText(
      'Stop or cancel the active turn before deleting this chat.',
    );
    await expect(page.getByTestId('model-runtime-error')).toHaveCount(0);
    await selectThread(page, chatA.id);
    await expect(page.getByTestId('thread-delete-error')).toHaveCount(0);
    await selectThread(page, chatB.id);

    server.releaseNext([{ answer: 'first complete' }]);
    await expect.poll(() => server.requestCount()).toBe(2);
    await expectThreadRuntime(page, chatB.id, 'running');
    await expect(threadRow(page, chatB.id)).toHaveClass(/active/);
    await expect(page.getByTestId('active-runtime-status')).toHaveAttribute('data-runtime-status', 'running');
    await captureEvidence(page, 'concurrency-one-fifo.png');

    server.releaseNext([{ answer: 'second complete' }]);
    await expectThreadRuntime(page, chatA.id, 'completed');
    await expectThreadRuntime(page, chatB.id, 'completed');
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
    await captureEvidence(page, 'concurrency-two-running.png');

    server.releaseNext([{ answer: 'parallel A complete' }]);
    server.releaseNext([{ answer: 'parallel B complete' }]);
    await expectThreadRuntime(page, chatA.id, 'completed');
    await expectThreadRuntime(page, chatB.id, 'completed');
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
    await captureEvidence(page, 'cancellation-single-release.png');

    server.releaseNext([{ answer: 'C complete' }]);
    await expect.poll(() => server.requestCount()).toBe(3);
    await expectThreadRuntime(page, chatD.id, 'running');
    server.releaseNext([{ answer: 'D complete' }]);
    await expectThreadRuntime(page, chatD.id, 'completed');
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
      { rawReasoning: 'shared-' },
      { rawReasoning: 'output' },
      { summary: 'shared-' },
      { summary: 'output' },
      { answer: '**shared-' },
      { answer: 'output**' },
    ]);
    await expectThreadRuntime(page, thread.id, 'completed');

    const completedSnapshot = await page.evaluate(() => window.desktop.getSnapshot());
    turnId = completedSnapshot.turns.find((turn) => turn.threadId === thread.id)?.id ?? '';
    expect(turnId).not.toBe('');

    const rawPanel = page.getByTestId('reasoning-panel');
    await expect(rawPanel).toHaveAttribute('data-item-kind', 'reasoning');
    await expect(rawPanel).toHaveAttribute('data-reasoning-mode', 'raw');
    await expect(rawPanel).toHaveAttribute('data-turn-id', turnId);
    await rawPanel.click();
    await expect(rawPanel.getByTestId('reasoning-content')).toHaveText('shared-output');
    const answerItem = page.getByTestId('assistant-message');
    await expect(answerItem).toHaveAttribute('data-item-kind', 'message');
    await expect(answerItem).toHaveAttribute('data-message-role', 'assistant');
    await expect(answerItem).toHaveAttribute('data-turn-id', turnId);
    const answer = answerItem.getByTestId('assistant-message-content');
    await expect(answer).toHaveText('shared-output');
    const renderedAnswerText = (await answer.innerText()).trim();
    expect(renderedAnswerText).toBe('shared-output');

    await page.evaluate(() => {
      const target = window as typeof window & {
        __task9CopiedText?: string;
        __task9CopyScope?: { answer: boolean; reasoning: boolean };
      };
      target.__task9CopiedText = '';
      document.addEventListener('copy', () => {
        const selection = window.getSelection();
        const answerContainer = document.querySelector('[data-testid="assistant-message-content"]');
        const reasoningContainer = document.querySelector('[data-testid="reasoning-content"]');
        const anchor = selection?.anchorNode;
        target.__task9CopiedText = selection?.toString() ?? '';
        target.__task9CopyScope = {
          answer: Boolean(anchor && answerContainer?.contains(anchor)),
          reasoning: Boolean(anchor && reasoningContainer?.contains(anchor)),
        };
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
    ).__task9CopiedText)).toBe(renderedAnswerText);
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __task9CopyScope?: { answer: boolean; reasoning: boolean } }
    ).__task9CopyScope)).toEqual({ answer: true, reasoning: false });

    const clipboardResult = await page.evaluate(async () => {
      try {
        return { available: true, text: await navigator.clipboard.readText() };
      } catch (error) {
        return { available: false, text: error instanceof Error ? error.message : String(error) };
      }
    });
    if (clipboardResult.available) {
      expect(clipboardResult.text).toBe(renderedAnswerText);
    } else {
      test.info().annotations.push({
        type: 'clipboard-boundary',
        description: `OS clipboard read unavailable; browser copy event verified: ${clipboardResult.text}`,
      });
    }

    await page.evaluate(() => {
      const rejectingWrite = () => Promise.reject(new Error('clipboard denied'));
      if (navigator.clipboard) {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: rejectingWrite,
        });
        return;
      }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: rejectingWrite },
      });
    });
    const reasoningCopy = rawPanel.getByTestId('reasoning-copy');
    await reasoningCopy.click();
    await expect(reasoningCopy).toHaveAttribute('data-copy-state', 'failed');
    await expect(rawPanel.getByTestId('reasoning-copy-error')).toHaveText(
      'Could not copy reasoning. Try again.',
    );

    eventFixture = await page.evaluate(() => JSON.stringify((
      window as typeof window & { __task9Events?: unknown[] }
    ).__task9Events ?? []));

    await page.evaluate(() => window.desktop.updateSettings({ reasoningDisplayMode: 'summary' }));
    await page.reload();
    const summaryPanel = page.getByTestId('reasoning-panel');
    await expect(summaryPanel).toHaveAttribute('data-item-kind', 'reasoning');
    await expect(summaryPanel).toHaveAttribute('data-reasoning-mode', 'summary');
    await expect(summaryPanel).toHaveAttribute('data-turn-id', turnId);
    await summaryPanel.click();
    await expect(summaryPanel.getByTestId('reasoning-content')).toHaveText('shared-output');
    await expect(page.getByTestId('assistant-message-content')).toHaveText(renderedAnswerText);
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

test('redacts a provider failure secret from the failed turn event UI and SQLite', async () => {
  const userData = createUserData('provider-failure');
  const server = await startFakeModelServer();
  const seeded = seedWorkspace(
    userData,
    server,
    1,
    ['Provider failure'],
    ['raw'],
    'auto',
    ['task9 key-', '"', '\\', '?/[]'].join(''),
  );
  let app: ElectronApplication | undefined;
  let eventFixture = '';
  let turnId = '';
  try {
    app = await launchPackagedApp(userData);
    const page = await app.firstWindow();
    const [thread] = seeded.threads;
    await page.evaluate(() => {
      const target = window as typeof window & { __task9FailureEvents?: unknown[] };
      target.__task9FailureEvents = [];
      window.desktop.subscribe((event) => target.__task9FailureEvents?.push(event));
    });

    await submitOnThread(page, thread.id, 'trigger provider failure');
    await expect.poll(() => server.requestCount()).toBe(1);
    const secretRepresentations = encodedSecretRepresentations(seeded.apiKey);
    server.failNext(401, {
      error: { message: `provider rejected credential ${secretRepresentations.join(' | ')}` },
    });

    await expectThreadRuntime(page, thread.id, 'failed');
    const visibleError = page.getByTestId('turn-error');
    await expect(visibleError).toBeVisible();
    for (const representation of secretRepresentations) {
      await expect(visibleError).not.toContainText(representation);
    }
    expect((await visibleError.innerText()).trim()).not.toBe('');

    const snapshot = await page.evaluate(() => window.desktop.getSnapshot());
    turnId = snapshot.turns.find((turn) => turn.threadId === thread.id)?.id ?? '';
    const failureEvents = await page.evaluate(() => (
      window as typeof window & { __task9FailureEvents?: AgentEvent[] }
    ).__task9FailureEvents ?? []);
    const failureEvent = failureEvents.find((event) => event.type === 'turn.failed' && event.threadId === thread.id);
    expect(failureEvent?.type).toBe('turn.failed');
    if (failureEvent?.type === 'turn.failed') {
      expect(failureEvent.turnId).toBe(turnId);
      expect(failureEvent.error.trim()).not.toBe('');
    }
    eventFixture = JSON.stringify(failureEvents);
    for (const representation of secretRepresentations) {
      expect(eventFixture).not.toContain(representation);
    }

    await closeElectron(app);
    app = undefined;
    verifyFailedTurn(seeded.databasePath, turnId, seeded.apiKey);
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
    const observationDeadline = Date.now() + 750;
    while (Date.now() < observationDeadline) {
      expect(server.requestCount()).toBe(0);
      await page.waitForTimeout(100);
    }
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
  apiKeyOverride?: string,
): SeededWorkspace {
  const databasePath = join(userData, 'app.sqlite');
  const database = openDatabase(databasePath);
  const apiKey = apiKeyOverride ?? `task9-${randomUUID()}`;
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
    const rows = database.prepare('SELECT turn_id, kind, payload FROM items WHERE turn_id = ?').all(turnId) as Array<{
      turn_id: string;
      kind: string;
      payload: string;
    }>;
    expect(rows.every((row) => row.turn_id === turnId)).toBe(true);
    const items = rows.map((row) => JSON.parse(row.payload) as {
      kind: string;
      role?: string;
      mode?: string;
      text?: string;
      turnId?: string;
    });
    expect(items.filter((item) => item.kind === 'message' && item.role === 'user')).toHaveLength(1);
    const assistantItems = items.filter((item) => item.kind === 'message' && item.role === 'assistant');
    expect(assistantItems).toHaveLength(1);
    const assistantItem = assistantItems[0];
    expect(assistantItem).toBeDefined();
    expect(assistantItem?.turnId).toBe(turnId);
    expect(assistantItem?.kind).toBe('message');
    expect(assistantItem?.role).toBe('assistant');
    expect(assistantItem?.text).toBe('**shared-output**');
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

function verifyFailedTurn(databasePath: string, turnId: string, apiKey: string): void {
  expect(turnId).not.toBe('');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const turn = database.prepare('SELECT status, error FROM turns WHERE id = ?').get(turnId) as {
      status: string;
      error: string | null;
    } | undefined;
    expect(turn?.status).toBe('failed');
    expect(turn?.error?.trim()).not.toBe('');
    for (const representation of encodedSecretRepresentations(apiKey)) {
      expect(turn?.error).not.toContain(representation);
    }
  } finally {
    database.close();
  }
}

function encodedSecretRepresentations(secret: string): string[] {
  const encoded = encodeURIComponent(secret);
  const formEncoded = encoded.replace(/%20/g, '+');
  return [
    secret,
    JSON.stringify(secret).slice(1, -1),
    mixedPercentCase(encoded),
    mixedPercentCase(encodeURIComponent(encoded)),
    mixedPercentCase(formEncoded),
    mixedPercentCase(encodeURIComponent(formEncoded)),
  ];
}

function mixedPercentCase(value: string): string {
  let letter = 0;
  return value.replace(/%([0-9A-F]{2})/g, (_escape, hex: string) => `%${[...hex].map((digit) => {
    if (!/[A-F]/.test(digit)) return digit;
    const mixed = letter % 2 === 0 ? digit.toLowerCase() : digit.toUpperCase();
    letter += 1;
    return mixed;
  }).join('')}`);
}
