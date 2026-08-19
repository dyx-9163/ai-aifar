import { ACTIVE_THREAD_DELETE_ERROR } from '../shared/operationErrors';
import type { Translator } from './i18n';

export type DeleteTargetKind = 'thread';

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
  const activeFailure = detail.includes(ACTIVE_THREAD_DELETE_ERROR);

  return {
    kind,
    targetId,
    message: activeFailure ? t('deleteActiveChatFailed') : t('deleteChatFailed'),
  };
}
