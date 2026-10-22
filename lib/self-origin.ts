/**
 * Where this app reaches itself: the port it listens on, on this machine.
 *
 * Server-side calls from the app to its own API used a fixed `http://localhost:3000`. On a machine where another program owns port 3000
 * (a second copy, a forwarder, a dev server) those calls went to that program, carrying this app's access token. Reading `PORT` (the same
 * variable `next start` and the setup script use) keeps every call on the app's own socket.
 */
export function selfOrigin(env: Record<string, string | undefined> = process.env): string {
  const port = /^\d{1,5}$/.test(env.PORT || '') ? env.PORT : '3000';
  return `http://127.0.0.1:${port}`;
}
