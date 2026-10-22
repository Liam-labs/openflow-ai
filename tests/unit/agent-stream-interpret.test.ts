/**
 * Sprint 5 T4 — Live-Feed Interpreter test matrix.
 *
 * Coverage map (spec §11 + Weir tone edge cases):
 *   1.  Per-tool happy path (every registered handler)
 *   2.  Outcome refiners (Read/Grep/Glob/Write/Edit/Bash count + summary)
 *   3.  Family prefix dispatch routing
 *   4a. Bash sub-tool sniffing
 *   4b. Skill sub-dispatch
 *   4c. Orphan tool_result handling (spec §8.5)
 *   5.  Unknown tool fallback (no throw, sensible default)
 *   6.  Malformed input (null/non-object/missing keys → fallback)
 *   7.  Path stripping & utility helpers
 *   8.  Error result handling
 *   9.  Pending state (outcome: null)
 *  10.  Duplicate suppression in interpretStream
 *  11.  Tone resolver — full 6-step path coverage
 *  12.  dispatchTier introspection
 */

import { describe, it, expect } from 'vitest';
import {
  EXACT_HANDLERS,
  FAMILY_HANDLERS,
  basename,
  buildOutcome,
  dispatchTier,
  firstLine,
  formatLineRange,
  interpret,
  interpretStream,
  resolveTone,
  resolveToneTier,
  shortUrl,
  stripUserPath,
  truncate,
  type InterpretedAction,
  type StreamItem,
} from '@/lib/agent-stream-interpret';

// ── Test fixtures ──────────────────────────────────────────────────────

function toolUse(
  name: string,
  input: Record<string, unknown> = {},
  toolUseId = 'toolu_test',
): StreamItem {
  return {
    id: 'item:0',
    kind: 'tool_use',
    role: 'assistant',
    timestamp: '2026-04-22T12:00:00.000Z',
    toolName: name,
    toolInput: input,
    toolUseId,
  };
}

