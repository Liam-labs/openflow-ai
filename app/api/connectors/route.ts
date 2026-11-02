/**
 * /api/connectors: the optional connectors a user can set up (see data/connectors-catalog.json).
 *
 * GET   the catalog plus what this machine already has (names and states only, never a key).
 * POST  { action, id, ... }
 *   save-key    { id, env?, value }   store a key in the owner-only connectors file
 *   test-key    { id, value? }        check a pasted (or saved) key with the provider
 *   remove-key  { id, env? }
 *   add-mcp     { id, inputs? }       add the connector's MCP server to the user's Claude and Codex lists
 *   remove-mcp  { id }
 *   install     { id }                run the connector's install command, if it is a plain npm or docker one
 *   check       { id }                re-read one connector's state
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { loadCatalog, type Connector } from '@/lib/connectors/catalog';
import { detectAll, detectConnector, gatherFacts } from '@/lib/connectors/detect';
import { readConnectorEnv, removeConnectorKey, saveConnectorKey, validateKeyValue } from '@/lib/connectors/secrets';
import { testKey } from '@/lib/connectors/test-key';
import { addMcp, removeMcp } from '@/lib/connectors/mcp-apply';
import { runInstall } from '@/lib/connectors/install';
import { ConnectorInputError } from '@/lib/connectors/errors';

export const dynamic = 'force-dynamic';

/** Key names a connector owns: its own key and any secret its MCP server needs. */
function ownedKeyNames(c: Connector): string[] {
  const names: string[] = [];
  if (c.setup.key) names.push(c.setup.key.env);
  for (const e of c.setup.mcp?.env ?? []) names.push(e.name);
  return names;
}

function pickKeyName(c: Connector, wanted: unknown): string {
  const owned = ownedKeyNames(c);
  if (typeof wanted === 'string' && wanted) {
    if (!owned.includes(wanted)) throw new ConnectorInputError('That key does not belong to this connector.');
    return wanted;
  }
  if (owned.length !== 1) throw new ConnectorInputError('Say which key you mean.');
  return owned[0];
}

function bad(message: string, status = 400) {
  return NextResponse.json({ success: false, error: message }, { status });
}

export const GET = tracked('/api/connectors', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;
  try {
    const catalog = await loadCatalog();
    const saved = Object.keys(await readConnectorEnv());
    const facts = await gatherFacts(saved);
    const statuses = await detectAll(catalog.connectors, facts);
    return NextResponse.json({ success: true, catalog, statuses, savedKeys: saved });
  } catch (e) {
    console.error('[connectors] GET failed:', e instanceof Error ? e.message : 'unknown');
    return bad('The connectors list could not be read.', 500);
  }
});

export const POST = tracked('/api/connectors', async (request: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad('Send JSON.');
  }
  const action = typeof body.action === 'string' ? body.action : '';
  const denied = await requireAuthOrLocal(request, action === 'test-key' || action === 'check' ? 'write' : 'admin');
  if (denied) return denied;

  try {
    const catalog = await loadCatalog();
    const connector = catalog.connectors.find((c) => c.id === body.id);
    if (!connector) return bad('Unknown connector.', 404);
    const allowed = new Set(catalog.connectors.flatMap(ownedKeyNames));

    switch (action) {
      case 'save-key': {
        const name = pickKeyName(connector, body.env);
        await saveConnectorKey(name, body.value, allowed);
        return NextResponse.json({ success: true, saved: name });
      }
      case 'remove-key': {
        const name = pickKeyName(connector, body.env);
        return NextResponse.json({ success: true, removed: await removeConnectorKey(name) });
      }
      case 'test-key': {
        const testId = connector.setup.key?.test;
        if (!testId) return NextResponse.json({ success: true, ok: true, message: 'This provider has no check. The key is saved and will be used as it is.' });
        const name = pickKeyName(connector, body.env);
        const value = typeof body.value === 'string' && body.value.trim() ? validateKeyValue(body.value) : (await readConnectorEnv())[name];
        if (!value) return bad('Paste the key first.');
        const result = await testKey(testId, value);
        return NextResponse.json({ success: true, ...result });
      }
      case 'add-mcp': {
        const saved = new Set(Object.keys(await readConnectorEnv()));
        const inputs = body.inputs && typeof body.inputs === 'object' ? (body.inputs as Record<string, unknown>) : {};
        const result = await addMcp(connector, inputs, saved);
        return NextResponse.json({ success: result.ok, ...result });
      }
      case 'remove-mcp': {
        const result = await removeMcp(connector);
        return NextResponse.json({ success: result.ok, ...result });
      }
      case 'install': {
        const result = await runInstall(connector);
        return NextResponse.json({ success: result.ok, ...result });
      }
      case 'check': {
        const facts = await gatherFacts(Object.keys(await readConnectorEnv()));
        return NextResponse.json({ success: true, status: await detectConnector(connector, facts) });
      }
      default:
        return bad('Unknown action.');
    }
  } catch (e) {
    // Messages from our own validators are written for the reader and never contain a key.
    if (e instanceof ConnectorInputError) return bad(e.message);
    console.error('[connectors] POST failed:', action, e instanceof Error ? e.message.slice(0, 120) : 'unknown');
    return bad('That did not work. Nothing was changed.', 500);
  }
});
