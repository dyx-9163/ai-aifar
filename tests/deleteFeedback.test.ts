import { describe, expect, it } from 'vitest';
import { ACTIVE_GROUP_DELETE_ERROR, ACTIVE_THREAD_DELETE_ERROR } from '../src/shared/operationErrors';
import { deleteFailureFeedback } from '../src/renderer/deleteFeedback';
import { createTranslator } from '../src/renderer/i18n';

describe('delete operation feedback', () => {
  it('maps known active failures to the target operation and locale', () => {
    expect(deleteFailureFeedback(
      'thread',
      'thread-2',
      new Error(`Error invoking remote method 'desktop:request': Error: ${ACTIVE_THREAD_DELETE_ERROR}`),
      createTranslator('zh-CN'),
    )).toEqual({
      kind: 'thread',
      targetId: 'thread-2',
      message: '请先停止或取消正在执行的任务，再删除这个聊天。',
    });
    expect(deleteFailureFeedback(
      'group',
      'group-3',
      new Error(ACTIVE_GROUP_DELETE_ERROR),
      createTranslator('en-US'),
    )).toEqual({
      kind: 'group',
      targetId: 'group-3',
      message: 'Stop or cancel active turns before deleting this group.',
    });
  });

  it('uses an operation-specific localized fallback without exposing arbitrary worker text', () => {
    expect(deleteFailureFeedback(
      'thread',
      'thread-2',
      new Error('database internals'),
      createTranslator('en-US'),
    ).message).toBe('Could not delete this chat.');
    expect(deleteFailureFeedback(
      'group',
      'group-3',
      new Error('database internals'),
      createTranslator('zh-CN'),
    ).message).toBe('无法删除此分组。');
  });
});
