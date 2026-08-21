import { runtimeContextSnapshot, type RuntimeContextSnapshot } from '../runtimeContext.js';

export type GetCurrentDatetimeOutput = RuntimeContextSnapshot;

export async function runGetCurrentDatetime(): Promise<{
  output: GetCurrentDatetimeOutput;
  truncated: false;
}> {
  return { output: runtimeContextSnapshot(), truncated: false };
}
