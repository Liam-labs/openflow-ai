import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeAgentStreamLine,
  resolveAgentStreamSource,
} from '@/lib/agent-stream-runtime';
import type { AgentRosterEntry } from '@/lib/types';

function makeAgent(
  agentType: NonNullable<AgentRosterEntry['agentType']>,
  workingDirectory: string,
): AgentRosterEntry {
  return {
    id: `roster-${agentType}`,
    name: 'RuntimeTest',
    workingDirectory,
    effectiveWorkingDirectory: workingDirectory,
    channelId: 'channel-runtime',
    participantId: 'participant-runtime',
    color: '#fff',
    status: 'running',
    autoResume: false,
    useCollabWrapper: true,
    dangerouslySkipPermissions: false,
    createdAt: '2026-07-18T00:00:00Z',
    crashCount: 0,
    agentType,
  };
}

describe('resolveAgentStreamSource', () => {
  let sandbox: string;
  let home: string;
  let agentDir: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'agent-stream-runtime-'));
    home = join(sandbox, 'home');
    agentDir = join(sandbox, 'Project', 'Team', 'RuntimeTest');
    mkdirSync(home, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('resolves Claude through the Claude project transcript resolver', async () => {
    const projectDir = join(
      home,
      '.claude',
      'projects',
      agentDir.replace(/\//g, '-'),
    );
    mkdirSync(projectDir, { recursive: true });
    const transcript = join(projectDir, 'claude-session.jsonl');
    writeFileSync(transcript, '{}\n');

    const result = await resolveAgentStreamSource(
      makeAgent('claude', agentDir),
      { home },
    );

    expect(result).toEqual({
      path: transcript,
      runtime: 'claude',
      resolvedVia: 'claude-fallback',
    });
  });

  it('selects the newest Codex rollout whose session cwd matches the agent', async () => {
    const dayDir = join(home, '.codex', 'sessions', '2026', '07', '18');
    mkdirSync(dayDir, { recursive: true });
    const wrong = join(dayDir, 'rollout-wrong.jsonl');
    const olderMatch = join(dayDir, 'rollout-old-match.jsonl');
    const newestMatch = join(dayDir, 'rollout-new-match.jsonl');
    writeFileSync(
      wrong,
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/other/project' } }) + '\n',
    );
    writeFileSync(
      olderMatch,
      JSON.stringify({ type: 'session_meta', payload: { cwd: agentDir } }) + '\n',
    );
    writeFileSync(
      newestMatch,
      JSON.stringify({ type: 'session_meta', payload: { cwd: agentDir } }) + '\n',
    );
    utimesSync(olderMatch, new Date(1000), new Date(1000));
    utimesSync(newestMatch, new Date(3000), new Date(3000));
    utimesSync(wrong, new Date(5000), new Date(5000));

    const result = await resolveAgentStreamSource(
      makeAgent('codex', agentDir),
      { home },
    );

    expect(result).toEqual({
      path: newestMatch,
      runtime: 'codex',
      resolvedVia: 'codex-session-cwd',
    });
  });

  it('never sends a Codex agent through a stale Claude scratch transcript', async () => {
    const scratch = join(agentDir, '.session-scratch');
    mkdirSync(scratch, { recursive: true });
    const staleClaude = join(sandbox, 'stale-claude.jsonl');
    writeFileSync(staleClaude, '{}\n');
    writeFileSync(join(scratch, 'transcript-path'), staleClaude);

    const result = await resolveAgentStreamSource(
      makeAgent('codex', agentDir),
      { home },
    );

    expect(result).toBeNull();
  });

  it('resolves Gemini sessions only through a matching .project_root', async () => {
    const wrongTmp = join(home, '.gemini', 'tmp', 'wrong');
    const rightTmp = join(home, '.gemini', 'tmp', 'right');
    mkdirSync(join(wrongTmp, 'chats'), { recursive: true });
    mkdirSync(join(rightTmp, 'chats'), { recursive: true });
    writeFileSync(join(wrongTmp, '.project_root'), '/other/project');
    writeFileSync(join(rightTmp, '.project_root'), `${agentDir}\n`);
    const wrong = join(wrongTmp, 'chats', 'session-newer.jsonl');
    const right = join(rightTmp, 'chats', 'session-match.jsonl');
    writeFileSync(wrong, '{}\n');
    writeFileSync(right, '{}\n');
    utimesSync(wrong, new Date(5000), new Date(5000));
    utimesSync(right, new Date(1000), new Date(1000));

    const result = await resolveAgentStreamSource(
      makeAgent('gemini', agentDir),
      { home },
    );

    expect(result).toEqual({
      path: right,
      runtime: 'gemini',
      resolvedVia: 'gemini-project-root',
    });
  });

  it('resolves a Grok native chat by its percent-encoded cwd', async () => {
    const cwdKey = encodeURIComponent(agentDir);
    const sessionDir = join(home, '.grok', 'sessions', cwdKey, 'session-1');
    mkdirSync(sessionDir, { recursive: true });
    const chat = join(sessionDir, 'chat_history.jsonl');
    writeFileSync(chat, '{}\n');

    const result = await resolveAgentStreamSource(
      makeAgent('grok', agentDir),
      { home },
    );

    expect(result).toEqual({
      path: chat,
      runtime: 'grok',
      resolvedVia: 'grok-native-chat',
    });
  });

  it.each([
    ['antigravity', '.antigravity-stream.jsonl', 'antigravity-decoder'],
  ] as const)(
    'uses the deterministic %s wrapper stream without borrowing another runtime',
    async (runtime, fileName, resolvedVia) => {
      const expected = join(agentDir, fileName);
      const result = await resolveAgentStreamSource(
        makeAgent(runtime, agentDir),
        { home },
      );

      expect(result).toEqual({ path: expected, runtime, resolvedVia });
    },
  );
});

