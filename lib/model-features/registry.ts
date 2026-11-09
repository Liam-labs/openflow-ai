/**
 * The catalog of features that use an AI model. Adding a feature means adding one entry here.
 *
 * Rules (docs/model-features.md): every feature is OFF until the person switches it on, no provider is a default or a requirement,
 * and the recommendation is shown, never applied. `dataSent` says in plain sentences exactly what leaves the machine.
 */

export interface Provider {
  id: string;
  label: string;
  /** The name of the secret that holds the key, or null for a model that runs on this computer. */
  secretName: string | null;
}

/** Providers a person can link. A feature never names one of these as required. */
export const PROVIDERS: Provider[] = [
  { id: 'anthropic', label: 'Anthropic', secretName: 'ANTHROPIC_API_KEY' },
  { id: 'deepseek', label: 'DeepSeek', secretName: 'DEEPSEEK_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', secretName: 'OPENROUTER_API_KEY' },
  { id: 'xai', label: 'xAI (Grok)', secretName: 'XAI_API_KEY' },
  { id: 'openai', label: 'OpenAI', secretName: 'OPENAI_API_KEY' },
  { id: 'ollama', label: 'Local model (Ollama)', secretName: null },
];

export interface Recommendation {
  provider: string;
  model: string;
  /** One short sentence. A recommendation without a reason is refused by validateRegistry. */
  reason: string;
}

export interface ModelFeature {
  id: string;
  name: string;
  /** What leaves this computer when the feature runs. Never empty. */
  dataSent: string[];
  recommended: Recommendation;
  /**
   * false until the feature's owner has replaced dataSent with what the code really sends. A feature that is not ready cannot be
   * switched on, so nobody agrees to a data line that was never checked.
   */
  ready: boolean;
  /**
   * Optional: how automatic the feature is, in order from least to most. The person's chosen mode is stored beside the model.
   * The first mode is always "off" in effect: a feature with enabled=false does nothing whatever its mode says.
   */
  modes?: { id: string; label: string }[];
}

export const FEATURES: ModelFeature[] = [
  {
    id: 'knowledge-update',
    name: 'Automatic knowledge-base updates',
    dataSent: ['(Not yet checked against the code: the person who builds this feature replaces this line with exactly what is sent, and what is not.)'],
    recommended: { provider: 'deepseek', model: 'deepseek-flash', reason: 'Low cost for summarising text (price checked 9 Nov 2026). This is a cost recommendation only: any provider you have linked works.' },
    ready: false,
  },
  {
    id: 'overwatch',
    name: 'Overwatch (keeps sprints, tasks and the board up to date)',
    // Checked against lib/sprint-overwatch-score.ts, -redact.ts, -writer.ts and -store.ts by the SG-1 seat that built it (1 Nov 2026).
    dataSent: [
      'The text of each message posted in the channels this feature watches, up to 1,200 characters, with the sender\'s name. Only messages of at least 80 characters from people are read: automated posts, messages relayed from another channel and question cards are not.',
      'The three messages posted just before it, up to 300 characters each, for context.',
      'The titles of the open tasks in that channel (up to 90 tasks, 110 characters each), the titles of tasks finished in the last hour, and the names of the open sprints with their first eight task titles. Task descriptions are never sent.',
      'Before sending, keys, tokens, passwords, email addresses, phone numbers and web-address queries are replaced. A message that looks like a credential, or needs two or more replacements, is not sent at all.',
      'The log keeps a message id, scores and the name of the matched task or sprint, never the message text.',
    ],
    recommended: { provider: 'deepseek', model: 'deepseek-chat', reason: 'Lowest cost for reading short messages and picking a label. This is a cost recommendation only: any provider you have linked works.' },
    ready: false,
    modes: [
      { id: 'suggest', label: 'Suggest only (shadow): shows what it would do, changes nothing' },
      // 'automatic' (Automatic, with Undo) is added only when a record shows a backtest passed for this feature, provider and model.
      // No such record exists yet (1 Nov 2026), so the server accepts only 'suggest'.
    ],
  },
];

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function featureById(id: string, features: ModelFeature[] = FEATURES): ModelFeature | undefined {
  return features.find((f) => f.id === id);
}

/** Problems with a catalog, as plain sentences. A test runs this on FEATURES, so a bad entry cannot be merged. */
export function validateRegistry(features: ModelFeature[] = FEATURES, providers: Provider[] = PROVIDERS): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(f.id)) problems.push(`"${f.id}": the id must be lower-case words joined by hyphens`);
    if (seen.has(f.id)) problems.push(`"${f.id}": the id is used twice`);
    seen.add(f.id);
    if (!f.name.trim()) problems.push(`"${f.id}": no name`);
    if (!f.dataSent.length || f.dataSent.some((line) => !line.trim())) problems.push(`"${f.id}": dataSent is empty. Say what the feature sends.`);
    if (!f.recommended.reason.trim()) problems.push(`"${f.id}": the recommendation has no reason`);
    if (!providers.some((p) => p.id === f.recommended.provider)) problems.push(`"${f.id}": the recommended provider "${f.recommended.provider}" is not a known provider`);
    if (!f.recommended.model.trim()) problems.push(`"${f.id}": the recommendation names no model`);
    for (const m of f.modes ?? []) if (!m.id.trim() || !m.label.trim() || m.id === 'off') problems.push(`"${f.id}": a mode needs an id and a label, and "off" is the switch, not a mode`);
  }
  return problems;
}
