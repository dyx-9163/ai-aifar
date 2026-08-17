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
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
