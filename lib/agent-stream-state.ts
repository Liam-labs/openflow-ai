/**
 * Shared state module for /api/agent-stream.
 *
 * Sprint 36 Phase 1 hot-fix — Next.js App Router route files only permit a
 * whitelisted set of exports (GET/POST/etc, `dynamic`, `runtime`, etc). Any
 * other exported symbol is rejected at `npm run build` time, even if
 * `tsc --noEmit` accepts it. The original `route.ts` exported a module-level
 * counter and two test hooks, which broke the production build.
 *
 * Lives-outside-route reason: the SSE route needs a process-wide counter to
 * cap concurrent streams. A module-level `let` here keeps the same semantics
 * (survives across requests as long as the Node process is alive) while
 * staying invisible to the Next.js route export validator.
 */

export const MAX_CONCURRENT_STREAMS = 10;

let activeStreams = 0;

export function getActiveStreams(): number {
  return activeStreams;
}

export function incrementActiveStreams(): void {
  activeStreams++;
}

export function decrementActiveStreams(): void {
  activeStreams = Math.max(0, activeStreams - 1);
}

/** Test hook — reset the counter between test cases. */
export function __resetActiveStreamsForTest(): void {
  activeStreams = 0;
}

/** Test hook — introspect the counter from tests. */
export function __getActiveStreamsForTest(): number {
  return activeStreams;
}
