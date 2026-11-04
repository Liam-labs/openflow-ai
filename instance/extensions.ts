/** OpenFlow's own additions to shared code. DevFlow has its own copy of this file with an empty list. */
import type { InstanceExtensions } from '@/lib/instance-extensions';
import { setupChannelHook } from '@/lib/setup/setup-channel-hook';

export const extensions: InstanceExtensions = {
  afterFirstTeam: [setupChannelHook],
};
