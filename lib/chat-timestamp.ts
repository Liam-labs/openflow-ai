/**
 * Pure helpers for formatting chat message timestamps.
 */

/**
 * Formats a timestamp as an absolute time string (e.g. "11:59am").
 * Uses en-US locale with 12-hour clock so output is consistent across environments.
 */
export function formatAbsoluteTime(timestamp: string | number): string {
  return new Date(timestamp)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .toLowerCase()
    .replace(' ', '');
}
