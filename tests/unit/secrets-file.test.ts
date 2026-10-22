import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applySecrets, parseSecretsFile, secretNameAllowed, secretValueAllowed, shellQuote } from '@/lib/secrets-file';

/** What a shell sees after sourcing the text, and whether anything ran. */
function source(text: string, names: string[]): { values: Record<string, string>; ran: boolean } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-'));
  try {
    const file = path.join(dir, 'secrets');
    fs.writeFileSync(file, text);
    const marker = path.join(dir, 'RAN');
    const script = names.map((n) => `printf '%s\\0' "$${n}"`).join('; ');
    const out = execFileSync('bash', ['-c', `cd "${dir}"; . "${file}"; ${script}`], { env: { PATH: process.env.PATH, MARKER: marker }, encoding: 'utf8' });
    const parts = out.split('\0');
    return { values: Object.fromEntries(names.map((n, i) => [n, parts[i]])), ran: fs.existsSync(marker) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PAYLOADS = ['$(touch "$MARKER")', '`touch "$MARKER"`', 'a";touch "$MARKER";#', 'a\\";touch "$MARKER";#', "a'; touch \"$MARKER\"; echo '", '${MARKER}', "it's a $HOME \\n test", '$& $\' $1 $$', 'plain-value_123', '"quoted"', '\\', '!history !!', '#hash', ' leading and trailing '];

describe('writing ~/.secrets', () => {
  it.each(PAYLOADS)('a hostile or odd value is stored literally and never runs: %s', (value) => {
    const { content } = applySecrets('', { MY_KEY: value });
    const { values, ran } = source(content, ['MY_KEY']);
    expect(ran).toBe(false);
    expect(values.MY_KEY).toBe(value);
  });

  it('adds to an existing file without touching other lines, and round-trips through the parser', () => {
    const existing = '# mine\nexport OLD_KEY="old\\"value"\nexport SOME_PATH=$HOME/bin\n';
    const { content, added } = applySecrets(existing, { NEW_KEY: "it's" });
    expect(added).toEqual(['NEW_KEY']);
    expect(content.startsWith(existing.trimEnd())).toBe(true);
    expect(parseSecretsFile(content).get('NEW_KEY')).toBe("it's");
    expect(parseSecretsFile(content).get('OLD_KEY')).toBe('old"value');
    expect(source(content, ['NEW_KEY', 'OLD_KEY']).values).toEqual({ NEW_KEY: "it's", OLD_KEY: 'old"value' });
  });

  it('updates a changed value in place and leaves an equal one alone', () => {
    const first = applySecrets('', { A_KEY: 'one', B_KEY: 'two' }).content;
    const second = applySecrets(first, { A_KEY: 'changed', B_KEY: 'two' });
    expect(second.updated).toEqual(['A_KEY']);
    expect(second.added).toEqual([]);
    expect(source(second.content, ['A_KEY', 'B_KEY']).values).toEqual({ A_KEY: 'changed', B_KEY: 'two' });
    expect(applySecrets(second.content, { A_KEY: 'changed' }).content).toBe(second.content);
  });

  it('refuses names that could change how a shell or program behaves, and bad names', () => {
    for (const name of ['PATH', 'LD_PRELOAD', 'BASH_ENV', 'IFS', 'PS1', 'PROMPT_COMMAND', 'NODE_OPTIONS', 'PYTHONPATH', 'GIT_SSH_COMMAND', 'HOME', 'SHELL', 'BASH_FUNC_x%%', 'lower', '1ABC', 'A-B', 'A B', 'A;B', 'A=B', '', 'OP_SERVICE_ACCOUNT_TOKEN']) {
      expect(secretNameAllowed(name), name).toBe(false);
    }
    for (const name of ['ANTHROPIC_API_KEY', 'SLACK_BOT_TOKEN', '_X', 'A1']) expect(secretNameAllowed(name), name).toBe(true);
    const result = applySecrets('', { LD_PRELOAD: '/tmp/evil.so', GOOD_KEY: 'v' });
    expect(result.refused).toEqual(['LD_PRELOAD']);
    expect(result.content).not.toMatch(/LD_PRELOAD/);
  });

  it('refuses values with a newline, carriage return, NUL, nothing, or too much', () => {
    for (const value of ['a\nexport X=1', 'a\rb', 'a\0b', '', 'x'.repeat(8193)]) expect(secretValueAllowed(value)).toBe(false);
    const r = applySecrets('# keep\n', { A_KEY: 'a\nrm -rf ~' });
    expect(r.refused).toEqual(['A_KEY']);
    expect(r.content).toBe('# keep\n');
  });

  it('replacement text with $ patterns is not expanded when a value is updated', () => {
    const first = applySecrets('', { A_KEY: 'one' }).content;
    const second = applySecrets(first, { A_KEY: "$& $' $1 $`" });
    expect(source(second.content, ['A_KEY']).values.A_KEY).toBe("$& $' $1 $`");
  });

  it('shellQuote handles quotes', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});
