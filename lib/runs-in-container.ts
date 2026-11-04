import { existsSync } from 'fs';

/** True when this app runs inside a container (Docker or Podman). */
export const runsInContainer = (): boolean => existsSync('/.dockerenv') || existsSync('/run/.containerenv');
