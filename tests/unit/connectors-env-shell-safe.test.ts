import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { serializeConnectorEnv, parseConnectorEnv, validateKeyValue } from '@/lib/connectors/secrets';

// An agent's start-up now sources .UserData/connectors.env in a shell (PR 70), so whatever the Connections page
// writes must come back byte for byte and must never run as a command.
let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'cenv-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const NASTY = ["a'b", "'", "''", "x'; touch PWNED; echo '", '$(touch PWNED)', '`touch PWNED`', 'a"b', 'back\\slash', 'a b;c|d&e', '${HOME}', 'sk-ordinary-key_123'];

describe('connectors.env is safe to source in a shell', () => {
  it.each(NASTY)('round-trips %j through bash exactly, with no command run', (value) => {
    const file = path.join(dir, 'connectors.env');
    writeFileSync(file, serializeConnectorEnv({ DEEPSEEK_API_KEY: value }));
    const r = spawnSync('bash', ['-c', `cd ${JSON.stringify(dir)}; . ${JSON.stringify(file)}; printf %s "$DEEPSEEK_API_KEY"`], { encoding: 'utf8' });
    expect(r.stdout).toBe(value);
    expect(existsSync(path.join(dir, 'PWNED'))).toBe(false);
  });
  it.each(NASTY)('parses %j back to the same value', (value) => {
    expect(parseConnectorEnv(serializeConnectorEnv({ K_EY: value }))).toEqual({ K_EY: value });
  });
  it('refuses a value with a line break, which could end the quoted line', () => {
    expect(() => validateKeyValue("a'\ntouch PWNED\n'")).toThrow();
  });
});
