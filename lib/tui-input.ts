/** True when the agent's composer line (Claude ❯ / Codex ›) holds text. */
export function inputHasText(pane: string): boolean {
  const prompts = pane.split('\n').filter(line => /^[❯›]/.test(line));
  const last = prompts[prompts.length - 1];
  return !!last && last.replace(/^[❯›]/, '').trim().length > 0;
}

/** True when a Claude Code composer line is visible (not a dialog or menu). */
export function composerVisible(pane: string): boolean {
  return pane.split('\n').some(line => /^❯/.test(line));
}
