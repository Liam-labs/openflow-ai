import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const DEVFLOW = REPO;
const INIT = `${DEVFLOW}/scripts/hooks/session-scratch-init.sh`;
const LEGACY_STOP = `${DEVFLOW}/scripts/write-session-end.sh`;
const CHECK_ROTATE = `${DEVFLOW}/scripts/check-rotate.sh`;
const PRE_COMPACT = `${DEVFLOW}/scripts/hooks/pre-compact-write.sh`;
const POST_COMPACT = `${DEVFLOW}/scripts/hooks/post-compact-reinject.sh`;

function run(script: string, args: string[], home: string): string {
  return execFileSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('lifecycle hooks do not turn ordinary completion into another task', () => {
  let root: string;
  let home: string;
  let agentDir: string;
  let logsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lifecycle-policy-'));
    home = join(root, 'home');
    agentDir = join(root, 'Team', 'TestAgent');
    logsDir = join(agentDir, 'logs');
    mkdirSync(home, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    run(INIT, ['TestAgent', agentDir], home);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('two normal Stop turns add no markers and preserve a richer handoff byte-for-byte', () => {
    const today = join(logsDir, 'today.md');
    const handoff = join(logsDir, 'handoff.md');
    const todayBody = '# Today — 2026-08-31\n\n## 09:00 — real work\n- result\n';
    const handoffBody = [
      'STATUS: implementation in progress',
      'PENDING: finish targeted regression',
      'DO_NOT_REPEAT: old failing attempt',
      'BLOCKERS: none',
      '',
    ].join('\n');
    writeFileSync(today, todayBody);
    writeFileSync(handoff, handoffBody);

    run(LEGACY_STOP, ['TestAgent', agentDir], home);
    run(LEGACY_STOP, ['TestAgent', agentDir], home);

    expect(readFileSync(today, 'utf8')).toBe(todayBody);
    expect(readFileSync(handoff, 'utf8')).toBe(handoffBody);
    expect(readFileSync(today, 'utf8')).not.toMatch(/Session turn ended|MISSING LOG/);
  });

  it('legacy missing-log text never causes a next-turn nag', () => {
    const today = join(logsDir, 'today.md');
    const currentDate = execFileSync('date', ['+%F'], { encoding: 'utf8' }).trim();
    const legacyBody = [
      `# Today — ${currentDate}`,
      '',
      '## 09:00 — Session turn ended',
      '⚠️ MISSING LOG — not written this turn.',
      '',
    ].join('\n');
    writeFileSync(today, legacyBody);

    const stdout = run(CHECK_ROTATE, ['TestAgent', agentDir], home);

    expect(stdout).toBe('');
    expect(readFileSync(today, 'utf8')).toBe(legacyBody);
  });

  it('PreCompact flushes fresh journal state but preserves a specific handoff byte-for-byte', () => {
    const journal = join(agentDir, '.session-scratch', 'journal.md');
    const handoff = join(logsDir, 'handoff.md');
    writeFileSync(journal, '## 10:00 — buffered before compact\n- durable result\n');
    const handoffBody = 'STATUS: older snapshot\nPENDING: preserve exactly\nDO_NOT_REPEAT: prior route\n';
    writeFileSync(handoff, handoffBody);

    run(PRE_COMPACT, ['TestAgent', agentDir], home);

    expect(readFileSync(journal, 'utf8')).toBe('');
    expect(readFileSync(join(logsDir, 'today.md'), 'utf8')).toContain('buffered before compact');
    expect(readFileSync(handoff, 'utf8')).toBe(handoffBody);
    expect(readdirSync(logsDir).filter((name) => name.includes('handoff.md.tmp.'))).toEqual([]);
  });

  it('PreCompact creates only the minimal four-field handoff when none exists', () => {
    run(PRE_COMPACT, ['TestAgent', agentDir], home);

    const lines = readFileSync(join(logsDir, 'handoff.md'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^STATUS: Pre-compaction boundary at /);
    expect(lines[1]).toMatch(/^LAST_ACTED: /);
    expect(lines[2]).toBe('PENDING: none');
    expect(lines[3]).toBe('DO_NOT_REPEAT: none');
  });

  it('PostCompact reinjects concise identity and existing handoff without mandatory recovery work', () => {
    const rules = join(agentDir, '.claude', 'rules');
    mkdirSync(rules, { recursive: true });
    const canonicalPersonality = join(agentDir, 'canonical-personality.md');
    const canonicalDirectives = join(agentDir, 'canonical-directives.md');
    writeFileSync(canonicalPersonality, 'Identity line\n');
    writeFileSync(canonicalDirectives, 'Role boundary\n');
    writeFileSync(join(rules, 'Personality.md'), `@${canonicalPersonality}\n`);
    writeFileSync(join(rules, 'Directives.md'), `@${canonicalDirectives}\n`);
    writeFileSync(join(logsDir, 'handoff.md'), 'STATUS: resume exact task\nPENDING: focused test\n');

    const stdout = run(POST_COMPACT, [agentDir], home);

    expect(stdout).toContain('Identity line');
    expect(stdout).toContain('Role boundary');
    expect(stdout).not.toContain(`@${canonicalDirectives}`);
    expect(stdout).toContain('STATUS: resume exact task');
    expect(stdout).toContain('Resume the assigned outcome');
    expect(stdout).not.toMatch(/Before doing anything else|STRUCTURED SUMMARY|Read logs\/today\.md/);
  });
});
