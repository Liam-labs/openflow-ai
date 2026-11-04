/** OpenFlow's own additions to shared pages. DevFlow has its own copy of this file with an empty list. */
import type { InstanceUiExtensions } from '@/lib/instance-extensions';
import { SetupStatusStrip } from '@/components/setup/SetupStatusStrip';

export const uiExtensions: InstanceUiExtensions = {
  channelBanners: [SetupStatusStrip],
};
