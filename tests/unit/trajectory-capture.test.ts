/**
 * Unit tests for lib/trajectory-capture.ts — Hermes Sprint T4.
 */
import { describe, it, expect } from 'vitest';
import { captureTrajectory, TrajectoryCaptureResult } from '@/lib/trajectory-capture';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function makeTranscript(turns: Array<{ role: 'user' | 'assistant'; content: unknown }>): string {
  const lines: string[] = [];
  for (const turn of turns) {
    if (turn.role === 'assistant') {
      const content = Array.isArray(turn.content) ? turn.content : [turn.content];
      lines.push(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content },
      }));
    } else {
      lines.push(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: turn.content },
      }));
    }
  }
  return lines.join('\n');
}

function writeTemp(data: string): string {
  const tmp = path.join(os.tmpdir(), `trajectory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(tmp, data);
  return tmp;
}

function toolUse(name: string, id: string, input: Record<string, unknown> = {}) {
  return { type: 'tool_use', name, id, input };
}

function toolResult(toolUseId: string, isError: boolean, content?: string) {
  return { type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: content ?? 'output' };
}

describe('captureTrajectory — basic capture', () => {
  it('produces a template with required sections', () => {
    const entries: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'assistant', content: [toolUse('Bash', 'id0', { command: 'npm test' })] },
      { role: 'user', content: [toolResult('id0', false)] },
      { role: 'assistant', content: [toolUse('Read', 'id1', { file_path: '/home/user/SG-1/foo.ts' })] },
      { role: 'user', content: [toolResult('id1', false)] },
      { role: 'assistant', content: [toolUse('Edit', 'id2', { file_path: '/home/user/SG-1/foo.ts' })] },
      { role: 'user', content: [toolResult('id2', false)] },
    ];
    const tmp = writeTemp(makeTranscript(entries));
    const result = captureTrajectory({ transcriptPath: tmp });
    fs.unlinkSync(tmp);

    expect(result.toolCount).toBe(3);
    expect(result.dominantTool).toBe('Bash'); // tie goes to first alfabetic... actually Bash=1, Read=1, Edit=1 → first wins
    expect(result.toolSequence).toEqual(['Bash', 'Read', 'Edit']);
    // Template must have required SKILL.md sections
    expect(result.template).toContain('---');
    expect(result.template).toContain('name:');
    expect(result.template).toContain('description:');
    expect(result.template).toContain('## Instructions');
    expect(result.template).toContain('## Examples');
    expect(result.template).toContain('## Troubleshooting');
    expect(result.template).toContain('## Environmental Prerequisites');
    expect(result.skillName).toBeTruthy();
  });

  it('returns empty template for missing transcript', () => {
    const result = captureTrajectory({ transcriptPath: '/tmp/nonexistent-transcript.jsonl' });
    expect(result.toolCount).toBe(0);
    expect(result.toolSequence).toEqual([]);
  });
});

describe('captureTrajectory — skill name derivation', () => {
  it('derives from Bash command when dominant tool is Bash', () => {
    const entries: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'assistant', content: [toolUse('Bash', 'id0', { command: 'git log --oneline' })] },
      { role: 'user', content: [toolResult('id0', false)] },
      { role: 'assistant', content: [toolUse('Bash', 'id1', { command: 'git diff HEAD~1' })] },
      { role: 'user', content: [toolResult('id1', false)] },
    ];
    const tmp = writeTemp(makeTranscript(entries));
    const result = captureTrajectory({ transcriptPath: tmp });
    fs.unlinkSync(tmp);
    expect(result.skillName).toBe('git-workflow');
  });

  it('skips common shell builtins when deriving name', () => {
    const entries: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'assistant', content: [toolUse('Bash', 'id0', { command: 'cd /tmp && ls' })] },
      { role: 'user', content: [toolResult('id0', false)] },
      { role: 'assistant', content: [toolUse('Bash', 'id1', { command: 'echo hello' })] },
      { role: 'user', content: [toolResult('id1', false)] },
      { role: 'assistant', content: [toolUse('Bash', 'id2', { command: 'npx vitest run' })] },
      { role: 'user', content: [toolResult('id2', false)] },
    ];
    const tmp = writeTemp(makeTranscript(entries));
    const result = captureTrajectory({ transcriptPath: tmp });
    fs.unlinkSync(tmp);
    // Should skip cd/ls/echo and pick npx
    expect(result.skillName).toBe('npx-workflow');
  });

  it('derives from file extension when dominant tool is Edit/Write', () => {
    const entries: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'assistant', content: [toolUse('Edit', 'id0', { file_path: '/src/foo.ts' })] },
      { role: 'user', content: [toolResult('id0', false)] },
      { role: 'assistant', content: [toolUse('Edit', 'id1', { file_path: '/src/bar.ts' })] },
      { role: 'user', content: [toolResult('id1', false)] },
    ];
    const tmp = writeTemp(makeTranscript(entries));
    const result = captureTrajectory({ transcriptPath: tmp });
    fs.unlinkSync(tmp);
    expect(result.skillName).toBe('ts-editing');
  });

  it('accepts overridden skill name', () => {
    const entries: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'assistant', content: [toolUse('Read', 'id0')] },
      { role: 'user', content: [toolResult('id0', false)] },
    ];
    const tmp = writeTemp(makeTranscript(entries));
    const result = captureTrajectory({ transcriptPath: tmp, skillName: 'my-custom-skill' });
    fs.unlinkSync(tmp);
    expect(result.skillName).toBe('my-custom-skill');
  });

  it('falls back to domain name for unknown tools', () => {
    const entries: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'assistant', content: [toolUse('WebFetch', 'id0')] },
      { role: 'user', content: [toolResult('id0', false)] },
    ];
    const tmp = writeTemp(makeTranscript(entries));
    const result = captureTrajectory({ transcriptPath: tmp });
    fs.unlinkSync(tmp);
    expect(result.skillName).toBe('content-extraction');
  });
});

describe('captureTrajectory — prerequisite extraction', () => {
  it('extracts file paths from Read/Edit/Write calls', () => {
    const entries: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'assistant', content: [toolUse('Read', 'id0', { file_path: '/home/user/SG-1/foo.ts' })] },
      { role: 'user', content: [toolResult('id0', false)] },
      { role: 'assistant', content: [toolUse('Edit', 'id1', { file_path: '/home/user/SG-1/bar.ts' })] },
      { role: 'user', content: [toolResult('id1', false)] },
    ];
    const tmp = writeTemp(makeTranscript(entries));
    const result = captureTrajectory({ transcriptPath: tmp });
    fs.unlinkSync(tmp);
    expect(result.template).toContain('Files');
  });

  it('detects runtime from Bash commands', () => {
    const entries: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'assistant', content: [toolUse('Bash', 'id0', { command: 'npx tsc --noEmit' })] },
      { role: 'user', content: [toolResult('id0', false)] },
    ];
    const tmp = writeTemp(makeTranscript(entries));
    const result = captureTrajectory({ transcriptPath: tmp });
    fs.unlinkSync(tmp);
    expect(result.template).toContain('TypeScript');
  });

  it('extracts env var references', () => {
    const entries: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'assistant', content: [toolUse('Bash', 'id0', { command: 'curl -H "Authorization: Bearer $DEVFLOW_API_TOKEN" http://localhost:3000/api/test' })] },
      { role: 'user', content: [toolResult('id0', false)] },
    ];
    const tmp = writeTemp(makeTranscript(entries));
    const result = captureTrajectory({ transcriptPath: tmp });
    fs.unlinkSync(tmp);
    expect(result.template).toContain('DEVFLOW_API_TOKEN');
  });
});

describe('captureTrajectory — maxToolCalls limiting', () => {
  it('only captures the last N calls', () => {
    const entries: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
    for (let i = 0; i < 8; i++) {
      entries.push({ role: 'assistant', content: [toolUse('Bash', `id${i}`, { command: `cmd${i}` })] });
      entries.push({ role: 'user', content: [toolResult(`id${i}`, false)] });
    }
    const tmp = writeTemp(makeTranscript(entries));
    const result = captureTrajectory({ transcriptPath: tmp, maxToolCalls: 3 });
    fs.unlinkSync(tmp);
    expect(result.toolCount).toBe(3);
  });
});

describe('captureTrajectory — dominant tool', () => {
  it('identifies the most-used tool', () => {
    const entries: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'assistant', content: [toolUse('Bash', 'id0')] },
      { role: 'user', content: [toolResult('id0', false)] },
      { role: 'assistant', content: [toolUse('Read', 'id1')] },
      { role: 'user', content: [toolResult('id1', false)] },
      { role: 'assistant', content: [toolUse('Read', 'id2')] },
      { role: 'user', content: [toolResult('id2', false)] },
      { role: 'assistant', content: [toolUse('Read', 'id3')] },
      { role: 'user', content: [toolResult('id3', false)] },
      { role: 'assistant', content: [toolUse('Edit', 'id4')] },
      { role: 'user', content: [toolResult('id4', false)] },
    ];
    const tmp = writeTemp(makeTranscript(entries));
    const result = captureTrajectory({ transcriptPath: tmp });
    fs.unlinkSync(tmp);
    expect(result.dominantTool).toBe('Read');
    expect(result.toolCount).toBe(5);
  });
});

describe('captureTrajectory — step grouping', () => {
  it('groups consecutive same-tool calls with count', () => {
    const entries: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'assistant', content: [toolUse('Read', 'id0', { file_path: '/a.ts' })] },
      { role: 'user', content: [toolResult('id0', false)] },
      { role: 'assistant', content: [toolUse('Read', 'id1', { file_path: '/b.ts' })] },
      { role: 'user', content: [toolResult('id1', false)] },
      { role: 'assistant', content: [toolUse('Read', 'id2', { file_path: '/c.ts' })] },
      { role: 'user', content: [toolResult('id2', false)] },
    ];
    const tmp = writeTemp(makeTranscript(entries));
    const result = captureTrajectory({ transcriptPath: tmp });
    fs.unlinkSync(tmp);
    expect(result.template).toContain('(×3)');
  });

  it('shows individual steps when tools differ', () => {
    const entries: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'assistant', content: [toolUse('Read', 'id0')] },
      { role: 'user', content: [toolResult('id0', false)] },
      { role: 'assistant', content: [toolUse('Edit', 'id1')] },
      { role: 'user', content: [toolResult('id1', false)] },
    ];
    const tmp = writeTemp(makeTranscript(entries));
    const result = captureTrajectory({ transcriptPath: tmp });
    fs.unlinkSync(tmp);
    expect(result.template).toContain('Step 1:');
    expect(result.template).toContain('Step 2:');
  });
});
