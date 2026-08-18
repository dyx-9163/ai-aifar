import {
  ACTIVE_GROUP_DELETE_ERROR,
  ACTIVE_THREAD_DELETE_ERROR,
} from '../shared/operationErrors';
import type { Translator } from './i18n';

export type DeleteTargetKind = 'thread' | 'group';

export interface DeleteFeedback {
  kind: DeleteTargetKind;
  targetId: string;
  message: string;
}

export function deleteFailureFeedback(
  kind: DeleteTargetKind,
  targetId: string,
  error: unknown,
  t: Translator,
): DeleteFeedback {
  const detail = error instanceof Error ? error.message : '';
  const activeFailure = kind === 'thread'
    ? detail.includes(ACTIVE_THREAD_DELETE_ERROR)
    : detail.includes(ACTIVE_GROUP_DELETE_ERROR);

  return {
    kind,
    targetId,
    message: activeFailure
      ? t(kind === 'thread' ? 'deleteActiveChatFailed' : 'deleteActiveGroupFailed')
      : t(kind === 'thread' ? 'deleteChatFailed' : 'deleteGroupFailed'),
  };
}
