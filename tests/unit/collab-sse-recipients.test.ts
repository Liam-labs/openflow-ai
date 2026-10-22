import { describe, it, expect } from 'vitest';
import { sseConnectionShouldReceiveMessage } from '@/lib/collab-delivery';

/**
 * SSE-leg recipients gate — targeted-over-SSE answer-leak fix.
 *
 * Bug: eventBus fans 'collab:message' to EVERY channel SSE subscriber, but the
 * events route (`shouldSend`) never honored `message.recipients[]`. A targeted
 * message — e.g. an Ask-Owner answer reshaped to `recipients=[asker]`, isHidden,
 * deliveryMode:'targeted' (lib/ask-owner/route.ts) — was therefore pushed to, and
 * injected by, EVERY agent's wrapper, not just the asker.
 *
 * Fix: an AGENT SSE connection only receives a targeted message if its
 * participantId is in `recipients[]` — mirroring `deliverMessage`'s inbox/PTY
 * filtering (collab-delivery.ts:367-369). Broadcasts (recipients null/empty)
 * still reach every agent. Human/browser connections (isAgentConnection=false)
 * are NEVER filtered, so the channel UI keeps rendering every message in real
 * time and Ask-Owner card-collapse (which rides the hidden answer SSE event)
 * keeps working.
 */
describe('sseConnectionShouldReceiveMessage (SSE recipients gate)', () => {
  const ASKER = 'roster-asker';
  const OTHER = 'roster-other';
  const HUMAN = 'browser-user-1';

  it('LEAK CASE: an agent NOT in a targeted recipients list does not receive it', () => {
    expect(sseConnectionShouldReceiveMessage([ASKER], OTHER, true)).toBe(false);
  });

  it('an agent IN the targeted recipients list receives it', () => {
    expect(sseConnectionShouldReceiveMessage([ASKER], ASKER, true)).toBe(true);
  });

  it('broadcast (recipients null) reaches every agent', () => {
    expect(sseConnectionShouldReceiveMessage(null, OTHER, true)).toBe(true);
  });

  it('broadcast (recipients undefined) reaches every agent', () => {
    expect(sseConnectionShouldReceiveMessage(undefined, OTHER, true)).toBe(true);
  });

  it('broadcast (recipients empty array) reaches every agent', () => {
    expect(sseConnectionShouldReceiveMessage([], OTHER, true)).toBe(true);
  });

  it('human/browser connection is never filtered (targeted, not in recipients)', () => {
    expect(sseConnectionShouldReceiveMessage([ASKER], HUMAN, false)).toBe(true);
  });

  it('agent with no resolved participantId is not over-filtered (defensive)', () => {
    expect(sseConnectionShouldReceiveMessage([ASKER], null, true)).toBe(true);
  });

  it('multi-recipient @mention: a listed agent receives, an unlisted agent does not', () => {
    // computeRecipients always adds the user id, so a normal @mention reaches the
    // human + the mentioned agent, but never an unmentioned agent.
    const recipients = [ASKER, HUMAN];
    expect(sseConnectionShouldReceiveMessage(recipients, ASKER, true)).toBe(true);
    expect(sseConnectionShouldReceiveMessage(recipients, OTHER, true)).toBe(false);
  });
});
