export interface RevealableWindow {
  once(event: 'ready-to-show', listener: () => void): unknown;
  removeListener(event: 'ready-to-show', listener: () => void): unknown;
  show(): void;
  isDestroyed(): boolean;
}

export async function loadAndRevealWindow(
  window: RevealableWindow,
  load: () => Promise<unknown>,
): Promise<void> {
  let markReady!: () => void;
  const readyToShow = new Promise<void>((resolve) => {
    markReady = resolve;
    window.once('ready-to-show', markReady);
  });

  try {
    await Promise.all([load(), readyToShow]);
  } finally {
    window.removeListener('ready-to-show', markReady);
  }

  if (!window.isDestroyed()) {
    window.show();
  }
}

export interface DesktopStartupOptions {
  openWindow(): Promise<void>;
  deferBackgroundStart(): Promise<void>;
  startAgentRuntime(): void;
  startAgentScope(): Promise<void>;
  onAgentScopeFailure(): void;
}

export async function startDesktopRuntimes(
  options: DesktopStartupOptions,
): Promise<void> {
  await options.openWindow();
  await options.deferBackgroundStart();
  options.startAgentRuntime();
  void options.startAgentScope().catch(options.onAgentScopeFailure);
}
