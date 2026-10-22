import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { tracked } from '@/lib/api-tracking';
import { buildXaiBody } from '@/lib/xai-kwargs';
import type {
  FeatureDocsData,
  FeatureDoc,
  FeatureDocActionRequest,
  FeatureDocActionResponse,
  CollabTasksData,
  CollabTask,
  CollabSprint,
  CollabPhase,
} from '@/lib/types';
import { getDevflowHome } from '@/lib/home-dir';

const DATA_PATH = DataPaths.featureDocs;
const TASKS_PATH = DataPaths.collabTasks;

const DEFAULT_DATA: FeatureDocsData = {
  docs: [],
  lastUpdated: new Date().toISOString(),
};

const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';
const XAI_MODEL = 'grok-4.7';
const RAG_GUIDELINES_PATH = `${getDevflowHome()}/data/central-knowledge-base/platform/rag-writing-guidelines.md`;

let _grokApiKey: string | null = null;
let _ragGuidelines: string | null = null;

async function getGrokApiKey(): Promise<string> {
  if (_grokApiKey) return _grokApiKey;
  if (process.env.GROK_API_KEY) {
    _grokApiKey = process.env.GROK_API_KEY;
    return _grokApiKey;
  }
  const secretsPath = path.join(os.homedir(), '.secrets');
  const content = await fs.readFile(secretsPath, 'utf-8');
  const match = content.match(/export GROK_API_KEY="([^"]+)"/);
  if (!match) {
    throw new Error('GROK_API_KEY not found in ~/.secrets');
  }
  _grokApiKey = match[1];
  return _grokApiKey;
}

async function getRagGuidelines(): Promise<string> {
  if (_ragGuidelines) return _ragGuidelines;
  try {
    _ragGuidelines = await fs.readFile(RAG_GUIDELINES_PATH, 'utf-8');
    return _ragGuidelines;
  } catch {
    return '';
  }
}

/**
 * Call the xAI API directly for sprint summarization.
 * Uses Grok 4.1 Fast — direct API call, no tmux/CLI overhead.
 * System prompt includes RAG writing guidelines for well-structured output.
 */
