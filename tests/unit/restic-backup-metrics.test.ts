import { describe, expect, it } from 'vitest';
import { resolveResticRepoStats } from '@/lib/restic-backup-metrics';

describe('resolveResticRepoStats', () => {
  it('uses the last measured repository size when live stats time out', () => {
    expect(resolveResticRepoStats(null, 44_570_174_007)).toEqual({
      totalSize: 44_570_174_007,
      totalSizeGB: 41.51,
      source: 'cached',
    });
  });

  it('prefers a live measurement when it is available', () => {
    expect(resolveResticRepoStats({ totalSize: 1024, totalSizeGB: 0.01 }, 44_570_174_007)).toEqual({
      totalSize: 1024,
      totalSizeGB: 0.01,
      source: 'live',
    });
  });

  it('does not turn an unavailable measurement into a false zero', () => {
    expect(resolveResticRepoStats(null, 0)).toBeNull();
  });
});
