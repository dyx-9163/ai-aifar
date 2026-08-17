import { isDesktopRequest } from '../shared/protocol.js';
import { runDemoTurn } from './demoAgent.js';

type ParentPort = {
  postMessage(message: unknown): void;
  on(eventName: 'message', listener: (message: unknown) => void): void;
  start?(): void;
};

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
const activeTurns = new Map<string, AbortController>();

parentPort?.on('message', (message) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'app.started'
  ) {
    parentPort.postMessage({ type: 'agent.ready' });
    return;
  }

  if (!isDesktopRequest(message)) {
    return;
  }

  if (message.type === 'turn.cancel') {
    activeTurns.get(message.turnId)?.abort();
    activeTurns.delete(message.turnId);
    return;
  }

  if (message.type === 'turn.start') {
    const turnId = `turn-${Date.now().toString(36)}`;
    const controller = new AbortController();
    activeTurns.set(turnId, controller);
    void runDemoTurn(
      {
        threadId: message.threadId,
        turnId,
        text: message.text,
      },
      (event) => parentPort?.postMessage(event),
      controller.signal,
    ).finally(() => activeTurns.delete(turnId));
  }
});

parentPort?.start?.();
