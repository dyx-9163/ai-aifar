import { app, BrowserWindow, ipcMain, MessageChannelMain, shell, utilityProcess } from 'electron';
import path from 'node:path';
import { isAgentEvent, isDesktopRequest, type DesktopRequest } from './shared/protocol.js';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let agentProcess: Electron.UtilityProcess | null = null;
let agentPort: Electron.MessagePortMain | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<string, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>();

type AgentReply = { type: 'agent.reply'; requestId: string; ok: true; data?: unknown } | { type: 'agent.reply'; requestId: string; ok: false; error: string };

function startAgentRuntime(): void {
  if (agentProcess) {
    return;
  }

  agentProcess = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], {
    serviceName: 'private-ai-agent-runtime',
  });

  agentProcess.once('exit', () => {
    agentProcess = null;
    agentPort?.close();
    agentPort = null;
  });

  const { port1, port2 } = new MessageChannelMain();
  agentPort = port2;
  agentPort.on('message', (event) => handleAgentMessage(event.data));
  agentPort.start();

  agentProcess.postMessage(
    {
      type: 'agent.port',
      version: app.getVersion(),
      databasePath: path.join(app.getPath('userData'), 'app.sqlite'),
    },
    [port1],
  );
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

ipcMain.handle('desktop:request', async (_event, request: unknown) => {
  if (!isDesktopRequest(request)) {
    throw new Error('Invalid desktop request.');
  }
  return sendAgentRequest(request);
});

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
  agentPort?.close();
  agentPort = null;
  mainWindow = null;
});

function sendAgentRequest(request: DesktopRequest): Promise<unknown> {
  if (!agentPort) {
    return Promise.reject(new Error('Agent runtime is not ready.'));
  }

  const requestId = `request-${nextRequestId++}`;
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    agentPort?.postMessage({ type: 'agent.request', requestId, request });
  });
}

function handleAgentMessage(message: unknown): void {
  if (isAgentReply(message)) {
    const pending = pendingRequests.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingRequests.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.data);
    } else {
      pending.reject(new Error(message.error));
    }
    return;
  }

  if (isAgentEvent(message)) {
    mainWindow?.webContents.send('agent:event', message);
  }
}

function isAgentReply(value: unknown): value is AgentReply {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'agent.reply' &&
    'requestId' in value &&
    typeof value.requestId === 'string' &&
    'ok' in value &&
    typeof value.ok === 'boolean'
  );
}
