/**
 * Invent a new character for a role whose named characters are all in use.
 *
 * the owner (28 Sep 2026): a channel can hold more agents of a role than the role
 * has characters (Costa Vida already had two 3D animators). Instead of blocking,
 * DevFlow picks a fitting sci-fi/fantasy character — "Morpheus from The Sandman
 * for a 3D modeller" — writes their personality file in the house format and
 * adds them to the role, so they are offered like any other character.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { AgentRole } from '@/lib/types';
import { withFileLock } from '@/lib/data-io';
import { appPath } from '@/lib/app-paths';

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-flash';
const TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 3;

export const PERSONALITIES_DIR = appPath('data', 'roles', 'personalities');
export const ROLES_JSON = appPath('data', 'roles', 'roles.json');

export interface GeneratedCharacter {
  name: string;
  source: string;
  markdown: string;
}

const NAME_RE = /^[A-Z][A-Za-z]{1,19}(-[A-Z][A-Za-z]{1,19})?$/;

export function buildCharacterPrompt(role: Pick<AgentRole, 'name' | 'description'>, takenNames: string[]): string {
  return [
    `Pick ONE fictional character from a well-known science-fiction or fantasy series (TV, film, comics or games;`,
    `not fairy tales or classic children's literature)`,
    `whose background genuinely fits this team role, so the name feels right for the job.`,
    `Role: ${role.name}. ${role.description || ''}`,
    `Example of the fit wanted: Morpheus (Dream) from The Sandman for a 3D modeller, because he shapes worlds.`,
    `Do NOT use any of these names: ${takenNames.join(', ')}.`,
    `The name must be a single word (a hyphen is allowed, e.g. Obi-Wan), capitalised, letters only.`,
    ``,
    `Reply with JSON only: {"name": "...", "source": "<series>", "markdown": "..."}.`,
    `"markdown" is a personality profile in exactly this format:`,
    `# Personality: <Name>`,
    ``,
    `You are <Name> from <series>.`,
    ``,
    `Then three short paragraphs: (1) who they are and how their strengths suit the role;`,
    `(2) how they speak — always plain, operational English even if the character is ornate;`,
    `(3) their temperament and how they treat teammates. No lists, no headings beyond the title, under 300 words.`,
  ].join('\n');
}

/** Parse and validate the model reply. Returns null when it is unusable. */
export function parseGeneratedCharacter(raw: string, takenNames: string[]): GeneratedCharacter | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { name, source, markdown } = parsed as Record<string, unknown>;
  if (typeof name !== 'string' || typeof source !== 'string' || typeof markdown !== 'string') return null;
  const cleanName = name.trim();
  if (!NAME_RE.test(cleanName)) return null;
  if (takenNames.some(t => t.toLowerCase() === cleanName.toLowerCase())) return null;
  const md = markdown.trim();
  if (!md.startsWith(`# Personality: ${cleanName}`) || md.length < 200 || md.length > 4000) return null;
  return { name: cleanName, source: source.trim(), markdown: md + '\n' };
}

export async function listPersonalityNames(): Promise<string[]> {
  try {
    const entries = await fs.readdir(PERSONALITIES_DIR);
    return entries.filter(e => e.endsWith('.md')).map(e => e.slice(0, -3));
  } catch {
    return [];
  }
}

type ChatFn = (prompt: string) => Promise<string>;

async function deepseekChat(prompt: string): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not configured on server');
  const resp = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.9,
      max_tokens: 1500,
      // Reasoning off: with it on, deepseek-flash spent the whole token budget
      // thinking and returned empty content (28 Sep 2026).
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`DeepSeek API ${resp.status}`);
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Invent, save and attach a new character to `roleId`. `extraTaken` are names
 * already on the channel roster (agents may use names outside the catalogue).
 */
export async function generateRoleCharacter(
  roleId: string,
  extraTaken: string[] = [],
  chat: ChatFn = deepseekChat,
): Promise<{ name: string; source: string }> {
  const roles = JSON.parse(await fs.readFile(ROLES_JSON, 'utf-8')) as { roles: AgentRole[] };
  const role = roles.roles.find(r => r.id === roleId);
  if (!role) throw Object.assign(new Error('Role not found'), { statusCode: 404 });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const taken = [...new Set([...(await listPersonalityNames()), ...extraTaken])];
    const character = parseGeneratedCharacter(await chat(buildCharacterPrompt(role, taken)), taken);
    if (!character) continue;

    const file = path.join(PERSONALITIES_DIR, `${character.name}.md`);
    try {
      await fs.writeFile(file, character.markdown, { encoding: 'utf-8', flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;  // raced another add
      throw err;
    }
    await withFileLock(ROLES_JSON, async () => {
      const fresh = JSON.parse(await fs.readFile(ROLES_JSON, 'utf-8')) as { roles: AgentRole[] };
      const target = fresh.roles.find(r => r.id === roleId);
      if (target && !(target.characterIds || []).includes(character.name)) {
        target.characterIds = [...(target.characterIds || []), character.name];
        target.updatedAt = new Date().toISOString();
        await fs.writeFile(ROLES_JSON, JSON.stringify(fresh, null, 2), 'utf-8');
      }
    });
    return { name: character.name, source: character.source };
  }
  throw new Error('Could not invent a usable new character; try again');
}
