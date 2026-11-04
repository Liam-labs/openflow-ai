import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// In server mode the app answers 401 to a caller with no API token, and an agent is not "this machine". A wrapper that calls its own server with a
// plain urllib.request.urlopen sends no token, so its agents cannot join their channel or post. Every runtime wrapper goes through
// scripts/devflow_http.py, which adds the token only for this installation's own address and never across a redirect.
const scripts = resolve(__dirname, '../../scripts');
const wrappers = readdirSync(scripts).filter((f) => /^collab-.*\.py$/.test(f)).sort();

describe('runtime wrappers call their own server with the API token', () => {
  it('finds the wrappers this guard is meant to cover', () => {
    expect(wrappers).toEqual(expect.arrayContaining(['collab-claude.py', 'collab-codex.py', 'collab-gemini.py', 'collab-grok.py', 'collab-agent.py']));
  });
  it.each(wrappers)('%s makes no bare urllib.request.urlopen call and imports the helper', (file) => {
    const src = readFileSync(resolve(scripts, file), 'utf8');
    expect(src.match(/urllib\.request\.urlopen\(/g) ?? []).toEqual([]);
    if (/devflow_urlopen\(/.test(src)) expect(src).toContain('from devflow_http import urlopen as devflow_urlopen');
  });
});