async function runGrokSummary(prompt: string): Promise<string> {
  const apiKey = await getGrokApiKey();
  const ragGuidelines = await getRagGuidelines();

  const messages: Array<{ role: string; content: string }> = [];
  if (ragGuidelines) {
    messages.push({
      role: 'system',
      content: `You are a technical documentation writer. Follow these documentation structure guidelines strictly:\n\n${ragGuidelines}`,
    });
  }
  messages.push({ role: 'user', content: prompt });

  const response = await fetch(XAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildXaiBody(XAI_MODEL, {
      messages,
      max_tokens: 2000,
      temperature: 0.3,
    })),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[FeatureDocs] xAI API error:', response.status, errorText);
    throw new Error(`xAI API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('xAI API returned empty response');
  }

  return text.trim();
}

/**
 * Extract clean markdown content from terminal task output.
 *
 * Claude Code's TUI renders markdown differently:
 *   # Title      → ● Title
 *   ## Section   → Section (bold-styled, unindented within response block)
 *   ### Sub      → Sub (indented subsection)
 *   - items      → - items (indented with 2 spaces)
 *
 * This function finds Claude's response (marked by ●), extracts it,
 * and converts TUI formatting back to standard markdown.
 */
function extractMarkdownFromOutput(output: string): string {
  const lines = output.split('\n');

  // Strategy 1: Find the ● marker (Claude Code's rendered H1)
  let startIdx = lines.findIndex(l => l.trim().startsWith('●'));

  // Strategy 2: If no ● found, look for raw markdown # heading
  if (startIdx === -1) {
    startIdx = lines.findIndex(l => /^#{1,3}\s+/.test(l.trim()));
  }

  // Strategy 3: Find content after the last prompt echo
  if (startIdx === -1) {
    const lastPromptIdx = lines.findLastIndex(l =>
      l.includes('Respond with ONLY') || l.includes('Start with a # title')
    );
    if (lastPromptIdx >= 0) {
      startIdx = lastPromptIdx + 1;
      // Skip blank lines after prompt
      while (startIdx < lines.length && lines[startIdx].trim() === '') startIdx++;
    }
  }

  if (startIdx === -1) return output.trim();

  // Find the end: stop at TUI trailing chrome
  let endIdx = lines.length;
  for (let i = lines.length - 1; i > startIdx; i--) {
    const trimmed = lines[i].trim();
    if (
      trimmed === '' ||
      /^[─━\u2500\u2550]+$/.test(trimmed) ||  // TUI horizontal rules
      trimmed.includes('❯') ||                  // Prompt line
      trimmed.includes('⏵⏵') ||                 // Permission bypass
      trimmed.startsWith('bypass ')              // "bypass permissions on"
    ) {
      endIdx = i;
    } else {
      break;
    }
  }

  const responseLines = lines.slice(startIdx, endIdx);

  // Convert TUI formatting back to markdown
  const mdLines: string[] = [];
  for (const line of responseLines) {
    const trimmed = line.trim();

    // ● Title → # Title
    if (trimmed.startsWith('●')) {
      mdLines.push('# ' + trimmed.slice(1).trim());
      continue;
    }

    // Skip empty lines in the raw output (preserve as-is)
    if (trimmed === '') {
      mdLines.push('');
      continue;
    }

    // Lines starting with "  - " → bullet points (keep as-is, just dedent)
    if (/^\s{2,}- /.test(line)) {
      mdLines.push(line.replace(/^\s{2}/, ''));
      continue;
    }

    // Non-indented non-empty lines after ● that aren't bullets → likely H2 sections
    // (Claude TUI renders ## headings as bold unindented text)
    if (/^\s{2}\S/.test(line) && !line.trim().startsWith('-')) {
      // Check if it looks like a section header (short, no punctuation at end)
      const text = trimmed;
      if (text.length < 80 && !/[.,:;!?]$/.test(text) && !/^\d/.test(text)) {
        mdLines.push('## ' + text);
        continue;
      }
    }

    // Default: dedent by 2 spaces (Claude TUI indents response body)
    mdLines.push(line.replace(/^\s{2}/, ''));
  }

  return mdLines.join('\n').trim();
}

/**
 * Generate a feature summary from sprint data using the xAI API (Grok 4.1 Fast).
 * Direct API call — no tmux or CLI overhead.
 */
async function generateFeatureSummary(
  sprints: CollabSprint[],
  phases: CollabPhase[],
  tasks: CollabTask[]
): Promise<{ title: string; content: string }> {
  // Build a structured prompt from sprint data
  const sprintContext = sprints.map(sprint => {
    const sprintPhases = phases.filter(p => p.sprintId === sprint.id);
    const phaseSections = sprintPhases.map(phase => {
      const phaseTasks = tasks.filter(t => t.phaseId === phase.id);
      const taskList = phaseTasks.map(t => {
        const status = t.status === 'done' ? '[DONE]' : t.status === 'in_progress' ? '[IN PROGRESS]' : '[TODO]';
        return `  - ${status} ${t.title}${t.description ? ': ' + t.description : ''}`;
      }).join('\n');
      return `### ${phase.name}\n${taskList || '  (no tasks)'}`;
    }).join('\n\n');

    return `## ${sprint.name} (${sprint.status})\n${phaseSections || '(no phases)'}`;
  }).join('\n\n---\n\n');

  const completedCount = tasks.filter(t => t.status === 'done').length;

  const prompt = `You are a technical writer. Given the following sprint board data showing completed development work, generate a concise feature documentation summary.

Format the output as markdown with:
1. A short title summarizing all the work (e.g., "Collab Chat System Upgrades" or "Idea Board + Sprint Improvements")
2. A "Features Implemented" section with bullet points for each major feature/capability added
3. Each feature should have a brief description (1-2 sentences) of what it does from a user perspective
4. Group related features together under subheadings if there are many

Keep it user-focused — describe what the user can now do, not implementation details.
${completedCount} tasks were completed.

Sprint Data:
${sprintContext}

Respond with ONLY the markdown content. Start with a # title line.`;

  const content = await runGrokSummary(prompt);

  if (!content) {
    throw new Error('Grok returned empty summary');
  }

  // Extract title from first heading
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : sprints.map(s => s.name).join(', ');

  return { title, content };
}

/**
 * GET /api/feature-docs?channelId=xxx - List feature docs for a channel
 */
