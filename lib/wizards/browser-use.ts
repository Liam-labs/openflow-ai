/**
 * Browser-use wizard, the parts that load heavier modules: the test picture (Playwright), agent access (the MCP lists) and the
 * Tailscale Serve check. Everything else is in browser-core.ts so app start-up can use it without loading these.
 * Import from here everywhere except instrumentation.ts.
 */
import { coreDeps, type Deps } from './browser-core';

export * from './browser-core';

export async function realShoot(port: number, nonce: string): Promise<{ ok: boolean; bytes: number; detail: string }> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
    try {
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      const page = await ctx.newPage();
      try {
        await page.setContent(`<html><body style="font:32px sans-serif;padding:24px"><h1 id="n">${nonce}</h1></body></html>`);
        const text = await page.textContent('#n');
        const png = await page.screenshot({ type: 'png' });
        const isPng = png.length > 500 && png[0] === 0x89 && png.toString('ascii', 1, 4) === 'PNG';
        return { ok: isPng && text === nonce, bytes: png.length, detail: isPng && text === nonce ? `A test page was opened and photographed (${png.length} bytes).` : 'The picture or the page text was not as expected.' };
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await browser.close().catch(() => undefined);        // detaches from the browser; it keeps running
    }
  } catch (error) {
    return { ok: false, bytes: 0, detail: `Could not drive the browser: ${error instanceof Error ? error.message.split('\n')[0].slice(0, 160) : 'error'}` };
  }
}

export const PLAYWRIGHT_MCP_NAME = 'playwright-signed-in';

export function mcpConnector(port: number) {
  return {
    id: 'wizard-browser', name: 'Your signed-in browser', category: 'mcp', kind: 'mcp', summary: '', costKind: 'free', cost: 'Free.', detect: { mcp: PLAYWRIGHT_MCP_NAME },
    setup: { steps: [], mcp: { name: PLAYWRIGHT_MCP_NAME, transport: 'stdio' as const, command: 'npx', args: ['-y', '@playwright/mcp@latest', '--cdp-endpoint', `http://127.0.0.1:${port}`] } },
  } as unknown as import('../connectors/catalog').Connector;
}

export async function realMcp() {
  const apply = await import('../connectors/mcp-apply');
  return {
    add: async (port: number) => {
      const r = await apply.addMcp(mcpConnector(port), {}, new Set());
      return { ok: r.ok, message: r.results.map((x) => x.message).join(' ') };
    },
    remove: async () => {
      const r = await apply.removeMcp(mcpConnector(0));
      return { ok: r.ok || r.results.length === 0, message: r.results.map((x) => x.message).join(' ') };
    },
  };
}

export async function realServedPorts(): Promise<number[]> {
  try {
    const t = await import('./tailscale');
    const r = await t.defaultRunTs(['serve', 'status', '--json']);
    if (r.code !== 0) return [];
    return t.parseServe(r.stdout).map((e) => Number(/:(\d{1,5})$/.exec(e.target ?? '')?.[1])).filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

export async function realDeps(env: Record<string, string | undefined> = process.env): Promise<Deps> {
  return { ...coreDeps(env), shoot: realShoot, servedPorts: realServedPorts, mcp: await realMcp() };
}
