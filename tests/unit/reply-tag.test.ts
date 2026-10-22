import { describe, it, expect } from 'vitest';
import { replyTag, shortReplyId, hasReplyTag, stripReplyTag, withReplyTag } from '@/lib/reply-tag';

const ID = '1538c43d-d16e-4f24-9b27-57e40dd3b8cf';

describe('reply tag', () => {
  it('uses the first 8 characters of the message id', () => {
    expect(replyTag(ID)).toBe('[re 1538c43d]');
    expect(shortReplyId(ID)).toBe('1538c43d');
  });

  it('puts the tag, then the mention, in front of the draft', () => {
    expect(withReplyTag('', ID, 'Developer')).toBe('[re 1538c43d] @Developer ');
    expect(withReplyTag('thanks', ID, 'Developer')).toBe('[re 1538c43d] @Developer thanks');
  });

  it('does not double the mention or the tag', () => {
    const once = withReplyTag('@Developer thanks', ID, 'Developer');
    expect(once).toBe('[re 1538c43d] @Developer thanks');
    expect(withReplyTag(once, ID, 'Developer')).toBe(once);
  });

  it('swaps the tag when replying to a different message', () => {
    const first = withReplyTag('hello', ID, 'Developer');
    expect(withReplyTag(first, 'abcdef12-0000-4000-8000-000000000000', 'Builder'))
      .toBe('[re abcdef12] @Builder @Developer hello');
  });

  it('detects and strips the tag', () => {
    const text = withReplyTag('hi', ID, 'Developer');
    expect(hasReplyTag(text, ID)).toBe(true);
    expect(hasReplyTag('@Developer hi', ID)).toBe(false);
    expect(stripReplyTag(text)).toBe('@Developer hi');
    expect(stripReplyTag('no tag here')).toBe('no tag here');
  });
});
