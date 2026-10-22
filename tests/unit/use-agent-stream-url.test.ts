/**
 * Sprint 47 — Agent live-feed channel disambiguation
 * Verifies that buildAgentStreamUrl appends channelId when provided.
 */

import { describe, it, expect } from 'vitest';
import { buildAgentStreamUrl } from '../../components/collab/agent-stream/useAgentStream';

describe('buildAgentStreamUrl', () => {
  const base = '/api/agent-stream';

  it('omits channelId when null', () => {
    expect(buildAgentStreamUrl('Builder', null, base)).toBe(
      '/api/agent-stream?agent=Builder',
    );
  });

  it('omits channelId when undefined', () => {
    expect(buildAgentStreamUrl('Jack', undefined, base)).toBe(
      '/api/agent-stream?agent=Jack',
    );
  });

  it('appends channelId when provided', () => {
    expect(buildAgentStreamUrl('Builder', 'abc-123', base)).toBe(
      '/api/agent-stream?agent=Builder&channelId=abc-123',
    );
  });

  it('encodes special characters in agent name', () => {
    expect(buildAgentStreamUrl('Agent One', 'ch-1', base)).toBe(
      '/api/agent-stream?agent=Agent%20One&channelId=ch-1',
    );
  });

  it('encodes special characters in channelId', () => {
    expect(buildAgentStreamUrl('Jack', 'ch id/1', base)).toBe(
      '/api/agent-stream?agent=Jack&channelId=ch%20id%2F1',
    );
  });

  it('uses custom endpoint when provided', () => {
    expect(buildAgentStreamUrl('Teal\'c', 'x1', '/api/custom-stream')).toBe(
      '/api/custom-stream?agent=Teal\'c&channelId=x1',
    );
  });
});
