// Stand-in for a feature that is not part of this edition. It keeps the app compiling; the feature is off.

export type ParsedCredential = any;

export function parseCredentialsMarkdown(_markdown: string): ParsedCredential[] {
  return [];
}

export function convertToSecrets(_credentials: ParsedCredential[]): any[] {
  return [];
}

export function getImportSummary(credentials: ParsedCredential[]): { total: number; byCategory: Record<string, number> } {
  return { total: credentials.length, byCategory: {} };
}
