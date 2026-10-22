import { parsePrompt } from './prompt-parser';

/**
 * Resolve the exact text the composer dispatches (T3.1 — "Structure prompt").
 *
 * Must run client-side in handleSend so the optimistic bubble, the stored
 * message, and the live preview are all the same string (the optimistic flow
 * renders and posts the same `content`).
 *
 * - toggle OFF → raw content, verbatim.
 * - toggle ON  → parsePrompt(content).structured. The parser itself returns the
 *   raw content unchanged when it decides not to restructure (short / trivial /
 *   conversational), so passthrough is preserved without a separate guard.
 */
export function resolveSendContent(content: string, structureEnabled: boolean): string {
  if (!structureEnabled) return content;
  return parsePrompt(content).structured;
}
