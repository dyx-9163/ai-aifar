import { app, BrowserWindow, ipcMain, MessageChannelMain, shell, utilityProcess } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentRequestBroker, type AgentReply } from './main/agentRequestBroker.js';
import { buildAppHealth } from './main/appHealth.js';
import {
  AgentScopeLifecycle,
  completeQuitAfterShutdown,
  type AgentScopeManagedRuntime,
} from './main/agentScopeLifecycle.js';
import {
  parseRuntimeManifest,
  type AgentScopeRuntimeState,
} from './main/agentScopeProtocol.js';
import {
  resolveAgentScopeRuntimePaths,
  resolveAgentScopeRuntimeRoot,
} from './main/agentScopeRuntimePaths.js';
import { AgentScopeSupervisor } from './main/agentScopeSupervisor.js';
import { isAgentEvent, isDesktopRequest, type DesktopRequest } from './shared/protocol.js';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const customUserDataPath = process.env.PRIVATE_AI_DESKTOP_USER_DATA;
if (customUserDataPath) {
  app.setPath('userData', customUserDataPath);
}

const agentScopeE2ePortFile = process.env.PRIVATE_AI_E2E_AGENTSCOPE_PORT_FILE;
const agentScopeE2eDiagnosticsEnabled =
  typeof agentScopeE2ePortFile === 'string' && path.isAbsolute(agentScopeE2ePortFile);

let mainWindow: BrowserWindow | null = null;
let agentProcess: Electron.UtilityProcess | null = null;
let agentPort: Electron.MessagePortMain | null = null;
const agentRequests = new AgentRequestBroker(30_000);
let agentScopeState: AgentScopeRuntimeState = { state: 'stopped' };
const agentScopeLifecycle = new AgentScopeLifecycle();
let allowFinalQuit = false;
let finalQuitPending = false;

const AGENTSCOPE_DEGRADED_DETAILS = {
  'missing-runtime': 'AgentScope runtime is unavailable.',
  'invalid-manifest': 'AgentScope runtime manifest validation failed.',
} as const;

function startAgentRuntime(): void {
  if (agentProcess) {
    return;
  }

  const process = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], {
    serviceName: 'private-ai-agent-runtime',
  });
  agentProcess = process;

  process.once('exit', () => {
    if (agentProcess === process) {
      stopAgentRuntime('Agent runtime exited unexpectedly.');
    }
  });

  const { port1, port2 } = new MessageChannelMain();
  agentPort = port2;
  agentRequests.connect(port2);
  agentPort.on('message', (event) => handleAgentMessage(event.data));
  agentPort.once('close', () => {
    if (agentPort === port2) {
      stopAgentRuntime('Agent runtime port closed unexpectedly.', true);
    }
  });
  agentPort.start();

  process.postMessage(
    {
      type: 'agent.port',
      version: app.getVersion(),
      databasePath: path.join(app.getPath('userData'), 'app.sqlite'),
    },
    [port1],
  );
}

async function createWindow(): Promise<void> {
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

  try {
    startAgentRuntime();
  } catch (error) {
    console.error('Failed to start agent runtime:', error);
  }

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

ipcMain.handle('app:health', () => ({
  ...buildAppHealth(app.getVersion(), agentScopeState),
}));

ipcMain.handle('desktop:request', async (_event, request: unknown) => {
  if (!isDesktopRequest(request)) {
    throw new Error('Invalid desktop request.');
  }
  return sendAgentRequest(request);
});

app.whenReady().then(async () => {
  void agentScopeLifecycle.start(loadAgentScopeRuntime).catch(() => {
    if (agentScopeState.state !== 'stopped') {
      agentScopeState = {
        state: 'degraded',
        reason: 'exited',
        detail: 'AgentScope runtime exited unexpectedly.',
      };
    }
  });
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

app.on('before-quit', (event) => {
  stopAgentRuntime('Application is quitting.', true);
  mainWindow = null;
  if (allowFinalQuit) {
    return;
  }

  event.preventDefault();
  if (finalQuitPending) {
    return;
  }
  finalQuitPending = true;
  void completeQuitAfterShutdown(agentScopeLifecycle.stop(), () => {
    allowFinalQuit = true;
    app.quit();
  });
});

async function loadAgentScopeRuntime(): Promise<AgentScopeManagedRuntime | null> {
  const runtimeRoot = resolveAgentScopeRuntimeRoot({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  const manifestPath = path.resolve(runtimeRoot, 'runtime-manifest.json');

  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, 'utf8');
  } catch (error) {
    setAgentScopeUnavailable(isMissingFileError(error) ? 'missing-runtime' : 'invalid-manifest');
    return null;
  }

  let runtimePaths;
  try {
    const manifest = parseRuntimeManifest(JSON.parse(manifestText) as unknown);
    runtimePaths = resolveAgentScopeRuntimePaths({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }, manifest);
  } catch {
    setAgentScopeUnavailable('invalid-manifest');
    return null;
  }

  const supervisor = new AgentScopeSupervisor({
    runtimePaths,
    userDataDir: app.getPath('userData'),
    logDir: path.join(app.getPath('userData'), 'agentscope-logs'),
  });
  agentScopeState = supervisor.status();
  const unsubscribe = supervisor.subscribe((state) => {
    agentScopeState = state;
    if (state.state === 'ready') {
      publishAgentScopeE2ePort(state.port);
    }
  });

  return {
    start: async () => {
      agentScopeState = await supervisor.start();
    },
    stop: async () => {
      try {
        await supervisor.stop();
      } finally {
        unsubscribe();
      }
    },
  };
}

function publishAgentScopeE2ePort(port: number): void {
  if (!agentScopeE2eDiagnosticsEnabled || !agentScopeE2ePortFile) return;
  void writeFile(agentScopeE2ePortFile, `${port}\n`, {
    encoding: 'ascii',
    flag: 'wx',
  }).catch(() => undefined);
}

function setAgentScopeUnavailable(
  reason: keyof typeof AGENTSCOPE_DEGRADED_DETAILS,
): void {
  agentScopeState = {
    state: 'degraded',
    reason,
    detail: AGENTSCOPE_DEGRADED_DETAILS[reason],
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function sendAgentRequest(request: DesktopRequest): Promise<unknown> {
  return agentRequests.request(request);
}

function handleAgentMessage(message: unknown): void {
  if (isAgentReply(message)) {
    agentRequests.handleReply(message);
    return;
  }

  if (isAgentEvent(message)) {
    mainWindow?.webContents.send('agent:event', message);
  }
}

function stopAgentRuntime(reason: string, killProcess = false): void {
  const process = agentProcess;
  const port = agentPort;
  agentProcess = null;
  agentPort = null;
  agentRequests.disconnect(reason);
  if (killProcess) {
    process?.kill();
  }
  port?.close();
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