export const GET = tracked('/api/feature-docs', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const { searchParams } = new URL(request.url);
    const channelId = searchParams.get('channelId');

    const data = await readJsonFile<FeatureDocsData>(DATA_PATH, DEFAULT_DATA);
    let docs = data.docs;

    if (channelId) {
      docs = docs.filter(d => d.channelId === channelId);
    }

    docs.sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());

    return NextResponse.json<FeatureDocActionResponse>({
      success: true,
      docs,
    });
  } catch (error) {
    console.error('[FeatureDocs] GET error:', error);
    return NextResponse.json<FeatureDocActionResponse>(
      { success: false, error: 'Failed to load feature docs' },
      { status: 500 }
    );
  }
});

/**
 * POST /api/feature-docs - Generate or manage feature docs
 */
export const POST = tracked('/api/feature-docs', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body: FeatureDocActionRequest = await request.json();
    const { action } = body;

    switch (action) {
      case 'generate': {
        if (!body.channelId) {
          return NextResponse.json<FeatureDocActionResponse>(
            { success: false, error: 'channelId is required' },
            { status: 400 }
          );
        }

        // Read sprint/phase/task data
        const tasksData = await readJsonFile<CollabTasksData>(TASKS_PATH, {
          tasks: [],
          sprints: [],
          phases: [],
          lastUpdated: new Date().toISOString(),
        });

        // Filter to this channel's completed sprints
        const channelSprints = (tasksData.sprints || []).filter(
          s => s.channelId === body.channelId && s.status === 'completed'
        );

        if (channelSprints.length === 0) {
          return NextResponse.json<FeatureDocActionResponse>(
            { success: false, error: 'No completed sprints found in this channel' },
            { status: 400 }
          );
        }

        const sprintIds = channelSprints.map(s => s.id);
        const channelPhases = (tasksData.phases || []).filter(
          p => sprintIds.includes(p.sprintId ?? '')
        );
        const phaseIds = channelPhases.map(p => p.id);
        const channelTasks = tasksData.tasks.filter(
          t => t.channelId === body.channelId &&
            (sprintIds.includes(t.sprintId || '') || phaseIds.includes(t.phaseId || ''))
        );

        // Generate summary via Grok 4.1 Fast (xAI API)
        const { title, content } = await generateFeatureSummary(
          channelSprints,
          channelPhases,
          channelTasks
        );

        const newDoc: FeatureDoc = {
          id: uuidv4(),
          channelId: body.channelId,
          title,
          content,
          sprintIds,
          sprintNames: channelSprints.map(s => s.name),
          taskCount: channelTasks.length,
          generatedAt: new Date().toISOString(),
        };

        // Save the doc
        await withFileLock(DATA_PATH, async () => {
          const data = await readJsonFile<FeatureDocsData>(DATA_PATH, DEFAULT_DATA);
          data.docs.push(newDoc);
          data.lastUpdated = new Date().toISOString();
          await writeJsonFile(DATA_PATH, data);
        });

        // Auto-export .MD file to RAG-watched knowledge base directory
        try {
          const featuresDir = path.join(os.homedir(), 'DevFlow', '.AppData', 'sprint-summaries');
          await fs.mkdir(featuresDir, { recursive: true });
          const slug = newDoc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const mdPath = path.join(featuresDir, `${slug}.md`);
          await fs.writeFile(mdPath, newDoc.content, 'utf-8');
          newDoc.exportPath = mdPath;
          // Update stored doc with exportPath
          await withFileLock(DATA_PATH, async () => {
            const d = await readJsonFile<FeatureDocsData>(DATA_PATH, DEFAULT_DATA);
            const idx = d.docs.findIndex(doc => doc.id === newDoc.id);
            if (idx !== -1) d.docs[idx] = newDoc;
            d.lastUpdated = new Date().toISOString();
            await writeJsonFile(DATA_PATH, d);
          });
        } catch (exportError) {
          console.error('[FeatureDocs] Auto-export failed (doc saved successfully):', exportError);
          // Don't fail — doc was already saved to JSON
        }

        // Optionally clear/archive the completed sprints
        if (body.clearSprints) {
          try {
            await withFileLock(TASKS_PATH, async () => {
              const data = await readJsonFile<CollabTasksData>(TASKS_PATH, {
                tasks: [],
                sprints: [],
                phases: [],
                lastUpdated: new Date().toISOString(),
              });

              const beforeSprints = data.sprints?.length || 0;
              const beforePhases = data.phases?.length || 0;
              const beforeTasks = data.tasks?.length || 0;

              // Remove completed sprints, their phases, and their tasks
              if (data.sprints) {
                data.sprints = data.sprints.filter(s => !sprintIds.includes(s.id));
              }
              if (data.phases) {
                data.phases = data.phases.filter(p => !sprintIds.includes(p.sprintId ?? ''));
              }
              data.tasks = data.tasks.filter(
                t => !sprintIds.includes(t.sprintId || '') && !phaseIds.includes(t.phaseId || '')
              );
              data.lastUpdated = new Date().toISOString();
              await writeJsonFile(TASKS_PATH, data);

            });
          } catch (archiveError) {
            console.error('[FeatureDocs] Sprint archive failed:', archiveError);
            // Don't fail the whole request — doc was already saved
          }
        }

        return NextResponse.json<FeatureDocActionResponse>({
          success: true,
          doc: newDoc,
        });
      }

      case 'list': {
        const data = await readJsonFile<FeatureDocsData>(DATA_PATH, DEFAULT_DATA);
        let docs = data.docs;
        if (body.channelId) {
          docs = docs.filter(d => d.channelId === body.channelId);
        }
        docs.sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());

        return NextResponse.json<FeatureDocActionResponse>({
          success: true,
          docs,
        });
      }

      case 'get': {
        if (!body.docId) {
          return NextResponse.json<FeatureDocActionResponse>(
            { success: false, error: 'docId is required' },
            { status: 400 }
          );
        }

        const data = await readJsonFile<FeatureDocsData>(DATA_PATH, DEFAULT_DATA);
        const doc = data.docs.find(d => d.id === body.docId);
        if (!doc) {
          return NextResponse.json<FeatureDocActionResponse>(
            { success: false, error: 'Feature doc not found' },
            { status: 404 }
          );
        }

        return NextResponse.json<FeatureDocActionResponse>({
          success: true,
          doc,
        });
      }

      case 'delete': {
        if (!body.docId) {
          return NextResponse.json<FeatureDocActionResponse>(
            { success: false, error: 'docId is required' },
            { status: 400 }
          );
        }

        await withFileLock(DATA_PATH, async () => {
          const data = await readJsonFile<FeatureDocsData>(DATA_PATH, DEFAULT_DATA);
          data.docs = data.docs.filter(d => d.id !== body.docId);
          data.lastUpdated = new Date().toISOString();
          await writeJsonFile(DATA_PATH, data);
        });

        return NextResponse.json<FeatureDocActionResponse>({ success: true });
      }

      case 'backfill': {
        // Write .MD files for all existing docs to the RAG-watched KB directory.
        // Skips docs already exported there; re-exports anything in old locations.
        const kbDir = path.join(os.homedir(), 'DevFlow', '.AppData', 'sprint-summaries');
        let exported = 0;
        let skipped = 0;

        await withFileLock(DATA_PATH, async () => {
          const d = await readJsonFile<FeatureDocsData>(DATA_PATH, DEFAULT_DATA);

          for (const doc of d.docs) {
            // Skip if already exported to KB dir and file still exists
            if (doc.exportPath?.startsWith(kbDir)) {
              try {
                await fs.access(doc.exportPath);
                skipped++;
                continue;
              } catch {
                // File gone — re-export below
              }
            }

            try {
              await fs.mkdir(kbDir, { recursive: true });
              const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
              const mdPath = path.join(kbDir, `${slug}.md`);
              await fs.writeFile(mdPath, doc.content, 'utf-8');
              doc.exportPath = mdPath;
              exported++;
            } catch (err) {
              console.error(`[FeatureDocs] Backfill failed for doc ${doc.id}:`, err);
              skipped++;
            }
          }

          d.lastUpdated = new Date().toISOString();
          await writeJsonFile(DATA_PATH, d);
        });

        return NextResponse.json<FeatureDocActionResponse>({
          success: true,
          exported,
          skipped,
        } as FeatureDocActionResponse & { exported: number; skipped: number });
      }

      default:
        return NextResponse.json<FeatureDocActionResponse>(
          { success: false, error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('[FeatureDocs] POST error:', error);
    return NextResponse.json<FeatureDocActionResponse>(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
});
