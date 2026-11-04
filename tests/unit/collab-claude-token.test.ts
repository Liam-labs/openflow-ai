import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// In server mode the app refuses a caller with no API token (401), and an agent is not "this machine". The Claude wrapper made every call
// to its own server with no Authorization header, so no Claude agent could join its channel and none could post. The Codex wrapper
// had been fixed; this keeps both on scripts/devflow_http.py.
const scripts = resolve(__dirname, '../../scripts');
const TOKEN = 'dvf_live_test_token_0123456789';

describe('wrappers call their own server with the API token', () => {
  it.each(['collab-claude.py', 'collab-codex.py'])('%s makes no bare urllib.request.urlopen call', (file) => {
    const src = readFileSync(resolve(scripts, file), 'utf8');
    expect(src).toContain('from devflow_http import urlopen as devflow_urlopen');
    expect(src.match(/urllib\.request\.urlopen\(/g) ?? []).toEqual([]);
  });

  describe("the Claude wrapper's api_call, against a server that wants a token", () => {
    let server: Server;
    let url: string;
    const seen: Array<{ path: string; auth: string | undefined }> = [];
    beforeAll(async () => {
      server = createServer((req, res) => {
        seen.push({ path: req.url ?? '', auth: req.headers.authorization });
        if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; res.end('{"error":"unauthorized"}'); return; }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ success: true, channel: { id: 'c1' } }));
      });
      await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
      const addr = server.address();
      url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    });
    afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

    // spawn, not spawnSync: the test server lives in this process and must keep answering while Python waits for it.
    const call = (env: Record<string, string>) => new Promise<{ stdout: string }>((done) => {
      const src = readFileSync(resolve(scripts, 'collab-claude.py'), 'utf8');
      const start = src.indexOf('    def api_call(self, endpoint, method="GET", data=None):');
      const end = src.indexOf('    def _resolve_transcript', start);
      const body = src.slice(start, end).replace(/^    /gm, '');
      const py = [
        'import json, sys, urllib.request', `sys.path.insert(0, ${JSON.stringify(scripts)})`,
        'from devflow_http import urlopen as devflow_urlopen',
        `API_BASE = ${JSON.stringify(url + '/api/collab')}`, 'debug = lambda *a, **k: None', body,
        'print(json.dumps(api_call(None, "/join", "POST", {"x": 1})))',
      ].join('\n');
      const child = spawn('python3', ['-I', '-c', py], { env: { PATH: process.env.PATH, DEVFLOW_URL: url, ...env } });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('close', () => done({ stdout }));
    });

    it('sends the token, so the join succeeds', async () => {
      seen.length = 0;
      const r = await call({ DEVFLOW_API_TOKEN: TOKEN });
      expect(JSON.parse(r.stdout)).toMatchObject({ success: true });
      expect(seen.at(-1)?.auth).toBe(`Bearer ${TOKEN}`);
    });
    it('without a token it is refused, as before (nothing invents one)', async () => {
      const r = await call({});
      expect(JSON.parse(r.stdout).error).toMatch(/401/);
    });
  });
});
