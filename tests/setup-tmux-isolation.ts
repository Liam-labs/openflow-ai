/**
 * Keeps every test away from the live tmux server.
 *
 * The agents run inside tmux. A test run from an agent's terminal inherits `TMUX` (the live server's socket), and tmux prefers `TMUX`
 * over `TMUX_TMPDIR`, so a test that "isolated" itself with TMUX_TMPDIR and then ran `tmux kill-server` killed every agent's session
 * (22 Oct to 25 Oct 2026: six mass drops, each seconds after someone ran vitest). Forget the inherited socket, and point any tmux call
 * a test makes without its own isolation at a private directory.
 */
// Node's own modules come from process.getBuiltinModule, not import: a jsdom test file has its imports resolved for the
// browser, where "node:fs" does not exist, and the static imports failed every jsdom suite with "No such built-in module".
const { mkdtempSync, rmSync } = process.getBuiltinModule('node:fs') as typeof import('node:fs');
const { tmpdir } = process.getBuiltinModule('node:os') as typeof import('node:os');
const { join } = process.getBuiltinModule('node:path') as typeof import('node:path');

delete process.env.TMUX;
delete process.env.TMUX_PANE;
if (!process.env.TMUX_TMPDIR || process.env.TMUX_TMPDIR === '/tmp') {
  const dir = mkdtempSync(join(tmpdir(), 'vitest-tmux-'));
  process.env.TMUX_TMPDIR = dir;
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
}
