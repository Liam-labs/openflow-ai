// Stand-in for a feature that is not part of this edition. It keeps the app compiling; the feature is off.

export function useRileyVoiceWatching() {
  return {
    available: false,
    watches: (_channelId: string): boolean => false,
    refresh: (): void => {},
    setWatching: async (_channel: { id: string; name: string }, _watching: boolean): Promise<void> => {},
  };
}
