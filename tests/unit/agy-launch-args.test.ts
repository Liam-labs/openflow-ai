/**
 * Arguments for the Antigravity spawn script (lib/agy-launch-args.ts).
 *
 * 19 Oct 2026: `agy models` stopped offering Gemini 3.5 and 3.6 Flash, and `agy --model gemini-3.5-flash` now exits with
 * "model ... is not recognized as a known model". Roster records on those ids are kept working by registry aliases, but only if
 * the launch resolves the model through the registry before it reaches agy-launch.sh.
 */
import { describe, it, expect, vi } from 'vitest';
import { agyLaunchArgs } from '@/lib/agy-launch-args';

// The handler calls agyLaunchArgs without a resolver, so the default must be the registry's own function.
vi.mock('@/lib/model-registry', () => ({ resolveApiIdForModel: (id: string) => `registry:${id}` }));

const base = { launchScript: '/opt/devflow/scripts/agy-launch.sh', name: 'Pierce', channelId: 'chan-1', workDir: '/work/dir', tmuxSession: 'collab-agent-abcd1234' };
const fakeRegistry = (id: string) => ({ 'gemini-3.5-flash': 'gemini-3.8-flash-medium', 'gemini-3.6-flash-high': 'gemini-3.8-flash-high' } as Record<string, string>)[id] ?? id;

describe('agyLaunchArgs', () => {
  it('runs the launch script with the fixed argument order', () => {
    expect(agyLaunchArgs({ ...base, model: 'gemini-3.8-flash-high', effort: 'high' }, fakeRegistry)).toEqual([
      'bash', '/opt/devflow/scripts/agy-launch.sh', '"Pierce"', '"chan-1"', '"/work/dir"', '"collab-agent-abcd1234"', '"gemini-3.8-flash-high"', '"high"',
    ]);
  });

  it('hands agy the successor profile when the roster record holds a retired id', () => {
    expect(agyLaunchArgs({ ...base, model: 'gemini-3.5-flash' }, fakeRegistry)[6]).toBe('"gemini-3.8-flash-medium"');
    expect(agyLaunchArgs({ ...base, model: 'gemini-3.6-flash-high' }, fakeRegistry)[6]).toBe('"gemini-3.8-flash-high"');
  });

  it('uses the model registry by default, which is how the handler calls it', () => {
    expect(agyLaunchArgs({ ...base, model: 'gemini-3.5-flash' })[6]).toBe('"registry:gemini-3.5-flash"');
  });

  it('asks the registry for the model it was given, and only when there is one', () => {
    const resolve = vi.fn((id: string) => `resolved:${id}`);
    expect(agyLaunchArgs({ ...base, model: 'x-model' }, resolve)[6]).toBe('"resolved:x-model"');
    expect(resolve).toHaveBeenCalledWith('x-model');
    resolve.mockClear();
    for (const none of [undefined, null, '']) expect(agyLaunchArgs({ ...base, model: none }, resolve)[6]).toBe('""');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('passes only the efforts agy supports', () => {
    for (const ok of ['low', 'medium', 'high']) expect(agyLaunchArgs({ ...base, effort: ok }, fakeRegistry)[7]).toBe(`"${ok}"`);
    for (const bad of ['xhigh', 'max', 'ultra', '', null, undefined, 'HIGH']) expect(agyLaunchArgs({ ...base, effort: bad }, fakeRegistry)[7]).toBe('""');
  });
});
