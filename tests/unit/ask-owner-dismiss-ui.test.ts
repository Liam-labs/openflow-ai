import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('answered Ask-Owner card dismissal UI', () => {
  it('offers a labelled text action only on the collapsed answered card', async () => {
    const source = await readFile('components/AskOwnerCard.tsx', 'utf8');

    expect(source).toContain('onDismiss?: () => void');
    expect(source).toContain('aria-label="Dismiss answered question"');
    expect(source).toMatch(/<X[^>]*\/>\s*Dismiss/);
  });

  it('hides and persists the entire answered question message when dismissed', async () => {
    const source = await readFile('components/ColabChatView.tsx', 'utf8');

    expect(source).toContain('isDismissedAnsweredQuestion(question, askOwnerAnswers, dismissedQuestionIds)');
    expect(source).toContain('onDismiss={() => dismissAnsweredQuestion(question.id)}');
    expect(source).toMatch(/localStorage\.setItem\(\s*ASK_OWNER_DISMISSED_STORAGE_KEY/);
    expect(source).toContain('React.useSyncExternalStore(');
  });
});
