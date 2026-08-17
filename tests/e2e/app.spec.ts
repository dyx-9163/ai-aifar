import { _electron as electron, expect, test } from 'playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('launches the desktop and streams a demo turn', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'private-ai-e2e-'));
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

    await expect(page).toHaveTitle(/Private AI Desktop/);
    await page.getByTestId('composer-input').fill('Summarize this workspace');
    await page.getByTestId('composer-send').click();

    await expect(page.getByText('Next step would be routed')).toBeVisible();
    await expect(page.getByText('turn.completed')).toBeVisible();

    await page.getByRole('button', { name: /Settings/ }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Model providers' })).toBeVisible();
    await expect(page.getByLabel('Name')).toHaveValue('Private model endpoint');
    await page.getByLabel('Name').fill('DeepSeek Local');
    await page.getByLabel('Model', { exact: true }).fill('DeepSeek-R1');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('button', { name: /DeepSeek Local/ })).toBeVisible();
    await page.getByRole('button', { name: /Back to chat/ }).click();
    await expect(page.getByTestId('reasoning-runtime-menu')).toBeVisible();
    await expect(page.getByTestId('speed-runtime-menu')).toBeVisible();
    await page.getByTestId('reasoning-runtime-trigger').click();
    await page.getByTestId('reasoning-runtime-high').click();
    await page.getByTestId('speed-runtime-trigger').click();
    await page.getByTestId('speed-runtime-fast').click();
    await page.getByRole('button', { name: /Settings/ }).click();
    await expect(page.getByRole('button', { name: /Advanced/ })).toBeVisible();
    await page.getByRole('button', { name: /Advanced/ }).click();
    await expect(page.getByTestId('metrics-toggle')).toBeVisible();
    await page.getByTestId('metrics-toggle').click();
    await page.getByTestId('context-limit-select').selectOption('50');
    await page.getByRole('button', { name: /Model providers/ }).click();
    await expect(page.getByTestId('reasoning-mode-select')).toBeVisible();
    await expect(page.getByTestId('reasoning-protocol-select')).toBeVisible();
    await page.getByRole('button', { name: /General/ }).click();
    await page.getByTestId('language-select').selectOption('zh-CN');
    await expect(page.getByRole('heading', { name: '外观' })).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