function toolResult(
  toolUseId: string,
  text: string,
  isError = false,
): StreamItem {
  return {
    id: 'item:1',
    kind: 'tool_result',
    role: 'user',
    timestamp: '2026-04-22T12:00:01.000Z',
    toolUseId,
    toolResultText: text,
    toolResultIsError: isError,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Per-tool happy path — every registered handler emits a sane action
// ─────────────────────────────────────────────────────────────────────────

describe('Per-tool happy path — core', () => {
  it('Read', () => {
    const a = interpret(
      toolUse('Read', { file_path: '/home/user/DevFlow/lib/foo.ts', offset: 1, limit: 80 }),
    );
    expect(a.icon).toBe('file-text');
    expect(a.verb).toBe('Read');
    expect(a.subject).toBe('foo.ts');
    expect(a.detail).toBe('L1-81');
    expect(a.tone).toBe('neutral');
    expect(a.toolName).toBe('Read');
  });

  it('Edit', () => {
    const a = interpret(toolUse('Edit', { file_path: '/home/user/x.ts', old_string: 'a', new_string: 'b' }));
    expect(a.icon).toBe('edit-3');
    expect(a.verb).toBe('Edit');
    expect(a.subject).toBe('x.ts');
    expect(a.tone).toBe('mutate');
  });

  it('Edit with replace_all', () => {
    const a = interpret(
      toolUse('Edit', { file_path: '/x.ts', old_string: 'a', new_string: 'b', replace_all: true }),
    );
    expect(a.detail).toBe('replace-all');
  });

  it('Write', () => {
    const a = interpret(toolUse('Write', { file_path: '/home/user/x.ts', content: 'hi' }));
    expect(a.verb).toBe('Write');
    expect(a.tone).toBe('mutate');
    expect(a.subject).toBe('x.ts');
  });

  it('Glob', () => {
    const a = interpret(toolUse('Glob', { pattern: '**/*.ts', path: '/home/user/DevFlow/lib' }));
    expect(a.icon).toBe('folder-search');
    expect(a.verb).toBe('Glob');
    expect(a.subject).toBe('**/*.ts');
    expect(a.detail).toBe('in ~/DevFlow/lib');
  });

  it('Grep', () => {
    const a = interpret(
      toolUse('Grep', { pattern: 'Radio', path: '/home/user/DevFlow/components/' }),
    );
    expect(a.icon).toBe('search');
    expect(a.subject).toBe("'Radio'");
    expect(a.detail).toBe('in ~/DevFlow/components/');
  });

  it('Grep with glob filter', () => {
    const a = interpret(toolUse('Grep', { pattern: 'foo', glob: '*.tsx' }));
    expect(a.detail).toBe('in *.tsx');
  });

  it('ToolSearch', () => {
    const a = interpret(toolUse('ToolSearch', { query: 'select:Read' }));
    expect(a.verb).toBe('ToolSearch');
    expect(a.subject).toBe('select:Read');
    expect(a.tone).toBe('neutral');
  });

  it('Bash (no command)', () => {
    const a = interpret(toolUse('Bash', { command: '' }));
    expect(a.icon).toBe('terminal');
    expect(a.verb).toBe('Bash');
  });

  it('Agent', () => {
    const a = interpret(toolUse('Agent', { description: 'Find tests', subagent_type: 'Explore' }));
    expect(a.icon).toBe('brain');
    expect(a.verb).toBe('Agent');
    expect(a.subject).toBe('Find tests');
    expect(a.detail).toBe('Explore');
    expect(a.tone).toBe('external');
  });

  it('Skill (known)', () => {
    const a = interpret(toolUse('Skill', { skill: 'gitcommit' }));
    expect(a.verb).toBe('Git commit (skill)');
    expect(a.icon).toBe('git-branch');
    expect(a.tone).toBe('mutate');
  });

  it('Skill (unknown)', () => {
    const a = interpret(toolUse('Skill', { skill: 'mystery-skill', args: 'foo' }));
    expect(a.icon).toBe('sparkles');
    expect(a.verb).toBe('Skill: /mystery-skill');
    expect(a.subject).toBe('mystery-skill');
    expect(a.detail).toBe('foo');
    expect(a.tone).toBe('neutral'); // SKILL_CATEGORY default
  });

  it('ScheduleWakeup', () => {
    const a = interpret(toolUse('ScheduleWakeup', { delaySeconds: 600, reason: 'recheck' }));
    expect(a.verb).toBe('Schedule wakeup +600s');
    expect(a.subject).toBe('recheck');
    expect(a.tone).toBe('mutate');
  });
});

describe('Per-tool happy path — deferred built-ins', () => {
  it.each([
    ['EnterPlanMode', 'neutral'],
    ['ExitPlanMode', 'neutral'],
    ['EnterWorktree', 'mutate'],
    ['ExitWorktree', 'mutate'],
    ['CronList', 'neutral'],
    ['Monitor', 'neutral'],
  ])('%s emits action with tone %s', (name, tone) => {
    const a = interpret(toolUse(name));
    expect(a.toolName).toBe(name);
    expect(a.tone).toBe(tone);
  });

  it('TaskCreate', () => {
    const a = interpret(toolUse('TaskCreate', { title: 'Build T4', priority: 'high' }));
    expect(a.icon).toBe('clipboard-list');
    expect(a.verb).toBe('Create task');
    expect(a.subject).toBe('Build T4');
    expect(a.detail).toBe('high');
    expect(a.tone).toBe('mutate');
  });

  it('TaskStop', () => {
    const a = interpret(toolUse('TaskStop', { taskId: 't_1' }));
    expect(a.tone).toBe('danger');
  });

  it('CronCreate', () => {
    const a = interpret(toolUse('CronCreate', { schedule: '0 4 * * *', prompt: '...' }));
    expect(a.subject).toBe('0 4 * * *');
    expect(a.tone).toBe('mutate');
  });

  it('CronDelete', () => {
    const a = interpret(toolUse('CronDelete', { cronId: 'c_1' }));
    expect(a.tone).toBe('danger');
  });

  it('RemoteTrigger', () => {
    const a = interpret(toolUse('RemoteTrigger', {}));
    expect(a.icon).toBe('rocket');
    expect(a.tone).toBe('external');
  });

  it('WebSearch', () => {
    const a = interpret(toolUse('WebSearch', { query: 'opus 4.7' }));
    expect(a.icon).toBe('globe');
    expect(a.tone).toBe('external');
    expect(a.subject).toBe('opus 4.7');
  });

  it('WebFetch', () => {
    const a = interpret(toolUse('WebFetch', { url: 'https://example.com/api/v1/foo/bar' }));
    expect(a.icon).toBe('globe');
    expect(a.subject).toBe('example.com/.../foo/bar');
    expect(a.tone).toBe('external');
  });

  it('AskUserQuestion', () => {
    const a = interpret(toolUse('AskUserQuestion', { question: 'Continue?' }));
    expect(a.icon).toBe('help-circle');
    expect(a.tone).toBe('neutral');
  });

  it('PushNotification', () => {
    const a = interpret(toolUse('PushNotification', { title: 'Build done' }));
    expect(a.icon).toBe('bell');
    expect(a.tone).toBe('external');
  });

  it('NotebookEdit', () => {
    const a = interpret(toolUse('NotebookEdit', { notebook_path: '/home/user/n.ipynb', cell_type: 'code' }));
    expect(a.subject).toBe('n.ipynb');
    expect(a.detail).toBe('code');
    expect(a.tone).toBe('mutate');
  });

  it('ListMcpResourcesTool', () => {
    const a = interpret(toolUse('ListMcpResourcesTool', { server: 'qdrant' }));
    expect(a.icon).toBe('plug');
    expect(a.tone).toBe('neutral');
  });

  it('ReadMcpResourceTool', () => {
    const a = interpret(toolUse('ReadMcpResourceTool', { uri: 'mcp://qdrant/foo' }));
    expect(a.icon).toBe('plug');
  });
});

describe('Per-tool happy path — MCP families', () => {
  it('mcp__github__create_pull_request', () => {
    const a = interpret(
      toolUse('mcp__github__create_pull_request', {
        owner: 'acmemedia',
        repo: 'devflow',
        title: 'Sprint 5: interpreter',
      }),
    );
    expect(a.icon).toBe('git-pull-request');
    expect(a.verb).toBe('GitHub PR create');
    expect(a.subject).toBe('acmemedia/devflow');
    expect(a.detail).toBe('Sprint 5: interpreter');
    expect(a.tone).toBe('external');
  });

  it('mcp__github__merge_pull_request → danger', () => {
    const a = interpret(toolUse('mcp__github__merge_pull_request', { owner: 'a', repo: 'b', pull_number: 42 }));
    expect(a.tone).toBe('danger');
    expect(a.subject).toBe('#42');
  });

  it('mcp__github__delete_file → danger', () => {
    const a = interpret(toolUse('mcp__github__delete_file', { owner: 'a', repo: 'b', path: 'src/x.ts' }));
    expect(a.tone).toBe('danger');
  });

  it('mcp__qdrant__qdrant_find', () => {
    const a = interpret(toolUse('mcp__qdrant__qdrant_find', { query: 'sprint 5' }));
    expect(a.icon).toBe('brain');
    expect(a.verb).toBe('RAG search');
    expect(a.subject).toBe('sprint 5');
    expect(a.tone).toBe('neutral');
  });

  it('mcp__qdrant__qdrant_store → mutate', () => {
    const a = interpret(toolUse('mcp__qdrant__qdrant_store', { content: 'a fact about X' }));
    expect(a.tone).toBe('mutate');
  });

  it('mcp__claude_ai_Supabase__execute_sql → danger', () => {
    const a = interpret(
      toolUse('mcp__claude_ai_Supabase__execute_sql', { project_id: 'p', query: 'SELECT 1' }),
    );
    expect(a.icon).toBe('database');
    expect(a.tone).toBe('danger');
  });

  it('mcp__claude_ai_Supabase__list_tables → external', () => {
    const a = interpret(toolUse('mcp__claude_ai_Supabase__list_tables', { project_id: 'p' }));
    expect(a.tone).toBe('external');
  });

  it('mcp__outlook__send_email → danger', () => {
    const a = interpret(
      toolUse('mcp__outlook__send_email', { to: 'user@example.com', subject: 'Hi' }),
    );
    expect(a.icon).toBe('mail');
    expect(a.tone).toBe('danger');
  });

  it('mcp__outlook__list_emails → external', () => {
    const a = interpret(toolUse('mcp__outlook__list_emails', { folderId: 'inbox' }));
    expect(a.tone).toBe('external');
  });

  it('mcp__outlook__list_events → calendar icon', () => {
    const a = interpret(toolUse('mcp__outlook__list_events', {}));
    expect(a.icon).toBe('calendar');
  });

  it('mcp__outlook__create_rule → settings icon', () => {
    const a = interpret(toolUse('mcp__outlook__create_rule', { displayName: 'Auto-archive' }));
    expect(a.icon).toBe('settings');
  });

  it('mcp__pdf-editor__pdf_read → neutral', () => {
    const a = interpret(toolUse('mcp__pdf-editor__pdf_read', { path: '/tmp/x.pdf' }));
    expect(a.tone).toBe('neutral');
    expect(a.subject).toBe('x.pdf');
  });

  it('mcp__pdf-editor__pdf_add_text → mutate', () => {
    const a = interpret(toolUse('mcp__pdf-editor__pdf_add_text', { path: '/tmp/x.pdf', text: 'hi', page: 1 }));
    expect(a.tone).toBe('mutate');
  });

  it('mcp__snapshot__capture_full_page → external', () => {
    const a = interpret(toolUse('mcp__snapshot__capture_full_page', { url: 'https://example.com/' }));
    expect(a.icon).toBe('image');
    expect(a.tone).toBe('external');
  });

  it('mcp__snapshot__scroll_page → neutral', () => {
    const a = interpret(toolUse('mcp__snapshot__scroll_page', { direction: 'down' }));
    expect(a.tone).toBe('neutral');
  });

  it('mcp__canva__generate-design → external', () => {
    const a = interpret(toolUse('mcp__canva__generate-design', { prompt: 'a poster' }));
    expect(a.icon).toBe('cloud');
    expect(a.tone).toBe('external');
  });

  it('mcp__claude_ai_Gmail__authenticate', () => {
    const a = interpret(toolUse('mcp__claude_ai_Gmail__authenticate', {}));
    expect(a.icon).toBe('mail');
    expect(a.verb).toBe('Gmail: authenticate');
    expect(a.tone).toBe('external');
  });

  it('mcp__claude_ai_Google_Calendar__authenticate', () => {
    const a = interpret(toolUse('mcp__claude_ai_Google_Calendar__authenticate', {}));
    expect(a.icon).toBe('calendar');
  });

  it('mcp__claude_ai_Google_Drive__authenticate', () => {
    const a = interpret(toolUse('mcp__claude_ai_Google_Drive__authenticate', {}));
    expect(a.icon).toBe('cloud');
  });

  it('mcp__n8n-mcp__delete_workflow → danger', () => {
    const a = interpret(toolUse('mcp__n8n-mcp__delete_workflow', { id: 'w1' }));
    expect(a.tone).toBe('danger');
  });

  it('mcp__n8n-mcp__list_workflows → external', () => {
    const a = interpret(toolUse('mcp__n8n-mcp__list_workflows', {}));
    expect(a.tone).toBe('external');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Outcome refiners
// ─────────────────────────────────────────────────────────────────────────

describe('Outcome refiners', () => {
  it('Read counts numbered lines', () => {
    const a = interpret(toolUse('Read', { file_path: '/x.ts' }));
    const text = '   1→hello\n   2→world\n   3→!\n';
    const o = buildOutcome(a, toolResult('toolu_test', text));
    expect(o.ok).toBe(true);
    expect(o.count).toBe(3);
    expect(o.countLabel).toBe('lines');
    expect(o.summary).toBe('✓ 3 lines');
  });

  it('Read with no numbered lines → bare ✓', () => {
    const a = interpret(toolUse('Read', { file_path: '/x.ts' }));
    const o = buildOutcome(a, toolResult('toolu_test', 'plain text'));
    expect(o.summary).toBe('✓');
    expect(o.count).toBeUndefined();
  });

  it('Grep counts matched lines', () => {
    const a = interpret(toolUse('Grep', { pattern: 'foo' }));
    const o = buildOutcome(a, toolResult('toolu_test', 'a.ts\nb.ts\nc.ts'));
    expect(o.count).toBe(3);
    expect(o.countLabel).toBe('matches');
    expect(o.summary).toBe('✓ 3 matches');
  });

  it('Grep with empty result → 0 matches', () => {
    const a = interpret(toolUse('Grep', { pattern: 'foo' }));
    const o = buildOutcome(a, toolResult('toolu_test', ''));
    expect(o.count).toBe(0);
    expect(o.summary).toBe('✓ 0 matches');
  });

  it('Glob counts files', () => {
    const a = interpret(toolUse('Glob', { pattern: '*.ts' }));
    const o = buildOutcome(a, toolResult('toolu_test', 'a.ts\nb.ts'));
    expect(o.count).toBe(2);
    expect(o.countLabel).toBe('files');
  });

  it('Glob "No files found" → 0 files', () => {
    const a = interpret(toolUse('Glob', { pattern: '*.xyz' }));
    const o = buildOutcome(a, toolResult('toolu_test', 'No files found'));
    expect(o.count).toBe(0);
  });

  it('Write success → ✓ written', () => {
    const a = interpret(toolUse('Write', { file_path: '/x.ts', content: 'hi' }));
    const o = buildOutcome(a, toolResult('toolu_test', 'File created'));
    expect(o.summary).toBe('✓ written');
  });

  it('Edit success → ✓ edited', () => {
    const a = interpret(toolUse('Edit', { file_path: '/x.ts', old_string: 'a', new_string: 'b' }));
    const o = buildOutcome(a, toolResult('toolu_test', 'OK'));
    expect(o.summary).toBe('✓ edited');
  });

  it('Bash success → bare ✓', () => {
    const a = interpret(toolUse('Bash', { command: 'ls' }));
    const o = buildOutcome(a, toolResult('toolu_test', 'foo\nbar'));
    expect(o.summary).toBe('✓');
  });

  it('Unknown tool → default summary', () => {
    const a = interpret(toolUse('TaskList', {}));
    const o = buildOutcome(a, toolResult('toolu_test', '[]'));
    expect(o.summary).toBe('✓');
    expect(o.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Family prefix dispatch routing
// ─────────────────────────────────────────────────────────────────────────

describe('Family prefix dispatch', () => {
  it('mcp__github__list_pull_requests → family tier (not fallback)', () => {
    expect(dispatchTier('mcp__github__list_pull_requests')).toBe('family');
  });

  it('mcp__claude_ai_Supabase__list_tables → family', () => {
    expect(dispatchTier('mcp__claude_ai_Supabase__list_tables')).toBe('family');
  });

  it('mcp__outlook__list_emails → family', () => {
    expect(dispatchTier('mcp__outlook__list_emails')).toBe('family');
  });

  it('mcp__pdf-editor__pdf_read → family (hyphenated server)', () => {
    expect(dispatchTier('mcp__pdf-editor__pdf_read')).toBe('family');
  });

  it('mcp__n8n-mcp__list_workflows → family (hyphenated server)', () => {
    expect(dispatchTier('mcp__n8n-mcp__list_workflows')).toBe('family');
  });

  it('mcp__brand-new-server__foo → fallback (no registered family)', () => {
    expect(dispatchTier('mcp__brand-new-server__foo')).toBe('fallback');
  });

  it('Read → exact tier', () => {
    expect(dispatchTier('Read')).toBe('exact');
  });

  it('Bash → bash tier', () => {
    expect(dispatchTier('Bash')).toBe('bash');
  });

  it('UnknownTool → fallback', () => {
    expect(dispatchTier('UnknownTool')).toBe('fallback');
  });

  it('Empty name → fallback', () => {
    expect(dispatchTier('')).toBe('fallback');
  });

  it('Registered family handlers cover the catalogue', () => {
    expect(Object.keys(FAMILY_HANDLERS).sort()).toEqual(
      [
        'canva',
        'claude_ai_Gmail',
        'claude_ai_Google_Calendar',
        'claude_ai_Google_Drive',
        'claude_ai_Supabase',
        'github',
        'n8n-mcp',
        'outlook',
        'pdf-editor',
        'qdrant',
        'snapshot',
      ].sort(),
    );
  });

  it('Registered exact handlers cover spec §9.1 + §9.2', () => {
    const required = [
      'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Agent', 'Skill', 'ToolSearch', 'ScheduleWakeup',
      'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
      'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree',
      'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger',
      'WebSearch', 'WebFetch',
      'AskUserQuestion', 'PushNotification', 'Monitor',
      'ListMcpResourcesTool', 'ReadMcpResourceTool',
      'NotebookEdit',
    ];
    for (const name of required) {
      expect(EXACT_HANDLERS[name], `missing handler: ${name}`).toBeDefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4a. Bash sub-tool sniffing
// ─────────────────────────────────────────────────────────────────────────

describe('Bash sub-tool sniffing', () => {
  it.each([
    ['ls -la', 'wrench', 'ls', 'neutral'],
    ['cat foo.txt', 'wrench', 'cat', 'neutral'], // read-only per BASH_NEUTRAL_TOKENS
    ['rm -rf /tmp/x', 'wrench', 'rm', 'danger'],
    ['mkdir -p out', 'wrench', 'mkdir', 'mutate'],
    ['mv a b', 'wrench', 'mv', 'mutate'], // overwrite-capable but not recursive-destructive
    ['cp a b', 'wrench', 'cp', 'mutate'],
    ['chmod 755 x', 'wrench', 'chmod', 'mutate'],
  ])('%s → icon=%s verb=%s tone=%s', (cmd, icon, verb, tone) => {
    const a = interpret(toolUse('Bash', { command: cmd }));
    expect(a.icon).toBe(icon);
    expect(a.verb).toBe(verb);
    expect(a.tone).toBe(tone);
  });

  it('git status → git-branch + neutral', () => {
    const a = interpret(toolUse('Bash', { command: 'git status' }));
    expect(a.icon).toBe('git-branch');
    expect(a.verb).toBe('git status');
    expect(a.tone).toBe('neutral');
  });

  it('git commit -m "..." → git commit + mutate', () => {
    const a = interpret(toolUse('Bash', { command: 'git commit -m "fix"' }));
    expect(a.verb).toBe('git commit');
    expect(a.tone).toBe('mutate');
  });

  it('git push → external', () => {
    const a = interpret(toolUse('Bash', { command: 'git push origin main' }));
    expect(a.tone).toBe('external');
    expect(a.subject).toBe('origin');
  });

  it('git push --force → DANGER (flag parse)', () => {
    const a = interpret(toolUse('Bash', { command: 'git push --force origin main' }));
    expect(a.tone).toBe('danger');
  });

  it('git push -f → DANGER (short flag)', () => {
    const a = interpret(toolUse('Bash', { command: 'git push -f origin main' }));
    expect(a.tone).toBe('danger');
  });

  it('git reset --hard → danger', () => {
    const a = interpret(toolUse('Bash', { command: 'git reset --hard HEAD~1' }));
    expect(a.tone).toBe('danger');
  });

  it('git checkout -- file.ts → danger', () => {
    const a = interpret(toolUse('Bash', { command: 'git checkout -- file.ts' }));
    expect(a.tone).toBe('danger');
  });

  it('npm run build → package + subject="build"', () => {
    const a = interpret(toolUse('Bash', { command: 'npm run build' }));
    expect(a.icon).toBe('package');
    expect(a.verb).toBe('npm run');
    expect(a.subject).toBe('build');
  });

  it('npm install → mutate', () => {
    const a = interpret(toolUse('Bash', { command: 'npm install foo' }));
    expect(a.tone).toBe('mutate');
  });

  it('pnpm run dev → subject="dev"', () => {
    const a = interpret(toolUse('Bash', { command: 'pnpm run dev' }));
    expect(a.subject).toBe('dev');
    expect(a.verb).toBe('pnpm run');
  });

  it('npx vitest → external dispatcher routing (npx token)', () => {
    const a = interpret(toolUse('Bash', { command: 'npx vitest run' }));
    expect(a.icon).toBe('package');
    expect(a.verb).toBe('npx');
    expect(a.subject).toBe('vitest');
  });

  it('gh pr create → git-pull-request + mutate', () => {
    const a = interpret(toolUse('Bash', { command: 'gh pr create --title foo' }));
    expect(a.icon).toBe('git-pull-request');
    expect(a.tone).toBe('external'); // gh tokens classified external
  });

  it('pm2 restart devflow → package + mutate', () => {
    const a = interpret(toolUse('Bash', { command: 'pm2 restart devflow' }));
    expect(a.icon).toBe('package');
    expect(a.verb).toBe('pm2 restart');
    expect(a.subject).toBe('devflow');
    expect(a.tone).toBe('mutate');
  });

  it('curl -X POST https://api.example.com/v1/foo → external + URL subject', () => {
    const a = interpret(
      toolUse('Bash', { command: "curl -X POST 'https://api.example.com/v1/foo'" }),
    );
    expect(a.icon).toBe('globe');
    expect(a.verb).toBe('curl');
    expect(a.detail).toBe('POST');
    expect(a.tone).toBe('external');
  });

  it('psql mydb → database', () => {
    const a = interpret(toolUse('Bash', { command: 'psql mydb -c "SELECT 1"' }));
    expect(a.icon).toBe('database');
    expect(a.subject).toBe('mydb');
  });

  it('docker ps → cloud + external', () => {
    const a = interpret(toolUse('Bash', { command: 'docker ps' }));
    expect(a.icon).toBe('cloud');
    expect(a.tone).toBe('external');
  });

  it('python3 script.py → terminal + python', () => {
    const a = interpret(toolUse('Bash', { command: 'python3 /home/user/x.py' }));
    expect(a.verb).toBe('python');
    expect(a.subject).toBe('~/x.py');
    expect(a.tone).toBe('mutate');
  });

  it('node x.js → terminal + node', () => {
    const a = interpret(toolUse('Bash', { command: 'node x.js' }));
    expect(a.verb).toBe('node');
    expect(a.subject).toBe('x.js');
  });

  it('tsc --noEmit → terminal', () => {
    const a = interpret(toolUse('Bash', { command: 'tsc --noEmit' }));
    expect(a.verb).toBe('tsc');
  });

  it('vitest run → terminal + neutral', () => {
    const a = interpret(toolUse('Bash', { command: 'vitest run' }));
    expect(a.verb).toBe('vitest');
  });

  it('source ~/.secrets → Load secrets compound', () => {
    const a = interpret(toolUse('Bash', { command: 'source ~/.secrets' }));
    expect(a.verb).toBe('Load secrets');
    expect(a.icon).toBe('shield');
  });

  it('cd-prelude stripped: cd ~/DevFlow && npm run build', () => {
    const a = interpret(toolUse('Bash', { command: 'cd ~/DevFlow && npm run build' }));
    expect(a.verb).toBe('npm run');
    expect(a.subject).toBe('build');
  });

  it('multiple cd-preludes stripped', () => {
    const a = interpret(toolUse('Bash', { command: 'cd /tmp && cd foo && pm2 status' }));
    expect(a.verb).toBe('pm2 status');
  });

  it('env vars stripped: FOO=bar npm run build', () => {
    const a = interpret(toolUse('Bash', { command: 'FOO=bar BAZ=qux npm run build' }));
    expect(a.verb).toBe('npm run');
    expect(a.subject).toBe('build');
  });

  it('sudo stripped: sudo pm2 restart x', () => {
    const a = interpret(toolUse('Bash', { command: 'sudo pm2 restart x' }));
    expect(a.verb).toBe('pm2 restart');
    expect(a.subject).toBe('x');
  });

  it('unknown command → Bash generic', () => {
    const a = interpret(toolUse('Bash', { command: 'someweirdtool --flag' }));
    expect(a.verb).toBe('Bash');
    expect(a.subject).toBe('someweirdtool --flag');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4b. Skill sub-dispatch
// ─────────────────────────────────────────────────────────────────────────

describe('Skill sub-dispatch', () => {
  it.each([
    ['gitcommit', 'mutate'],
    ['security-review', 'neutral'],
    ['cancel-ralph', 'danger'],
    ['ralph-loop', 'mutate'],
    ['claude-api', 'external'],
    ['polish', 'mutate'],
    ['reporter', 'external'],
  ])('%s → tone %s', (skill, tone) => {
    const a = interpret(toolUse('Skill', { skill }));
    expect(a.tone).toBe(tone);
  });

  it('unknown skill defaults to neutral', () => {
    const a = interpret(toolUse('Skill', { skill: 'never-heard-of-it' }));
    expect(a.tone).toBe('neutral');
  });

  it('Skill with empty skill name', () => {
    const a = interpret(toolUse('Skill', { skill: '' }));
    expect(a.verb).toBe('Skill: /unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4c. Orphan tool_result handling (spec §8.5)
// ─────────────────────────────────────────────────────────────────────────

describe('Orphan tool_result handling', () => {
  it('emits non-null minimal action with populated outcome', () => {
    const items = [toolResult('toolu_orphan', 'some output')];
    const out = interpretStream(items);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toBeNull();
    const a = out[0]!;
    expect(a.verb).toBe('result');
    expect(a.detail).toBe('(orphan — no matching tool_use)');
    expect(a.toolName).toBe('');
    expect(a.toolUseId).toBe('toolu_orphan');
    expect(a.outcome).not.toBeNull();
    expect(a.outcome!.ok).toBe(true);
    expect(a.tone).toBe('neutral');
  });

  it('orphan with error → tone=danger and outcome.ok=false', () => {
    const items = [toolResult('toolu_err', 'ENOENT', true)];
    const out = interpretStream(items);
    const a = out[0]!;
    expect(a.tone).toBe('danger');
    expect(a.outcome!.ok).toBe(false);
    expect(a.outcome!.summary).toContain('✗');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Unknown tool fallback
// ─────────────────────────────────────────────────────────────────────────

describe('Unknown tool fallback', () => {
  it('unknown tool name → wrench + verb=name + neutral', () => {
    const a = interpret(toolUse('SomeBrandNewTool', { foo: 'bar' }));
    expect(a.icon).toBe('wrench');
    expect(a.verb).toBe('SomeBrandNewTool');
    expect(a.tone).toBe('neutral');
    expect(a.toolName).toBe('SomeBrandNewTool');
  });

  it('unknown MCP family → plug + server name visible + external default', () => {
    const a = interpret(
      toolUse('mcp__brand-new__do_thing', { x: 1 }),
    );
    expect(a.icon).toBe('plug');
    expect(a.verb).toContain('brand-new');
    expect(a.verb).toContain('do thing');
    expect(a.tone).toBe('external'); // §10d
  });

  it('unknown MCP with delete keyword → danger', () => {
    const a = interpret(toolUse('mcp__brand-new__delete_thing', {}));
    expect(a.tone).toBe('danger');
  });

  it('unknown MCP with create keyword → external', () => {
    const a = interpret(toolUse('mcp__brand-new__create_thing', {}));
    expect(a.tone).toBe('external');
  });

  it('fallback never throws on bizarre tool names', () => {
    expect(() => interpret(toolUse(';;;;', {}))).not.toThrow();
    expect(() => interpret(toolUse('mcp__', {}))).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Malformed input
// ─────────────────────────────────────────────────────────────────────────

describe('Malformed input', () => {
  it('toolInput undefined', () => {
    const item: StreamItem = {
      id: 'x', kind: 'tool_use', role: 'assistant', timestamp: '',
      toolName: 'Read', toolUseId: 't',
    };
    expect(() => interpret(item)).not.toThrow();
  });

  it('toolName missing → fallback', () => {
    const item: StreamItem = {
      id: 'x', kind: 'tool_use', role: 'assistant', timestamp: '',
      toolInput: {}, toolUseId: 't',
    };
    const a = interpret(item);
    expect(a.toolName).toBe('');
    expect(a.tone).toBe('neutral');
  });

  it('Read with non-string file_path', () => {
    const a = interpret(toolUse('Read', { file_path: 42 as unknown as string }));
    expect(a.subject).toBe('');
  });

  it('Bash with non-string command', () => {
    const a = interpret(toolUse('Bash', { command: null as unknown as string }));
    expect(a.verb).toBe('Bash');
  });

  it('GitHub family with no owner/repo', () => {
    const a = interpret(toolUse('mcp__github__create_pull_request', {}));
    expect(a.subject).toBe('');
    expect(() => a.verb).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Path stripping & utility helpers
// ─────────────────────────────────────────────────────────────────────────

describe('Utility helpers', () => {
  describe('stripUserPath', () => {
    it.each([
      ['/home/user/DevFlow/x.ts', '~/DevFlow/x.ts'],
      ['/home/user/SG-1/SG-2/foo', '~/SG-1/SG-2/foo'],
      ['/etc/systemd/system.conf', '/etc/systemd/system.conf'],
      ['~/already', '~/already'],
      ['', ''],
    ])('%s → %s', (input, expected) => {
      expect(stripUserPath(input)).toBe(expected);
    });

    it('non-string → ""', () => {
      expect(stripUserPath(42 as unknown as string)).toBe('');
    });
  });

  describe('basename', () => {
    it.each([
      ['/a/b/c.ts', 'c.ts'],
      ['/a/b/', 'b'],
      ['c.ts', 'c.ts'],
      ['', ''],
    ])('%s → %s', (input, expected) => {
      expect(basename(input)).toBe(expected);
    });
  });

  describe('formatLineRange', () => {
    it('offset + limit', () => {
      expect(formatLineRange({ offset: 1, limit: 80 })).toBe('L1-81');
    });
    it('offset only', () => {
      expect(formatLineRange({ offset: 5 })).toBe('L5+');
    });
    it('limit only', () => {
      expect(formatLineRange({ limit: 10 })).toBe('L0-10');
    });
    it('neither → null', () => {
      expect(formatLineRange({})).toBeNull();
    });
  });

  describe('shortUrl', () => {
    it('long URL → host + last 2 segments', () => {
      expect(shortUrl('https://api.github.com/repos/foo/bar/pulls/123')).toBe(
        'api.github.com/.../pulls/123',
      );
    });
    it('short URL → host + path', () => {
      expect(shortUrl('https://example.com/foo')).toBe('example.com/foo');
    });
    it('malformed → truncated', () => {
      expect(shortUrl('not a url')).toBe('not a url');
    });
  });

  describe('truncate', () => {
    it('short string passes through', () => {
      expect(truncate('hello', 80)).toBe('hello');
    });
    it('long string ellipsised', () => {
      expect(truncate('a'.repeat(100), 10)).toBe('aaaaaaaaa…');
    });
  });

  describe('firstLine', () => {
    it('trims and returns first non-empty', () => {
      expect(firstLine('\n\n  hello\nworld\n')).toBe('hello');
    });
    it('empty → ""', () => {
      expect(firstLine('')).toBe('');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. Error result handling
// ─────────────────────────────────────────────────────────────────────────

describe('Error result handling', () => {
  it('Read error → outcome.ok=false + ✗ summary', () => {
    const a = interpret(toolUse('Read', { file_path: '/x' }));
    const o = buildOutcome(a, toolResult('toolu_test', 'ENOENT: no such file', true));
    expect(o.ok).toBe(false);
    expect(o.summary).toMatch(/^✗/);
    expect(o.summary).toContain('ENOENT');
  });

  it('Bash error → first stderr line in summary', () => {
    const a = interpret(toolUse('Bash', { command: 'false' }));
    const o = buildOutcome(a, toolResult('toolu_test', 'permission denied\nmore detail', true));
    expect(o.summary).toContain('permission denied');
  });

  it('Generic tool error → first line in summary', () => {
    const a = interpret(toolUse('TaskList'));
    const o = buildOutcome(a, toolResult('toolu_test', 'Server unavailable', true));
    expect(o.ok).toBe(false);
    expect(o.summary).toContain('Server unavailable');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9. Pending state
// ─────────────────────────────────────────────────────────────────────────

describe('Pending state', () => {
  it('no result → outcome === null', () => {
    const a = interpret(toolUse('Read', { file_path: '/x' }));
    expect(a.outcome).toBeNull();
  });

  it('null result → outcome === null', () => {
    const a = interpret(toolUse('Read', { file_path: '/x' }), null);
    expect(a.outcome).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10. Duplicate suppression in interpretStream
// ─────────────────────────────────────────────────────────────────────────

describe('interpretStream duplicate suppression', () => {
  it('tool_use + matching tool_result → [action, null]', () => {
    const items = [
      toolUse('Read', { file_path: '/x' }, 'toolu_abc'),
      toolResult('toolu_abc', '   1→hi'),
    ];
    const out = interpretStream(items);
    expect(out).toHaveLength(2);
    expect(out[0]).not.toBeNull();
    expect(out[0]!.verb).toBe('Read');
    expect(out[0]!.outcome).not.toBeNull();
    expect(out[1]).toBeNull(); // merged result is null
  });

  it('multiple tool_use + interleaved results pair correctly', () => {
    const items = [
      toolUse('Read', { file_path: '/a' }, 'toolu_1'),
      toolUse('Bash', { command: 'ls' }, 'toolu_2'),
      toolResult('toolu_1', '   1→a'),
      toolResult('toolu_2', 'a\nb'),
    ];
    const out = interpretStream(items);
    expect(out[0]!.verb).toBe('Read');
    expect(out[1]!.verb).toBe('ls');
    expect(out[2]).toBeNull();
    expect(out[3]).toBeNull();
  });

  it('non-tool items pass through as null', () => {
    const items: StreamItem[] = [
      { id: 't1', kind: 'text', role: 'assistant', timestamp: '', text: 'hello' },
      toolUse('Read', { file_path: '/x' }, 'toolu_1'),
    ];
    const out = interpretStream(items);
    expect(out[0]).toBeNull();
    expect(out[1]).not.toBeNull();
  });

  it('tool_use without paired result → outcome remains null', () => {
    const items = [toolUse('Read', { file_path: '/x' }, 'toolu_lonely')];
    const out = interpretStream(items);
    expect(out[0]!.outcome).toBeNull();
  });

  it('non-array input → []', () => {
    expect(interpretStream(null as unknown as StreamItem[])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 11. Tone resolver — explicit 6-step path coverage
// ─────────────────────────────────────────────────────────────────────────

describe('resolveTone — 6-step resolution', () => {
  describe('Tier 1: explicit', () => {
    it.each([
      ['Read', 'neutral'],
      ['Edit', 'mutate'],
      ['Write', 'mutate'],
      ['Agent', 'external'],
      ['TaskStop', 'danger'],
      ['CronDelete', 'danger'],
      ['WebFetch', 'external'],
      ['WebSearch', 'external'],
    ])('%s → %s', (name, tone) => {
      expect(resolveTone(name)).toBe(tone);
      expect(resolveToneTier(name)).toBe('explicit');
    });
  });

  describe('Tier 2: MCP family pattern', () => {
    it.each([
      ['mcp__github__create_pull_request', 'external'],
      ['mcp__github__merge_pull_request', 'danger'],
      ['mcp__github__delete_file', 'danger'],
      ['mcp__outlook__send_email', 'danger'],
      ['mcp__outlook__list_emails', 'external'],
      ['mcp__outlook__delete_event', 'danger'],
      ['mcp__claude_ai_Supabase__execute_sql', 'danger'],
      ['mcp__claude_ai_Supabase__list_tables', 'external'],
      ['mcp__qdrant__qdrant_find', 'neutral'],
      ['mcp__qdrant__qdrant_store', 'mutate'],
      ['mcp__snapshot__capture_full_page', 'external'],
      ['mcp__snapshot__scroll_page', 'neutral'],
      ['mcp__pdf-editor__pdf_read', 'neutral'],
      ['mcp__pdf-editor__pdf_add_text', 'mutate'],
      ['mcp__n8n-mcp__delete_workflow', 'danger'],
    ])('%s → %s', (name, tone) => {
      expect(resolveTone(name)).toBe(tone);
      expect(resolveToneTier(name)).toBe('family');
    });
  });

  describe('Tier 3: Bash flags', () => {
    it('git push → external', () => {
      expect(resolveTone('Bash', { command: 'git push origin main' })).toBe('external');
    });
    it('git push --force → danger (flag override)', () => {
      expect(resolveTone('Bash', { command: 'git push --force' })).toBe('danger');
    });
    it('rm → danger', () => {
      expect(resolveTone('Bash', { command: 'rm -rf /tmp/x' })).toBe('danger');
    });
    it('curl → external', () => {
      expect(resolveTone('Bash', { command: 'curl https://example.com' })).toBe('external');
    });
    it('git status → neutral', () => {
      expect(resolveTone('Bash', { command: 'git status' })).toBe('neutral');
    });
    it('npm install → mutate', () => {
      expect(resolveTone('Bash', { command: 'npm install' })).toBe('mutate');
    });
    it('Bash empty → neutral', () => {
      expect(resolveTone('Bash', { command: '' })).toBe('neutral');
    });
  });

  describe('Tier 4: Skill category', () => {
    it.each([
      ['gitcommit', 'mutate'],
      ['security-review', 'neutral'],
      ['cancel-ralph', 'danger'],
      ['claude-api', 'external'],
    ])('Skill /%s → %s', (skill, tone) => {
      expect(resolveTone('Skill', { skill })).toBe(tone);
      expect(resolveToneTier('Skill')).toBe('skill');
    });
    it('unknown skill → neutral default', () => {
      expect(resolveTone('Skill', { skill: 'never-heard' })).toBe('neutral');
    });
  });

  describe('Tier 5: MCP unknown-family keyword sniff', () => {
    it.each([
      ['mcp__brand__delete_thing', 'danger'],
      ['mcp__brand__purge_data', 'danger'],
      ['mcp__brand__cancel_op', 'danger'],
      ['mcp__brand__create_thing', 'external'],
      ['mcp__brand__send_message', 'external'],
      ['mcp__brand__random_op', 'external'],
    ])('%s → %s', (name, tone) => {
      expect(resolveTone(name)).toBe(tone);
      expect(resolveToneTier(name)).toBe('mcp-fallback');
    });

    it('REGRESSION: list_updates (noun form) does NOT trigger update verb match', () => {
      // The trailing `s` extends past `update`, so the verb-form keyword
      // sniff must not catch it. Falls through to §10d external default.
      expect(resolveTone('mcp__brand__list_updates')).toBe('external');
    });

    it('REGRESSION: list_deletes (noun form) does NOT trigger delete verb match', () => {
      expect(resolveTone('mcp__brand__list_deletes')).toBe('external');
    });

    it('verb form delete_lists DOES trigger danger', () => {
      expect(resolveTone('mcp__brand__delete_lists')).toBe('danger');
    });
  });

  describe('Tier 3 regressions: bash normalization parity with handler', () => {
    it('cd-prelude + git push --force → danger (was mutate before T4 fix)', () => {
      expect(resolveTone('Bash', { command: 'cd ~/DevFlow && git push --force origin main' })).toBe('danger');
    });

    it('sudo + rm -rf → danger (was mutate before T4 fix)', () => {
      expect(resolveTone('Bash', { command: 'sudo rm -rf /tmp/foo' })).toBe('danger');
    });

    it('env-var prefix + git reset --hard → danger (was mutate before T4 fix)', () => {
      expect(resolveTone('Bash', { command: 'FOO=bar git reset --hard HEAD~1' })).toBe('danger');
    });

    it('env + git push --force → danger', () => {
      expect(resolveTone('Bash', { command: 'env X=y git push --force' })).toBe('danger');
    });

    it('docker rm → danger (resolver-level promotion)', () => {
      expect(resolveTone('Bash', { command: 'docker rm container1' })).toBe('danger');
    });

    it('docker stop → danger', () => {
      expect(resolveTone('Bash', { command: 'docker stop x' })).toBe('danger');
    });

    it('docker rmi → danger', () => {
      expect(resolveTone('Bash', { command: 'docker rmi image:tag' })).toBe('danger');
    });

    it('docker ps → external (read-only)', () => {
      expect(resolveTone('Bash', { command: 'docker ps' })).toBe('external');
    });
  });

  describe('Tier 6: default neutral', () => {
    it('unknown core tool → neutral', () => {
      expect(resolveTone('SomeBrandNewTool')).toBe('neutral');
      expect(resolveToneTier('SomeBrandNewTool')).toBe('default');
    });
    it('empty name → neutral', () => {
      expect(resolveTone('')).toBe('neutral');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 12. Determinism — identical inputs produce deep-equal output
// ─────────────────────────────────────────────────────────────────────────

describe('Determinism', () => {
  it('interpret is deterministic', () => {
    const item = toolUse('Read', { file_path: '/x.ts', offset: 1, limit: 5 });
    const a1 = interpret(item);
    const a2 = interpret(item);
    expect(a1).toEqual(a2);
  });

  it('interpretStream is deterministic', () => {
    const items = [
      toolUse('Read', { file_path: '/a' }, 'toolu_1'),
      toolResult('toolu_1', '   1→a'),
    ];
    expect(interpretStream(items)).toEqual(interpretStream(items));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 13. Sanity: the spec's worked examples (§10.1, 10.2, 10.3, 10.4)
// ─────────────────────────────────────────────────────────────────────────

describe('Spec worked examples', () => {
  it('§10.1 Read', () => {
    const item = toolUse(
      'Read',
      {
        file_path: '/home/user/DevFlow/components/collab/agent-stream/AgentStreamDrawer.tsx',
        offset: 1,
        limit: 80,
      },
      'toolu_abc123',
    );
    const a = interpret(item, toolResult('toolu_abc123', '   1→x\n   2→y'));
    expect(a.icon).toBe('file-text');
    expect(a.verb).toBe('Read');
    expect(a.subject).toBe('AgentStreamDrawer.tsx');
    expect(a.detail).toBe('L1-81');
    expect(a.tone).toBe('neutral');
    expect(a.outcome?.ok).toBe(true);
    expect(a.outcome?.count).toBe(2);
    expect(a.outcome?.countLabel).toBe('lines');
  });

  it('§10.3 GitHub PR create', () => {
    const a = interpret(
      toolUse('mcp__github__create_pull_request', {
        owner: 'acmemedia',
        repo: 'devflow',
        title: 'Sprint 5: Live feed interpreter',
        head: 'sprint-5',
        base: 'main',
      }),
    );
    expect(a.icon).toBe('git-pull-request');
    expect(a.verb).toBe('GitHub PR create');
    expect(a.subject).toBe('acmemedia/devflow');
    expect(a.detail).toBe('Sprint 5: Live feed interpreter');
    expect(a.tone).toBe('external');
  });

  it('§10.4 Bash cd-prelude → npm run build', () => {
    const a = interpret(toolUse('Bash', { command: 'cd ~/DevFlow && npm run build' }));
    expect(a.icon).toBe('package');
    expect(a.verb).toBe('npm run');
    expect(a.subject).toBe('build');
  });

  it('Action shape: every required field is set', () => {
    const a: InterpretedAction = interpret(toolUse('Read', { file_path: '/x.ts' }));
    expect(typeof a.icon).toBe('string');
    expect(typeof a.verb).toBe('string');
    expect(typeof a.subject).toBe('string');
    expect(typeof a.detail).toBe('string');
    expect(typeof a.tone).toBe('string');
    expect(typeof a.toolName).toBe('string');
    expect(typeof a.toolUseId).toBe('string');
  });
});
