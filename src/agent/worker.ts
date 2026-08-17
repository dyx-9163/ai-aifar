type ParentPort = {
  postMessage(message: unknown): void;
  on(eventName: 'message', listener: (message: unknown) => void): void;
  start?(): void;
};

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;

parentPort?.on('message', (message) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'app.started'
  ) {
    parentPort.postMessage({ type: 'agent.ready' });
  }
});

parentPort?.start?.();
