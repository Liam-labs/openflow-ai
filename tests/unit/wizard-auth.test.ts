import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ session: vi.fn(), strict: vi.fn() }));
vi.mock('@/lib/dashboard-auth', () => ({ requestHasSession: mocks.session }));
vi.mock('@/lib/api-auth', () => ({ requireTokenOrLocal: mocks.strict }));
import { requireWizardAccess } from '@/lib/wizards/auth';
const req = new NextRequest('https://test.my.openflow-ai.com/api/wizards/cloudflare', { method: 'POST' });
beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue(false); mocks.strict.mockResolvedValue(Response.json({ error: 'Authentication required' }, { status: 401 })); });
describe('wizard owner access', () => {
 it('accepts a verified owner session without weakening the strict global guard', async () => {
  mocks.session.mockResolvedValue(true); expect(await requireWizardAccess(req)).toBeNull(); expect(mocks.strict).not.toHaveBeenCalled();
 });
 it('rejects missing, expired or cross-origin sessions through the existing session validator', async () => {
  expect((await requireWizardAccess(req))?.status).toBe(401); expect(mocks.session).toHaveBeenCalledWith(req); expect(mocks.strict).toHaveBeenCalledWith(req, 'admin');
 });
 it('preserves admin token access when there is no owner session', async () => {
  mocks.strict.mockResolvedValue(null); expect(await requireWizardAccess(req)).toBeNull(); expect(mocks.strict).toHaveBeenCalledWith(req, 'admin');
 });
 it('preserves insufficient scope and rate-limit refusal', async () => {
  for (const status of [403, 429]) { mocks.strict.mockResolvedValue(new Response(null, { status })); expect((await requireWizardAccess(req))?.status).toBe(status); }
 });
});