describe('normalizeAgentStreamLine', () => {
  it('passes Claude-compatible entries through unchanged', () => {
    const entry = { type: 'assistant', message: { content: 'hello' } };
    expect(normalizeAgentStreamLine('claude', JSON.stringify(entry))).toEqual([
      entry,
    ]);
  });

  it('normalizes Codex messages, tool calls, and tool results', () => {
    const message = normalizeAgentStreamLine(
      'codex',
      JSON.stringify({
        timestamp: '2026-07-18T12:00:00Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Implemented.' }],
        },
      }),
    );
    const call = normalizeAgentStreamLine(
      'codex',
      JSON.stringify({
        timestamp: '2026-07-18T12:00:01Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call-1',
          name: 'exec',
          input: '{"cmd":"npm test"}',
        },
      }),
    );
    const result = normalizeAgentStreamLine(
      'codex',
      JSON.stringify({
        timestamp: '2026-07-18T12:00:02Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call-1',
          output: [{ type: 'input_text', text: '44 tests passed' }],
        },
      }),
    );

    expect(message[0]).toMatchObject({
      type: 'assistant',
      uuid: 'msg-1',
      message: { content: [{ type: 'text', text: 'Implemented.' }] },
    });
    expect(call[0]).toMatchObject({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'call-1',
            name: 'exec',
            input: { cmd: 'npm test' },
          },
        ],
      },
    });
    expect(result[0]).toMatchObject({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: '44 tests passed',
          },
        ],
      },
    });
  });

  it('keeps Codex reasoning ids stable across SSE reconnect backfill', () => {
    const [reasoning] = normalizeAgentStreamLine(
      'codex',
      JSON.stringify({
        timestamp: '2026-07-18T12:00:00Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          id: 'reasoning-1',
          summary: [{ type: 'summary_text', text: 'Checking the failure.' }],
        },
      }),
    );

    expect(reasoning).toMatchObject({ uuid: 'reasoning-1' });
  });

  it('does not expose Codex encrypted reasoning payloads', () => {
    const result = normalizeAgentStreamLine(
      'codex',
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [],
          encrypted_content: 'secret-ciphertext',
        },
      }),
    );
    expect(result).toEqual([]);
  });

  it('normalizes Gemini prose, thoughts, tool use, and tool result', () => {
    const result = normalizeAgentStreamLine(
      'gemini',
      JSON.stringify({
        id: 'gemini-1',
        timestamp: '2026-07-18T12:00:00Z',
        type: 'gemini',
        content: 'Done.',
        thoughts: [{ subject: 'Checking', description: 'Running tests.' }],
        toolCalls: [
          {
            id: 'tool-1',
            name: 'run_shell_command',
            args: { command: 'npm test' },
            result: [{ functionResponse: { response: { output: 'passed' } } }],
          },
        ],
      }),
    );

    expect(result.map((entry) => entry.type)).toEqual([
      'assistant',
      'assistant',
      'user',
    ]);
    expect(result[0]).toMatchObject({
      message: {
        content: [
          { type: 'thinking', thinking: 'Checking\nRunning tests.' },
          { type: 'text', text: 'Done.' },
        ],
      },
    });
    expect(result[1]).toMatchObject({
      message: {
        content: [{ type: 'tool_use', id: 'tool-1' }],
      },
    });
    expect(result[2]).toMatchObject({
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1' }],
      },
    });
  });

  it('normalizes Grok chat messages and suppresses the bootstrap system prompt', () => {
    expect(
      normalizeAgentStreamLine(
        'grok',
        JSON.stringify({ type: 'system', content: 'large bootstrap' }),
      ),
    ).toEqual([]);
    expect(
      normalizeAgentStreamLine(
        'grok',
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'text', text: 'Grok result' }],
        }),
      ),
    ).toMatchObject([
      { type: 'assistant', message: { content: [{ text: 'Grok result' }] } },
    ]);
  });
});
