import { createHash } from 'node:crypto';
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { TurnRollbackReport } from '../../shared/domain.js';
import type { AppDatabase } from '../database.js';
import { resolveWithinRoot } from './pathSecurity.js';

/**
 * Restores every file a turn changed, using the pre-turn checkpoints recorded
 * by apply_patch. A file is only restored when its current content hash still
 * matches the last content the turn wrote, so changes the user made afterwards
 * are never clobbered; such files are reported as skipped. Checkpoints are
 * one-shot: they are deleted after the rollback attempt.
 */
export function rollbackTurnFileChanges(database: AppDatabase, turnId: string): TurnRollbackReport {
  const checkpoints = database.listTurnCheckpoints(turnId);
  const restored: string[] = [];
  const skipped: string[] = [];

  for (const checkpoint of checkpoints) {
    const workspace = database.getWorkspace(checkpoint.workspaceId);
    if (!workspace) {
      skipped.push(checkpoint.relativePath);
      continue;
    }
    try {
      const absolute = resolveWithinRoot(workspace.canonicalRootPath, checkpoint.relativePath);
      const stat = safeStat(absolute);
      const currentHash = stat && stat.isFile() ? sha256File(absolute) : '';
      if (currentHash !== checkpoint.latestContentHash) {
        // Missing, replaced, or edited since the turn wrote it: do not touch it.
        skipped.push(checkpoint.relativePath);
        continue;
      }
      if (checkpoint.previousAction === 'absent') {
        unlinkSync(absolute);
      } else {
        writeFileSync(absolute, checkpoint.previousContent ?? '', 'utf-8');
      }
      restored.push(checkpoint.relativePath);
    } catch {
      skipped.push(checkpoint.relativePath);
    }
  }

  if (checkpoints.length > 0) {
    database.deleteTurnCheckpoints(turnId);
  }
  return { restored, skipped };
}

function sha256File(absolute: string): string {
  return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

function safeStat(target: string) {
  try {
    return statSync(target);
  } catch {
    return undefined;
  }
}
