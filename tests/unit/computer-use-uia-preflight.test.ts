/**
 * Unit tests for shouldRetryUiaSnapshot (audit task 3a0a980a).
 *
 * Notepad UWP / Calculator return near-empty UIA trees until the window has
 * keyboard focus. The preflight detects this case (low elementCount + UWP
 * process/class signature) and tells the wrapper to send a no-op shift
 * keypress and re-snapshot once.
 *
 * Acceptance: cold-launched Notepad UWP returns full tree on first call to
 * the wrapper.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldRetryUiaSnapshot,
  UWP_PROCESS_SIGNATURES,
  UWP_CLASS_NAMES,
} from '@/app/api/agent/actions/computer-use';

describe('shouldRetryUiaSnapshot', () => {
  it('returns false when elementCount >= 5 even for UWP processes', () => {
    expect(shouldRetryUiaSnapshot({
      elementCount: 5,
      process: 'ApplicationFrameHost.exe',
      tree: 'ApplicationFrameWindow root\n  Window\n  Pane',
    })).toBe(false);
    expect(shouldRetryUiaSnapshot({
      elementCount: 25,
      process: 'ApplicationFrameHost.exe',
      tree: '',
    })).toBe(false);
  });

  it('returns true when elementCount < 5 and process matches ApplicationFrameHost', () => {
    expect(shouldRetryUiaSnapshot({
      elementCount: 1,
      process: 'ApplicationFrameHost.exe',
    })).toBe(true);
  });

  it('matches process names case-insensitively', () => {
    expect(shouldRetryUiaSnapshot({
      elementCount: 0,
      process: 'applicationframehost.exe',
    })).toBe(true);
  });

  it('returns true when tree text contains ApplicationFrameWindow class', () => {
    expect(shouldRetryUiaSnapshot({
      elementCount: 2,
      process: 'Notepad.exe',
      tree: '- Window "ApplicationFrameWindow" [ref=e1]\n  - Pane [ref=e2]',
    })).toBe(true);
  });

  it('returns true when tree text contains Windows.UI.Core.CoreWindow class', () => {
    expect(shouldRetryUiaSnapshot({
      elementCount: 2,
      tree: 'Window: Windows.UI.Core.CoreWindow',
    })).toBe(true);
  });

  it('returns false when elementCount < 5 but no UWP signature matches', () => {
    expect(shouldRetryUiaSnapshot({
      elementCount: 3,
      process: 'notepad.exe',
      tree: '- Window "Untitled - Notepad"\n  - Edit',
    })).toBe(false);
  });

  it('returns false when elementCount and process are both empty (no UWP markers)', () => {
    expect(shouldRetryUiaSnapshot({
      elementCount: 0,
      process: null,
      tree: '',
    })).toBe(false);
  });

  it('falls back to elements.length when elementCount is undefined', () => {
    expect(shouldRetryUiaSnapshot({
      elements: [{ ref: 'e1' }, { ref: 'e2' }],
      process: 'ApplicationFrameHost.exe',
    })).toBe(true);
  });

  it('treats missing elements + missing elementCount as zero (low) but still needs UWP signature', () => {
    expect(shouldRetryUiaSnapshot({})).toBe(false);
    expect(shouldRetryUiaSnapshot({ process: 'ApplicationFrameHost.exe' })).toBe(true);
  });

  it('SystemSettings.exe is detected as UWP', () => {
    expect(shouldRetryUiaSnapshot({
      elementCount: 1,
      process: 'SystemSettings.exe',
    })).toBe(true);
  });

  it('exposes the signature lists for downstream introspection', () => {
    // Sanity: the lists used inside the helper are exported so tests / docs
    // can reference them without re-deriving.
    expect(UWP_PROCESS_SIGNATURES.length).toBeGreaterThan(0);
    expect(UWP_CLASS_NAMES).toContain('ApplicationFrameWindow');
    expect(UWP_CLASS_NAMES).toContain('Windows.UI.Core.CoreWindow');
  });
});
