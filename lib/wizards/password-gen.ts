/**
 * A password the sign-in wizard makes for the person: 16 letters and digits in four groups, for example "k7m2-q9xp-t4ha-w8cn".
 * The alphabet leaves out characters that look alike (0 o 1 l i). 31 symbols over 16 places is about 79 bits. Characters are drawn
 * with rejection sampling so each one is equally likely. Safe to import in the browser: it uses only Web Crypto.
 */
export const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // gitleaks:allow (an alphabet, not a key)

export function generatePassword(random: (n: number) => Uint8Array = n => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  const out: string[] = [];
  while (out.length < 16) {
    for (const byte of random(32)) {
      if (byte < limit) out.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]);
    }
  }
  return [0, 4, 8, 12].map(i => out.slice(i, i + 4).join('')).join('-');
}
