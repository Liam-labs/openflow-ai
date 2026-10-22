// Stand-in for a feature that is not part of this edition. It keeps the app compiling; the feature is off.

export function manifestFor(_pathname: string | null): string {
  return '/manifest.webmanifest';
}
