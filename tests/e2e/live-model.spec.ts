import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from 'playwright/test';
import { openDatabase } from '../../src/agent/database';
import type { AgentEvent } from '../../src/shared/protocol';

const liveBaseUrl = (process.env.PRIVATE_AI_LIVE_MODEL_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
const liveModelName = process.env.PRIVATE_AI_LIVE_MODEL_NAME ?? 'Qwen3.5-9B';
const liveApiKey = process.env.PRIVATE_AI_LIVE_MODEL_API_KEY?.trim();
const packagedExecutable = join(process.cwd(), 'out', 'Private AI Desktop-win32-x64', 'Private AI Desktop.exe');

test('runs real Qwen thinking with raw-only reasoning and turn-scoped metrics', async () => {
  test.setTimeout(180_000);
  const probe = await probeLiveEndpoint();
  test.skip(!probe.reachable, probe.reason);

  const userData = mkdtempSync(join(tmpdir(), 'private-ai-live-model-'));
  const databasePath = join(userData, 'app.sqlite');
  const database = openDatabase(databasePath);
  database.updateSettings({ reasoningDisplayMode: 'raw', showModelMetrics: true });
  const profile = database.saveModelProfile({
    name: 'Live Qwen',
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
    reasoning: { mode: 'enabled', protocol: 'qwen', display: 'raw' },
    maxConcurrency: 1,
    isDefault: true,
  });
  const thread = database.createThread('Live Qwen acceptance');
  database.close();

  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      executablePath: packagedExecutable,
      args: [],
      env: {
        ...process.env,
        PRIVATE_AI_DESKTOP_USER_DATA: userData,
      },
    });
    const page = await app.firstWindow();
    await page.evaluate(() => {
      const target = window as typeof window & { __task9LiveEvents?: AgentEvent[] };
      target.__task9LiveEvents = [];
      window.desktop.subscribe((event) => target.__task9LiveEvents?.push(event));
    });

    await page.getByTestId(`thread-row-${thread.id}`).getByRole('button').first().click();
    await page.getByTestId('composer-input').fill('请先思考 17×19，再用一句简短中文给出最终答案。');
    await page.getByTestId('composer-send').click();
    const runtime = page.getByTestId(`thread-row-${thread.id}`).getByTestId('thread-runtime-status');
    await expect(runtime).toHaveAttribute('data-runtime-status', 'completed', { timeout: 150_000 });

    const rawPanel = page.getByTestId('reasoning-panel');
    await rawPanel.click();
    const rawContent = rawPanel.getByTestId('reasoning-content');
    await expect(rawContent).not.toHaveText('');
    const rawText = (await rawContent.textContent())?.trim() ?? '';
    expect(rawText.length).toBeGreaterThan(0);

    const answer = page.getByTestId('assistant-message-content');
    await expect(answer).not.toHaveText('');
    const answerText = (await answer.innerText()).trim();
    expect(answerText.length).toBeGreaterThan(0);
    expect(answerText).not.toContain(rawText);

    await page.evaluate(() => {
      const target = window as typeof window & { __task9LiveCopiedText?: string };
      target.__task9LiveCopiedText = '';
      document.addEventListener('copy', () => {
        target.__task9LiveCopiedText = window.getSelection()?.toString() ?? '';
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
      window as typeof window & { __task9LiveCopiedText?: string }
    ).__task9LiveCopiedText)).toBe(answerText);
    expect(answerText).not.toContain(rawText);

    const snapshot = await page.evaluate(() => window.desktop.getSnapshot());
    const turn = snapshot.turns.find((candidate) => candidate.threadId === thread.id);
    expect(turn?.modelProfileId).toBe(profile.id);
    const persistedItems = snapshot.items[thread.id] ?? [];
    const persistedRaw = persistedItems.find((item) => item.kind === 'reasoning' && item.mode === 'raw');
    const persistedSummary = persistedItems.find((item) => item.kind === 'reasoning' && item.mode === 'summary');
    const persistedAnswer = persistedItems.find((item) => item.kind === 'message' && item.role === 'assistant');
    expect(persistedRaw?.text.trim()).toBe(rawText);
    expect(persistedSummary).toBeUndefined();
    expect(persistedAnswer?.text.trim()).toBe(answerText);

    const events = await page.evaluate(() => (
      window as typeof window & { __task9LiveEvents?: AgentEvent[] }
    ).__task9LiveEvents ?? []);
    const metricsEvent = events.find((event) => event.type === 'model.metrics');
    expect(metricsEvent?.type).toBe('model.metrics');
    if (metricsEvent?.type === 'model.metrics') {
      expect(metricsEvent.threadId).toBe(thread.id);
      expect(metricsEvent.turnId).toBe(turn?.id);
      expect(metricsEvent.modelProfileId).toBe(profile.id);
      expect(metricsEvent.metrics.durationMs).toBeGreaterThan(0);
      if (metricsEvent.metrics.tokensPerSecond !== undefined) {
        expect(metricsEvent.metrics.tokensPerSecond).toBeGreaterThan(0);
      }
    }
    await expect(page.getByTestId('turn-metrics')).toBeVisible();

    await page.evaluate(() => window.desktop.updateSettings({ reasoningDisplayMode: 'summary' }));
    await page.reload();
    const unavailablePanel = page.getByTestId('reasoning-panel');
    await unavailablePanel.click();
    await expect(unavailablePanel.getByTestId('reasoning-unavailable')).toHaveAttribute('data-reasoning-mode', 'summary');
    await expect(page.getByTestId('assistant-message-content')).toHaveText(answerText);
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

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
    return { reachable: true, reason: `Live model reachable at ${liveBaseUrl}.` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      reachable: false,
      reason: `Live model skipped: ${liveBaseUrl}/models is unreachable (${detail}).`,
    };
  }
}
