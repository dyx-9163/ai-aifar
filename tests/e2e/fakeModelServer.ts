import { createServer, type ServerResponse } from 'node:http';

export interface FakeModelServer {
  baseUrl: string;
  requestCount(): number;
  setConnectionState(state: FakeConnectionState): void;
  releaseNext(parts: Array<{ answer?: string; rawReasoning?: string; summary?: string }>): void;
  failNext(status: number, body: unknown): void;
  close(): Promise<void>;
}

export interface FakeConnectionState {
  modelIds?: string[];
  modelStatus?: number;
  slots?: number;
  slotsStatus?: number;
}

interface PendingResponse {
  response: ServerResponse;
}

export async function startFakeModelServer(port = 0): Promise<FakeModelServer> {
  const pending: PendingResponse[] = [];
  let completionRequestCount = 0;
  let connectionState: FakeConnectionState = { modelIds: ['task-9-fake'], slots: 1 };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      const status = connectionState.modelStatus ?? 200;
      response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({
        object: 'list',
        data: (connectionState.modelIds ?? ['task-9-fake']).map((id) => ({ id, object: 'model' })),
      }));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/slots') {
      const status = connectionState.slotsStatus ?? 200;
      response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify(Array.from({ length: connectionState.slots ?? 1 }, (_value, id) => ({ id }))));
      return;
    }

    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ error: { message: 'Not found.' } }));
      return;
    }

    completionRequestCount += 1;
    request.resume();
    pending.push({ response });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Fake model server did not bind a TCP port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => completionRequestCount,
    setConnectionState(state) {
      connectionState = { ...state };
    },
    releaseNext(parts) {
      const next = takePendingResponse(pending);

      next.response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'close',
      });
      for (const part of parts) {
        const delta: Record<string, string> = {};
        if (part.answer !== undefined) delta.content = part.answer;
        if (part.rawReasoning !== undefined) delta.reasoning_content = part.rawReasoning;
        if (part.summary !== undefined) delta.reasoning_summary = part.summary;
        next.response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      }
      const completionTokens = Math.max(1, parts.filter((part) => part.answer).length);
      next.response.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 3,
          completion_tokens: completionTokens,
          total_tokens: completionTokens + 3,
        },
      })}\n\n`);
      next.response.end('data: [DONE]\n\n');
    },
    failNext(status, body) {
      const next = takePendingResponse(pending);
      next.response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        connection: 'close',
      });
      next.response.end(JSON.stringify(body));
    },
    async close() {
      for (const entry of pending.splice(0)) {
        entry.response.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

function takePendingResponse(pending: PendingResponse[]): PendingResponse {
  let next = pending.shift();
  while (next?.response.destroyed) {
    next = pending.shift();
  }
  if (!next) {
    throw new Error('No pending fake model request is available to release.');
  }
  return next;
}
