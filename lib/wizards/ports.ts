/**
 * Ports that must never be published by any wizard. A browser started with remote debugging offers full control of every website it
 * is signed in to, to anyone who can reach its port: the browser wizard picks from 9223-9239 and 9222 is Chrome's usual default,
 * so the whole 9222-9239 range, the other common debugging ports and the WebDriver ports are off limits.
 */
const DEBUG_RANGE: [number, number] = [9222, 9239];
const OTHER_DEBUG = new Set([9333, 9515, 9516, 4444, 2828]);

export function isBrowserDebugPort(port: number): boolean {
  return (port >= DEBUG_RANGE[0] && port <= DEBUG_RANGE[1]) || OTHER_DEBUG.has(port);
}

export const BROWSER_PORT_FIRST = 9223;
export const BROWSER_PORT_LAST = 9239;
