#!/usr/bin/env node
/**
 * Prints one value from the secret store, for the Python agent wrapper (scripts/collab-claude.py), which has no AES library.
 * The name is the only argument. The value goes to stdout and never to a command line or a log. Exit 1 with nothing printed when the
 * name is not stored or the file cannot be read.
 *
 * Reads the same file and key as lib/secret-store.ts: DEVFLOW_SECRETS_FILE, OPENFLOW_SECRETS_KEY or DEVFLOW_SECRETS_KEY_FILE.
 * tests/unit/secret-box.test.ts checks that this script and the app agree on the format.
 */
import { readFileSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const AAD = Buffer.from('openflow-secrets:v1');

function keyFromEnv() {
  const direct = (process.env.OPENFLOW_SECRETS_KEY || '').trim();
  const file = process.env.DEVFLOW_SECRETS_KEY_FILE
    ? path.resolve(process.env.DEVFLOW_SECRETS_KEY_FILE)
    : path.join(process.env.HOME || process.env.DEVFLOW_HOME || os.homedir(), '.openflow', 'secrets.key');
  const key = Buffer.from(direct || readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error('bad key');
  return key;
}

function secretsFile() {
  if (process.env.DEVFLOW_SECRETS_FILE) return path.resolve(process.env.DEVFLOW_SECRETS_FILE);
  const root = process.env.DEVFLOW_HOME || process.cwd();
  const base = process.env.DEVFLOW_APP_DATA_DIR || '.AppData';
  return path.join(path.isAbsolute(base) ? base : path.join(root, base), 'secrets.json');
}

try {
  const name = process.argv[2];
  if (!name) process.exit(1);
  let data = JSON.parse(readFileSync(secretsFile(), 'utf8'));
  if (data && data.v === 1 && data.alg === 'aes-256-gcm') {
    const d = createDecipheriv('aes-256-gcm', keyFromEnv(), Buffer.from(data.iv, 'base64'));
    d.setAAD(AAD);
    d.setAuthTag(Buffer.from(data.tag, 'base64'));
    data = JSON.parse(Buffer.concat([d.update(Buffer.from(data.data, 'base64')), d.final()]).toString('utf8'));
  }
  const value = data && typeof data[name] === 'string' ? data[name] : '';
  if (!value) process.exit(1);
  process.stdout.write(value);
} catch {
  process.exit(1);
}
