/**
 * Structure / prompt-enhancement feature config (the owner directive, 11 Jun 2026).
 *
 * Persists the user-tunable "guide" (system prompt), model choice, and on/off
 * switch for the AgentChat Structure button. Stored in .AppData so it survives
 * rebuilds; edited via the AgentChat settings cog → Structure tab, consumed by
 * /api/collab/enhance-prompt on every enhancement call.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { DataPaths } from './data-paths';

export interface EnhancePromptConfig {
  enabled: boolean;
  model: string;
  systemPrompt: string;
}

/** Models the enhancement pass may use. DeepSeek's API is always-on (cloud).
 * V4.1 Flash is the canonical current model; V4 Pro remains temporarily
 * available until DeepSeek's announced retirement window. */
export const ENHANCE_ALLOWED_MODELS: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', hint: 'Current — recommended' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', hint: 'Retires 14 Sep 2026' },
];

export const DEFAULT_SYSTEM_PROMPT = `You are a prompt-enhancement pass for messages a human sends to AI agents in a team chat.
Rewrite the user's draft so the receiving agent gets a clear, unambiguous instruction:
- Clarify the intent; make implicit requirements explicit only when the draft already implies them.
- When the draft contains multiple distinct requests, restructure it so each is a separate, clearly-stated item (a short numbered or bulleted list) so none can be missed.
- State the expected outcome plainly when the draft implies one (e.g. "numbers should update live").
- Mark uncertain diagnoses as hypotheses, not instructions (e.g. "possibly the websocket" rather than asserting it).
- Fix grammar, spelling, and punctuation.
- @mentions must remain EXACTLY as written and stand alone: plain text with a space (or line start/end) on each side. NEVER wrap a mention in bold, italics, quotes, backticks, or brackets, and NEVER attach punctuation directly to it — write "@Alex here's the plan" not "**@Alex**," or "\"@Alex\":". Decorated mentions break message routing.
- Preserve code blocks, file paths, URLs, and identifiers verbatim.
- Do NOT invent new requirements, scope, constraints, or facts that are not in the draft.
- Keep the author's voice; aim for similar length (never more than ~2x the original).
- Output ONLY the rewritten message — no preamble, no surrounding quotes, no explanation.`;

export const DEFAULT_ENHANCE_CONFIG: EnhancePromptConfig = {
  enabled: true,
  model: 'deepseek-flash',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

const CONFIG_PATH = path.join(DataPaths.base, 'enhance-prompt-config.json');

/** Read config, falling back field-by-field to defaults on missing/invalid data. */
export async function readEnhanceConfig(): Promise<EnhancePromptConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8')) as Partial<EnhancePromptConfig>;
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_ENHANCE_CONFIG.enabled,
      model: ENHANCE_ALLOWED_MODELS.some(m => m.id === raw.model)
        ? (raw.model as string)
        : DEFAULT_ENHANCE_CONFIG.model,
      systemPrompt:
        typeof raw.systemPrompt === 'string' && raw.systemPrompt.trim()
          ? raw.systemPrompt
          : DEFAULT_SYSTEM_PROMPT,
    };
  } catch {
    return { ...DEFAULT_ENHANCE_CONFIG };
  }
}

export async function writeEnhanceConfig(cfg: EnhancePromptConfig): Promise<void> {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

/**
 * Deterministic mention sanitizer — the guide tells the model to leave
 * @mentions bare; this enforces it (models decorate anyway). Mention routing
 * requires bare mentions: parseAtMentions doesn't strip trailing quotes or
 * backticks, and the client-side detector requires whitespace before the @,
 * so "@Name" / **@Name** / `@Name` silently break targeting or broadcast
 * detection. Only names matching channel participants are touched (so code
 * like @Injectable() or emails are never mangled), and code spans are skipped.
 */
export function sanitizeMentions(text: string, participantNames: string[]): string {
  if (!participantNames.length) return text;
  const nameSet = new Set(participantNames.map(n => n.toLowerCase()));
  // Odd indices are code segments (captured by the split group) — untouched.
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        // Inline code that is EXACTLY one participant mention is decoration,
        // not code — unwrap it so the mention fires. Anything else stays code.
        const solo = part.match(/^`@([A-Za-z][\w'-]*)`$/);
        return solo && nameSet.has(solo[1].toLowerCase()) ? `@${solo[1]}` : part;
      }
      // 1) Unwrap decoration hugging a mention: **@N** *@N* __@N__ _@N_ "@N" '@N' (@N) [@N]
      // Iterate to a fixpoint — models nest decoration (e.g. **"@Name"**) and
      // each replace() pass peels exactly one layer.
      let out = part;
      for (let pass = 0; pass < 5; pass++) {
        // Name capture is LAZY: `_` is a word char, so a greedy capture eats
        // the closing `_` of _@Name_ (name becomes "Name_", guard rejects it,
        // loop stalls). Lazy grows the name only until the right wrapper fits.
        const next = out.replace(
          /(\*\*|__|\*|_|"|'|\(|\[)@([A-Za-z][\w'-]*?)(\*\*|__|\*|_|"|'|\)|\])/g,
          (m, _l, n) => (nameSet.has(n.toLowerCase()) ? `@${n}` : m),
        );
        if (next === out) break;
        out = next;
      }
      // 2) Detach glued trailing chars: "@N," → "@N ," (space guarantees firing)
      out = out.replace(
        /(^|\s)@([A-Za-z][\w'-]*)(?=[^\s\w'-])/g,
        (m, pre, n) => (nameSet.has(n.toLowerCase()) ? `${pre}@${n} ` : m),
      );
      return out;
    })
    .join('');
}
