export interface OwnedApplication {
  close: () => Promise<void>;
  process: () => { kill: () => unknown };
}

export interface LifecycleFailureInput {
  milestone: string;
  healthTransitions: unknown[];
  applicationOutput: string;
  primaryFailure?: Error;
  secondaryFailures: Error[];
  knownSecret: string;
}

const bootstrapTokenPattern = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

function countLiteral(value: string, target: string): number {
  if (!target) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(target, offset)) !== -1) {
    count += 1;
    offset += target.length;
  }
  return count;
}

export function assertNoLifecycleLeaks(captured: string, knownSecret: string): void {
  const knownSecretCount = countLiteral(captured, knownSecret);
  const bootstrapTokenShapedCount = captured.match(bootstrapTokenPattern)?.length ?? 0;
  if (knownSecretCount === 0 && bootstrapTokenShapedCount === 0) return;
  throw new Error(
    'Lifecycle leak scan failed: '
      + `known-secret-count=${knownSecretCount}; `
      + `bootstrap-token-shaped-count=${bootstrapTokenShapedCount}`,
  );
}

export function sanitizeLifecycleDiagnostic(value: string, knownSecret: string): string {
  const withoutKnownSecret = knownSecret
    ? value.split(knownSecret).join('<redacted-known-secret>')
    : value;
  return withoutKnownSecret.replace(bootstrapTokenPattern, '<redacted-bootstrap-token>');
}

export function formatLifecycleFailure(input: LifecycleFailureInput): string {
  const raw = [
    `Task 9 lifecycle diagnostic failed at milestone: ${input.milestone}`,
    `Health transitions: ${JSON.stringify(input.healthTransitions)}`,
    `Application output: ${input.applicationOutput.trim() || '<empty>'}`,
    `Primary failure: ${input.primaryFailure?.stack ?? '<none>'}`,
    `Secondary failures: ${input.secondaryFailures
      .map((error) => error.stack ?? error.message)
      .join('\n---\n') || '<none>'}`,
  ].join('\n');
  return sanitizeLifecycleDiagnostic(raw, input.knownSecret);
}

async function closeLateApplication(app: OwnedApplication, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('late application close timed out')), timeoutMs);
      }),
    ]);
  } catch {
    app.process().kill();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function launchOwnedApplication<T extends OwnedApplication>(
  label: string,
  launch: Promise<T>,
  timeoutMs: number,
  cleanupTimeoutMs = 15_000,
): Promise<T> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const trackedLaunch = launch.then(async (app) => {
    if (!timedOut) return app;
    await closeLateApplication(app, cleanupTimeoutMs);
    throw new Error(`${label} resolved after its owner timed out.`);
  });

  try {
    return await Promise.race([
      trackedLaunch,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
