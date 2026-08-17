import { _electron as electron, expect, test } from 'playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.skip(process.env.PRIVATE_AI_LIVE_MODEL_E2E !== '1', 'Requires a private OpenAI-compatible model at 127.0.0.1:8080.');

test('changes runtime controls and receives a visible private-model response', async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), 'private-ai-live-model-'));
  const app = await electron.launch({
    executablePath: join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [process.cwd()],
    env: {
      ...process.env,
      PRIVATE_AI_DESKTOP_USER_DATA: userData,
    },
  });

  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: /Settings/ }).click();
    await page.getByLabel('Model', { exact: true }).fill('Qwen3.5-9B');
    await page.getByTestId('reasoning-protocol-select').selectOption('qwen');
    await page.getByTestId('reasoning-mode-select').selectOption('disabled');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: /Back to chat/ }).click();

    await page.getByTestId('reasoning-runtime-trigger').click();
    await page.getByTestId('reasoning-runtime-high').click();
    await expect(page.getByTestId('reasoning-runtime-trigger')).toContainText('High');
    await page.getByTestId('speed-runtime-trigger').click();
    await page.getByTestId('speed-runtime-fast').click();
    await expect(page.getByTestId('speed-runtime-trigger')).toContainText('Fast');

    await page.getByTestId('composer-input').fill('只回复 LIVE_MODEL_OK');
    await page.getByTestId('composer-send').click();
    await expect(page.getByText(/Model is reasoning|模型正在思考/)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.message-row.role-assistant').filter({ hasText: 'LIVE_MODEL_OK' }).last()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('composer-send')).toContainText(/Send|发送/, { timeout: 30_000 });
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
