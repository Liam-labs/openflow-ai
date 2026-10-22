// Stand-in for a feature that is not part of this edition. It keeps the app compiling; the feature is off.

export async function execute(_body: unknown, _auth: unknown): Promise<unknown> {
  return { success: false, error: 'Hearing is not part of this edition' };
}
