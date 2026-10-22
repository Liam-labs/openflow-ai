/**
 * Seats that look alive but are not picking up their durable queue.
 *
 * The delivery monitor decides which seats are stuck; presence reads the result.
 * A Codex seat whose wrapper keeps heartbeating "idle" while its queue sits
 * unclaimed (Jack, 15-17 Oct 2026) must not be reported online: senders get the
 * offline refusal and its queue stops counting as live. The set is held in memory
 * on purpose: it is rebuilt within two monitor passes after a restart, and it
 * expires on its own if the monitor stops refreshing it, so a flag can never
 * outlive the monitor that wrote it.
 */

export interface StuckSeat {
  channelId: string;
  participantId: string;
  name: string;
  channelName: string;
  /** Unclaimed messages waiting for this seat. */
  count: number;
  /** How long the oldest of them has waited while the seat was up and idle. */
  oldestWaitMs: number;
  oldestMessageId: string;
}

/** The set is ignored once the monitor has not refreshed it for this long. */
export const STUCK_SEATS_TTL_MS = 5 * 60 * 1000;

interface StuckSeatRegistry {
  seats: Map<string, StuckSeat>;
  refreshedAt: number;
}

declare global {
  // Shared across bundled copies of this module, like the data-io locks.
  var __devflowStuckSeats: StuckSeatRegistry | undefined;
}

const registry: StuckSeatRegistry = globalThis.__devflowStuckSeats ??= { seats: new Map(), refreshedAt: 0 };

export function seatKey(channelId: string, participantId: string): string {
  return `${channelId}:${participantId}`;
}

/** Replace the whole set with the seats the latest monitor pass confirmed. */
export function replaceStuckSeats(seats: StuckSeat[], nowMs: number = Date.now()): void {
  registry.seats.clear();
  for (const seat of seats) registry.seats.set(seatKey(seat.channelId, seat.participantId), seat);
  registry.refreshedAt = nowMs;
}

export function isSeatStuck(channelId: string, participantId: string, nowMs: number = Date.now()): boolean {
  if (registry.seats.size === 0 || nowMs - registry.refreshedAt > STUCK_SEATS_TTL_MS) return false;
  return registry.seats.has(seatKey(channelId, participantId));
}

export function listStuckSeats(nowMs: number = Date.now()): StuckSeat[] {
  if (nowMs - registry.refreshedAt > STUCK_SEATS_TTL_MS) return [];
  return [...registry.seats.values()];
}
