import { describe, expect, it } from 'vitest';
import { inputHasText } from '@/lib/tui-input';

describe('inputHasText', () => {
  it('sees a prompt restored after an interrupt (Claude)', () => {
    expect(inputHasText('──────\n❯ Write a 600-word essay about bridges.\n──────\n  ⏵⏵ bypass permissions on')).toBe(true);
  });
  it('treats an empty Claude prompt (with nbsp) as empty', () => {
    expect(inputHasText('──────\n❯ \n──────')).toBe(false);
  });
  it('handles the Codex composer', () => {
    expect(inputHasText('› restored text')).toBe(true);
    expect(inputHasText('›')).toBe(false);
  });
  it('ignores dialog selections that are not the composer', () => {
    expect(inputHasText(' ❯ No, exit\n   Yes, I trust this folder')).toBe(false);
  });
});
