import path from 'path';

export interface ScaffoldTeam { id: string; projectDir: string; teamDir: string }

const inside = (dir: string, root: string): boolean => {
  const d = path.resolve(dir);
  const r = path.resolve(root);
  return d === r || d.startsWith(r + path.sep);
};

/**
 * The Team folder a new agent's scaffolding is written under, and the team it belongs to.
 *
 * A team's own Team folder is used only when the agent's working directory really is inside that team's project. Before
 * 22 Oct 2026 an agent in another project (Zippo) fell back to team "sg1" and was scaffolded under sg1's Team folder, so its
 * rules and files went to the wrong place and the sync failed. Otherwise the agent lives in <project>/Team/<name>, the
 * folder the spawn code and sync.py use. A folder that already ends in Team is taken as it is.
 */
export function resolveRolloutBase(
  workingDirectory: string,
  teams: readonly ScaffoldTeam[],
  requestedTeamId = '',
): { baseDir: string; teamId: string } {
  const trimmed = workingDirectory.replace(/\/+$/, '');
  let baseDir = path.basename(trimmed) === 'Team' ? trimmed : path.join(trimmed, 'Team');
  const teamId = requestedTeamId || teams.find(t => t.projectDir && inside(trimmed, t.projectDir))?.id || 'sg1';
  const team = teams.find(t => t.id === teamId);
  if (team?.teamDir && team.projectDir && inside(trimmed, team.projectDir)) baseDir = team.teamDir;
  return { baseDir, teamId };
}
