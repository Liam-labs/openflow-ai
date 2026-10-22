import { describe, expect, it } from 'vitest';

import {
  addDismissedQuestionId,
  parseDismissedQuestionIds,
  serializeDismissedQuestionIds,
} from '@/lib/ask-owner/dismissed';

describe('Ask-Owner dismissed question persistence', () => {
  it('round-trips unique question ids', () => {
    const dismissed = addDismissedQuestionId(new Set(['q-1']), 'q-2');

    expect(parseDismissedQuestionIds(serializeDismissedQuestionIds(dismissed)))
      .toEqual(new Set(['q-1', 'q-2']));
  });

  it('fails closed to an empty set for malformed or unexpected storage data', () => {
    expect(parseDismissedQuestionIds('{broken')).toEqual(new Set());
    expect(parseDismissedQuestionIds(JSON.stringify({ questionIds: ['q-1'] }))).toEqual(new Set());
  });

  it('ignores blank and non-string ids', () => {
    expect(parseDismissedQuestionIds(JSON.stringify(['q-1', '', 42, 'q-1'])))
      .toEqual(new Set(['q-1']));
  });
});
