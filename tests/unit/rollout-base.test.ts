import { describe, it, expect } from 'vitest';
import { resolveRolloutBase } from '@/lib/rollout-base';

const teams = [
  { id: 'sg1', projectDir: '/home/u/SG-1', teamDir: '/home/u/SG-1/Team' },
  { id: 'devflow', projectDir: '/home/u/DevFlow', teamDir: '/home/u/DevFlow/Team' },
];

describe('resolveRolloutBase', () => {
  it('uses the team folder of the project the agent is in', () => {
    expect(resolveRolloutBase('/home/u/SG-1', teams)).toEqual({ baseDir: '/home/u/SG-1/Team', teamId: 'sg1' });
    expect(resolveRolloutBase('/home/u/DevFlow/', teams)).toEqual({ baseDir: '/home/u/DevFlow/Team', teamId: 'devflow' });
    expect(resolveRolloutBase('/home/u/DevFlow/Team', teams)).toEqual({ baseDir: '/home/u/DevFlow/Team', teamId: 'devflow' });
  });

  it('puts an agent of another project in <project>/Team, not in the default team\'s folder', () => {
    expect(resolveRolloutBase('/home/u/Zippo', teams)).toEqual({ baseDir: '/home/u/Zippo/Team', teamId: 'sg1' });
    expect(resolveRolloutBase('/home/u/Zippo/Team', teams)).toEqual({ baseDir: '/home/u/Zippo/Team', teamId: 'sg1' });
  });

  it('matches a project by folder boundary: SG-1-other is not inside SG-1', () => {
    expect(resolveRolloutBase('/home/u/SG-1-other', teams)).toEqual({ baseDir: '/home/u/SG-1-other/Team', teamId: 'sg1' });
  });

  it('keeps a requested team id, but still writes into the agent\'s own project when it is outside that team', () => {
    expect(resolveRolloutBase('/home/u/Zippo', teams, 'devflow')).toEqual({ baseDir: '/home/u/Zippo/Team', teamId: 'devflow' });
    expect(resolveRolloutBase('/home/u/DevFlow', teams, 'devflow')).toEqual({ baseDir: '/home/u/DevFlow/Team', teamId: 'devflow' });
  });

  it('works with no teams at all, and ignores a team record with no folders', () => {
    expect(resolveRolloutBase('/home/u/Zippo', [])).toEqual({ baseDir: '/home/u/Zippo/Team', teamId: 'sg1' });
    expect(resolveRolloutBase('/home/u/Zippo', [{ id: 'x', projectDir: '', teamDir: '' }])).toEqual({ baseDir: '/home/u/Zippo/Team', teamId: 'sg1' });
  });
});
