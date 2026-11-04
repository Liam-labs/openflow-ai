/**
 * The command a person runs to look at an agent's own terminal screen.
 *
 * Agents run in tmux. On a container install that tmux lives inside the container, so the bare `tmux attach` fails there ("no server
 * running"). The same text is shown by the silent-agent note and by the Open terminal message, so both come from this one function.
 * Only a plain tmux session name is accepted, because the result is meant to be typed into a terminal.
 */

import { runsInContainer } from '@/lib/runs-in-container';

/** The compose service and container are both called `openflow` (docker-compose.yml). */
export const CONTAINER_NAME = 'openflow';

const SAFE_SESSION = /^[A-Za-z0-9._:-]{1,120}$/;

export function attachCommand(tmuxSessionName: string | undefined | null, inContainer: boolean = runsInContainer()): string | undefined {
  if (!tmuxSessionName || !SAFE_SESSION.test(tmuxSessionName)) return undefined;
  return inContainer
    ? `docker compose exec -it ${CONTAINER_NAME} tmux attach -t ${tmuxSessionName}`
    : `tmux attach -t ${tmuxSessionName}`;
}
