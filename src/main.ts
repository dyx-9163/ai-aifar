import { app, BrowserWindow, ipcMain, shell, utilityProcess } from 'electron';
import path from 'node:path';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let agentProcess: Electron.UtilityProcess | null = null;

function startAgentRuntime(): void {
  if (agentProcess) {
    return;
  }

  agentProcess = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], {
    serviceName: 'private-ai-agent-runtime',
  });

  agentProcess.once('exit', () => {
    agentProcess = null;
  });

  agentProcess.postMessage({ type: 'app.started', version: app.getVersion() });
}

async function createWindow(): Promise<void> {
  startAgentRuntime();

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: 'Private AI Desktop',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
    }
  });

  mainWindow = window;

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

ipcMain.handle('app:health', () => ({
  ok: true as const,
  version: app.getVersion(),
}));

app.whenReady().then(async () => {
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  agentProcess?.kill();
  agentProcess = null;
  mainWindow = null;
});
