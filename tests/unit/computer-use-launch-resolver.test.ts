/**
 * Unit tests for the launch error mapper (audit task 7f854785).
 *
 * Daniel's research lives in the bridge (Python) — this side just forwards
 * the request and translates bridge response codes into the typed taxonomy.
 *
 * Acceptance:
 *   - 'notepad' / 'outlook.exe' / full paths all reach the bridge unchanged
 *   - bridge LAUNCH_NOT_FOUND → COMPUTER_USE_LAUNCH_NOT_FOUND (404) with `tried`
 *   - bridge LAUNCH_UWP_NO_ARGS → COMPUTER_USE_LAUNCH_UWP_NO_ARGS (400)
 *   - resolved path + source surfaced on success
 */

import { describe, it, expect } from 'vitest';
import { mapLaunchBridgeError, type LaunchBridgePayload } from '@/app/api/agent/actions/computer-use';

describe('mapLaunchBridgeError', () => {
  it('maps LAUNCH_NOT_FOUND → COMPUTER_USE_LAUNCH_NOT_FOUND (404)', () => {
    const result = mapLaunchBridgeError({
      success: false,
      code: 'LAUNCH_NOT_FOUND',
      tried: [['absolute', 'foo'], ['PATH', 'foo']],
      detail: 'Could not resolve foo',
    });
    expect(result.code).toBe('COMPUTER_USE_LAUNCH_NOT_FOUND');
    expect(result.context?.action).toBe('computer-use.launch');
    expect(result.context?.bridgeDetail).toContain('Could not resolve foo');
  });

  it('maps LAUNCH_UWP_NO_ARGS → COMPUTER_USE_LAUNCH_UWP_NO_ARGS (400)', () => {
    const result = mapLaunchBridgeError({
      success: false,
      code: 'LAUNCH_UWP_NO_ARGS',
      detail: 'UWP apps cannot receive arguments',
    });
    expect(result.code).toBe('COMPUTER_USE_LAUNCH_UWP_NO_ARGS');
  });

  it('falls back to COMPUTER_USE_BRIDGE_ERROR for unrecognised bridge codes', () => {
    const result = mapLaunchBridgeError({
      success: false,
      code: 'WHO_KNOWS',
      detail: 'something else broke',
    });
    expect(result.code).toBe('COMPUTER_USE_BRIDGE_ERROR');
  });

  it('handles missing code field with bridge-error fallback', () => {
    const result = mapLaunchBridgeError({ success: false, detail: 'no code' });
    expect(result.code).toBe('COMPUTER_USE_BRIDGE_ERROR');
  });

  it('preserves the tried array via context.bridgeDetail when present', () => {
    const result = mapLaunchBridgeError({
      success: false,
      code: 'LAUNCH_NOT_FOUND',
      tried: [['absolute', 'mything'], ['HKCU\\AppPaths[64]', 'mything.exe']],
      detail: 'Could not resolve mything',
    });
    expect(result.context?.bridgeDetail).toBeDefined();
    // Encoded compactly so it stays readable in error logs
    expect(result.context?.bridgeDetail).toContain('absolute');
    expect(result.context?.bridgeDetail).toContain('HKCU');
  });

  it('populates context.action on every mapping', () => {
    for (const code of ['LAUNCH_NOT_FOUND', 'LAUNCH_UWP_NO_ARGS', 'OTHER']) {
      const r = mapLaunchBridgeError({ success: false, code });
      expect(r.context?.action).toBe('computer-use.launch');
    }
  });

  it('extracts message from data.detail then data.error then statusText', () => {
    expect(mapLaunchBridgeError({ success: false, code: 'LAUNCH_NOT_FOUND', detail: 'detail-msg' }).message)
      .toBe('detail-msg');
    expect(mapLaunchBridgeError({ success: false, code: 'LAUNCH_NOT_FOUND', error: 'error-msg' }).message)
      .toBe('error-msg');
    expect(mapLaunchBridgeError({ success: false, code: 'LAUNCH_NOT_FOUND' }).message)
      .toBe('launch failed');
  });

  it('typing: payload type is exposed for callers', () => {
    const payload: LaunchBridgePayload = {
      success: false,
      code: 'LAUNCH_NOT_FOUND',
      tried: [],
    };
    expect(mapLaunchBridgeError(payload).code).toBe('COMPUTER_USE_LAUNCH_NOT_FOUND');
  });
});
