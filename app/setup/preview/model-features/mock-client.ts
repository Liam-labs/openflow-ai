import type { ModelFeatureClient, ModelFeatureInfo, ModelOption } from '@/lib/model-feature-card';

/** Pretend backend for the preview page. The real routes are in `app/api/model-features`. */
export type PreviewScenario = 'normal' | 'not-ready' | 'slow';

const REC = { provider: 'alpha', model: 'alpha-small', reason: 'Lowest cost for short text. This is a cost recommendation only. Any provider you have works.' };

const OPTIONS: ModelOption[] = [
  { provider: 'alpha', model: 'alpha-small', label: 'Alpha Small' },
  { provider: 'alpha', model: 'alpha-large', label: 'Alpha Large' },
  { provider: 'beta', model: 'beta-one', label: 'Beta One' },
  { provider: 'local', model: 'llama-tiny', label: 'Llama Tiny', local: true },
];

const FEATURES: ModelFeatureInfo[] = [
  {
    id: 'knowledge-update',
    name: 'Automatic knowledge-base updates',
    enabled: false,
    active: null,
    recommended: REC,
    dataSent: ['The text of the notes and documents you add to the knowledge base.', 'Nothing else from your computer. No files that you did not add.'],
    keyConfigured: false,
  },
  {
    id: 'overwatch',
    name: 'Overwatch: keep the board up to date from messages',
    enabled: false,
    active: null,
    recommended: { ...REC, reason: 'Lowest cost for reading short messages. This is a cost recommendation only. Any provider you have works.' },
    dataSent: ['The text of each message posted in the channels it watches.', 'The few messages just before it, and the titles of the open tasks.', 'Channel messages are sent to the provider you choose. A local model keeps them on this computer.'],
    keyConfigured: false,
    levels: [
      { id: 'suggest', label: 'Suggest only (shadow)', description: 'It shows what it would do and changes nothing.' },
      { id: 'automatic', label: 'Automatic, with Undo', description: 'Only high-confidence cases act, and every action has an Undo.' },
    ],
    level: null,
  },
];

export function makePreviewClient(scenario: PreviewScenario, linked: string[]): ModelFeatureClient {
  const state = new Map(FEATURES.map((f) => [f.id, { ...f, ready: scenario !== 'not-ready' }]));
  const delay = () => new Promise((r) => setTimeout(r, scenario === 'slow' ? 1500 : 150));
  return {
    async load(id) {
      await delay();
      const feature = state.get(id);
      if (!feature) throw new Error('no such feature');
      return { feature: { ...feature }, options: OPTIONS, linkedProviders: linked };
    },
    async update(id, request) {
      await delay();
      const feature = state.get(id);
      if (!feature) return { ok: false, code: 'ERROR', message: 'No such feature.' };
      if (request.enabled) {
        if (feature.ready === false) return { ok: false, code: 'NOT_READY' };
        const isLocal = OPTIONS.some((o) => o.local && o.provider === request.provider);
        if (!isLocal && !linked.includes(request.provider ?? '')) {
          const back = encodeURIComponent('/setup/preview/model-features');
          return {
            ok: false,
            code: 'KEY_MISSING',
            provider: request.provider ?? '',
            linkUrl: `/setup/preview/model-features?linked=${request.provider}&resume=${id}&returnTo=${back}`,
          };
        }
      }
      const model = request.provider && request.model ? { provider: request.provider, model: request.model } : feature.active;
      const next = { ...feature, enabled: request.enabled, active: model, ...(feature.levels ? { level: request.level ?? feature.level ?? null } : {}), keyConfigured: true };
      state.set(id, next);
      return { ok: true, feature: { ...next } };
    },
  };
}
