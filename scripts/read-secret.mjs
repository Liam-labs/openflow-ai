#!/usr/bin/env node
// Decrypt one enc:v1: value from DevFlow's secret store (lib/secret-vault.ts format) for readers that are not the app.
// Usage: node read-secret.mjs NAME < value      The stored value comes in on stdin (never on a command line); the plain text goes to stdout.
// Key: DEVFLOW_SECRETS_KEY (base64 or hex), else the key file (DEVFLOW_SECRETS_KEY_FILE or ~/.config/devflow/secrets.key).
// Exit 0 on success, 2 when there is nothing to decrypt or no key, 3 when the value does not decrypt. Nothing secret is ever written to stderr.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDecipheriv } from 'node:crypto';

const PREFIX = 'enc:v1:';
const name = process.argv[2] || '';
const fail = (code, message) => { process.stderr.write(message + '\n'); process.exit(code); };

function parseKey(text) {
  const t = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(t)) {
    const buf = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return buf.length === 32 ? buf : null;
  }
  return null;
}

function loadKey() {
  const fromEnv = (process.env.DEVFLOW_SECRETS_KEY || '').trim();
  if (fromEnv) return parseKey(fromEnv);
  const file = process.env.DEVFLOW_SECRETS_KEY_FILE
    || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'devflow', 'secrets.key');
  try { return parseKey(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const blob = fs.readFileSync(0, 'utf8').trim();
if (!name || !blob.startsWith(PREFIX)) fail(2, 'nothing to decrypt');
const key = loadKey();
if (!key) fail(2, 'no encryption key available');
try {
  const raw = Buffer.from(blob.slice(PREFIX.length), 'base64');
  if (raw.length < 29) fail(3, 'damaged value');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(name, 'utf8'));
  d.setAuthTag(raw.subarray(12, 28));
  process.stdout.write(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
} catch {
  fail(3, 'cannot decrypt with the current key');
}
