/** Only a path on this site: "/x" yes; "//evil.example", "https://evil.example" and "/\evil" no. */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return '/';
  return value;
}
