import { describe, it, expect } from 'vitest';
import {
  MODEL_FEATURE_COPY,
  confirmLabel,
  confirmLevelLabel,
  decodeChoice,
  encodeChoice,
  groupByProvider,
  initialCardState,
  isLocalChoice,
  levelRank,
  nextCardState,
  optionLabel,
  saveIntent,
  sameModel,
  sendsIntro,
  startLevel,
  statusLine,
  takeIntent,
  toggleIsOn,
  type CardEvent,
  type CardState,
  type ModelFeatureInfo,
  type ModelOption,
} from '@/lib/model-feature-card';

const feature = (over: Partial<ModelFeatureInfo> = {}): ModelFeatureInfo => ({
  id: 'demo',
  name: 'Demo feature',
  enabled: false,
  active: null,
  recommended: { provider: 'alpha', model: 'a-small', reason: 'It costs the least.' },
  dataSent: ['The text of your notes.'],
  keyConfigured: false,
  ...over,
});

const LEVELS = [
  { id: 'suggest', label: 'Suggest only', description: 'It shows suggestions.' },
  { id: 'auto', label: 'Automatic, with Undo', description: 'It acts and you can undo.' },
];

const A = { provider: 'alpha', model: 'a-small' };
const B = { provider: 'beta', model: 'b-large' };

const run = (events: CardEvent[], from: CardState = initialCardState(feature())) => events.reduce(nextCardState, from);
const saved = (over: Partial<ModelFeatureInfo>): CardEvent => ({ type: 'result', result: { ok: true, feature: feature(over) } });

describe('a feature starts off with nothing chosen', () => {
  it('shows no model and sends nothing', () => {
    const s = initialCardState(feature());
    expect(s).toMatchObject({ enabled: false, active: null, choice: null, stage: 'idle', level: null });
    expect(statusLine(s)).toBe(MODEL_FEATURE_COPY.offNoModel);
    expect(toggleIsOn(s)).toBe(false);
  });
  it('shows the active model of a feature that is on', () => {
    const s = initialCardState(feature({ enabled: true, active: A }));
    expect(statusLine(s)).toBe('Active model: a-small (alpha).');
    expect(toggleIsOn(s)).toBe(true);
  });
});

describe('switching on', () => {
  it('asks for a model first and sends nothing', () => {
    const s = run([{ type: 'toggle', on: true }]);
    expect(s.stage).toBe('need-model');
    expect(s.request).toBeNull();
  });

  it('asks for one confirm click, then saves the chosen model', () => {
    let s = run([{ type: 'choose', choice: A }, { type: 'toggle', on: true }]);
    expect(s.stage).toBe('confirm');
    expect(s.request).toBeNull();
    s = nextCardState(s, { type: 'confirm' });
    expect(s.stage).toBe('saving');
    expect(s.request).toEqual({ enabled: true, provider: 'alpha', model: 'a-small' });
  });

  it('does nothing on confirm when no confirm is waiting', () => {
    const s = initialCardState(feature());
    expect(nextCardState(s, { type: 'confirm' })).toBe(s);
    const chosen = nextCardState(s, { type: 'choose', choice: A });
    expect(chosen.stage).toBe('idle');
    expect(nextCardState(chosen, { type: 'confirm' })).toBe(chosen);
  });

  it('applies the result and shows the active model', () => {
    const s = run([
      { type: 'choose', choice: A },
      { type: 'toggle', on: true },
      { type: 'confirm' },
      saved({ enabled: true, active: A, keyConfigured: true }),
    ]);
    expect(s).toMatchObject({ enabled: true, active: A, stage: 'idle', request: null });
  });

  it('cancels from the confirm step and keeps the choice', () => {
    const s = run([{ type: 'choose', choice: A }, { type: 'toggle', on: true }, { type: 'cancel' }]);
    expect(s).toMatchObject({ stage: 'idle', enabled: false, choice: A });
  });

  it('stays off when the server refuses because the key is missing', () => {
    const s = run([
      { type: 'choose', choice: A },
      { type: 'toggle', on: true },
      { type: 'confirm' },
      { type: 'result', result: { ok: false, code: 'KEY_MISSING', provider: 'alpha', linkUrl: '/connections?provider=alpha' } },
    ]);
    expect(s).toMatchObject({ stage: 'key-missing', enabled: false, keyMissing: { provider: 'alpha', linkUrl: '/connections?provider=alpha' } });
    expect(toggleIsOn(s)).toBe(false);
  });

  it('shows an error and lets the person try again', () => {
    let s = run([
      { type: 'choose', choice: A },
      { type: 'toggle', on: true },
      { type: 'confirm' },
      { type: 'result', result: { ok: false, code: 'ERROR', message: 'The server did not answer.' } },
    ]);
    expect(s).toMatchObject({ stage: 'error', error: 'The server did not answer.', enabled: false });
    s = nextCardState(s, { type: 'retry' });
    expect(s.stage).toBe('idle');
  });

  it('ignores an answer that arrives when nothing is being saved', () => {
    const s = initialCardState(feature());
    expect(nextCardState(s, saved({ enabled: true, active: A }))).toBe(s);
  });

  it('ignores clicks while saving', () => {
    const s = run([{ type: 'choose', choice: A }, { type: 'toggle', on: true }, { type: 'confirm' }]);
    expect(nextCardState(s, { type: 'toggle', on: false })).toBe(s);
    expect(nextCardState(s, { type: 'choose', choice: B })).toBe(s);
    expect(nextCardState(s, { type: 'toggle', on: true })).toBe(s);
  });
});

describe('switching off and changing the model', () => {
  const on = () => initialCardState(feature({ enabled: true, active: A }));

  it('switches off at once with no confirm, and keeps the model', () => {
    const s = nextCardState(on(), { type: 'toggle', on: false });
    expect(s.stage).toBe('saving');
    expect(s.request).toEqual({ enabled: false, provider: 'alpha', model: 'a-small' });
  });

  it('does not save when the feature is already off', () => {
    const off = initialCardState(feature());
    expect(nextCardState(off, { type: 'toggle', on: false }).stage).toBe('idle');
  });

  it('asks again when the model of a feature that is on changes', () => {
    const s = nextCardState(on(), { type: 'choose', choice: B });
    expect(s).toMatchObject({ stage: 'confirm', choice: B });
    expect(nextCardState(s, { type: 'confirm' }).request).toEqual({ enabled: true, provider: 'beta', model: 'b-large' });
  });

  it('does not ask when the same model is chosen again', () => {
    expect(nextCardState(on(), { type: 'choose', choice: A }).stage).toBe('idle');
  });

  it('puts the active model back when the change is cancelled', () => {
    const s = run([{ type: 'choose', choice: B }, { type: 'cancel' }], on());
    expect(s).toMatchObject({ choice: A, stage: 'idle', enabled: true });
  });

  it('ignores a second toggle on while already on', () => {
    const s = on();
    expect(nextCardState(s, { type: 'toggle', on: true })).toBe(s);
  });
});

describe('coming back from the key page', () => {
  it('applies the switch-on the person confirmed before they left', () => {
    const s = nextCardState(initialCardState(feature()), { type: 'resume', choice: A, level: null });
    expect(s.stage).toBe('saving');
    expect(s.request).toEqual({ enabled: true, provider: 'alpha', model: 'a-small' });
  });
  it('does nothing when the feature is already on', () => {
    const s = initialCardState(feature({ enabled: true, active: A }));
    expect(nextCardState(s, { type: 'resume', choice: B, level: null })).toBe(s);
  });
  it('keeps the level the person had chosen', () => {
    const s = nextCardState(initialCardState(feature({ levels: LEVELS })), { type: 'resume', choice: A, level: 'auto' });
    expect(s.request).toEqual({ enabled: true, provider: 'alpha', model: 'a-small', level: 'auto' });
  });
});

describe('levels', () => {
  const withLevels = (over: Partial<ModelFeatureInfo> = {}) => initialCardState(feature({ levels: LEVELS, ...over }));

  it('starts at the least automatic level', () => {
    expect(withLevels().level).toBe('suggest');
    expect(startLevel(feature({ levels: LEVELS }))).toBe('suggest');
  });
  it('has no level for a feature without levels', () => {
    expect(startLevel(feature())).toBeNull();
    expect(startLevel(feature({ levels: [] }))).toBeNull();
  });
  it('ignores a level the list does not hold', () => {
    expect(startLevel(feature({ levels: LEVELS, level: 'mystery' }))).toBe('suggest');
  });
  it('sends the first level on the first switch-on', () => {
    const s = run(
      [{ type: 'choose', choice: A }, { type: 'toggle', on: true }, { type: 'confirm' }],
      withLevels(),
    );
    expect(s.request).toEqual({ enabled: true, provider: 'alpha', model: 'a-small', level: 'suggest' });
  });
  it('lets the person pick the level before the first confirm', () => {
    const s = run(
      [{ type: 'choose', choice: A }, { type: 'toggle', on: true }, { type: 'set-level', id: 'auto' }, { type: 'confirm' }],
      withLevels(),
    );
    expect(s.request).toMatchObject({ level: 'auto' });
  });
  it('changes the level of a feature that is off without asking', () => {
    const s = nextCardState(withLevels(), { type: 'set-level', id: 'auto' });
    expect(s).toMatchObject({ level: 'auto', stage: 'idle', request: null });
  });
  it('asks before it becomes more automatic', () => {
    const s = nextCardState(withLevels({ enabled: true, active: A, level: 'suggest' }), { type: 'set-level', id: 'auto' });
    expect(s).toMatchObject({ stage: 'confirm', level: 'auto' });
    expect(nextCardState(s, { type: 'confirm' }).request).toMatchObject({ enabled: true, level: 'auto' });
  });
  it('lowers the level at once with no confirm', () => {
    const s = nextCardState(withLevels({ enabled: true, active: A, level: 'auto' }), { type: 'set-level', id: 'suggest' });
    expect(s.stage).toBe('saving');
    expect(s.request).toEqual({ enabled: true, provider: 'alpha', model: 'a-small', level: 'suggest' });
  });
  it('puts the level back when the change is cancelled', () => {
    const s = run([{ type: 'set-level', id: 'auto' }, { type: 'cancel' }], withLevels({ enabled: true, active: A, level: 'suggest' }));
    expect(s).toMatchObject({ level: 'suggest', stage: 'idle' });
  });
  it('shows the mode in the status line', () => {
    expect(statusLine(withLevels({ enabled: true, active: A, level: 'auto' }))).toBe(
      'Active model: a-small (alpha). Mode: Automatic, with Undo.',
    );
  });
  it('takes the saved level from the server answer', () => {
    const s = run(
      [{ type: 'set-level', id: 'auto' }, { type: 'choose', choice: A }, { type: 'toggle', on: true }, { type: 'confirm' }, saved({ enabled: true, active: A, levels: LEVELS, level: 'auto' })],
      withLevels(),
    );
    expect(s).toMatchObject({ level: 'auto', activeLevel: 'auto', enabled: true });
  });
  it('ignores a level event on a feature without levels', () => {
    const s = initialCardState(feature());
    expect(nextCardState(s, { type: 'set-level', id: 'auto' })).toBe(s);
  });
  it('ranks levels by position', () => {
    expect(levelRank(LEVELS, 'suggest')).toBe(0);
    expect(levelRank(LEVELS, 'auto')).toBe(1);
    expect(levelRank(LEVELS, 'nope')).toBe(-1);
    expect(levelRank(LEVELS, null)).toBe(-1);
  });
  it('words the confirm button for a level change', () => {
    expect(confirmLevelLabel(LEVELS, 'auto')).toBe('Change to Automatic, with Undo');
  });
});

describe('model options', () => {
  const options: ModelOption[] = [
    { provider: 'alpha', model: 'a-small' },
    { provider: 'beta', model: 'b-large' },
    { provider: 'alpha', model: 'a-big', label: 'Big A' },
    { provider: 'ollama', model: 'tiny', local: true },
  ];

  it('groups by provider in the order they first appear', () => {
    expect(groupByProvider(options).map((g) => [g.provider, g.options.length])).toEqual([
      ['alpha', 2],
      ['beta', 1],
      ['ollama', 1],
    ]);
  });
  it('round-trips a choice through the selector value', () => {
    expect(decodeChoice(encodeChoice(A))).toEqual(A);
    expect(decodeChoice(encodeChoice(null))).toBeNull();
    expect(decodeChoice('garbage')).toBeNull();
  });
  it('keeps a model name that holds a slash or a colon', () => {
    const odd = { provider: 'p', model: 'org/name:7b' };
    expect(decodeChoice(encodeChoice(odd))).toEqual(odd);
  });
  it('labels a local model', () => {
    expect(optionLabel(options[3])).toBe('tiny (stays on this computer)');
    expect(optionLabel(options[2])).toBe('Big A');
    expect(optionLabel(options[0])).toBe('a-small');
  });
  it('says a local model keeps the data on this computer, and a remote one names the provider', () => {
    expect(isLocalChoice(options, { provider: 'ollama', model: 'tiny' })).toBe(true);
    expect(isLocalChoice(options, A)).toBe(false);
    expect(isLocalChoice(options, null)).toBe(false);
    expect(isLocalChoice(options, { provider: 'ollama', model: 'unknown' })).toBe(false);
    expect(sendsIntro(options, { provider: 'ollama', model: 'tiny' })).toBe(MODEL_FEATURE_COPY.sendsLocal);
    expect(sendsIntro(options, B)).toContain('beta');
    expect(sendsIntro(options, null)).toBe(MODEL_FEATURE_COPY.sendsBefore);
  });
  it('words the confirm button by where the data goes', () => {
    expect(confirmLabel(options, { provider: 'ollama', model: 'tiny' })).toBe(MODEL_FEATURE_COPY.confirmLocal);
    expect(confirmLabel(options, B)).toBe('Switch on and send this to beta');
  });
  it('compares two models by provider and name', () => {
    expect(sameModel(A, { ...A })).toBe(true);
    expect(sameModel(A, B)).toBe(false);
    expect(sameModel(A, { provider: 'alpha', model: 'other' })).toBe(false);
    expect(sameModel(null, A)).toBe(false);
  });
});

describe('intent kept across the key page', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };

  it('saves, takes once, then forgets', () => {
    const st = memory();
    saveIntent(st, 'demo', B, 'auto');
    expect(takeIntent(st, 'demo')).toEqual({ choice: B, level: 'auto' });
    expect(takeIntent(st, 'demo')).toBeNull();
  });
  it('keeps features apart', () => {
    const st = memory();
    saveIntent(st, 'one', A);
    expect(takeIntent(st, 'two')).toBeNull();
    expect(takeIntent(st, 'one')).toEqual({ choice: A, level: null });
  });
  it('treats damaged data as no intent', () => {
    const st = memory();
    st.setItem('openflow.modelFeature.intent.demo', '{not json');
    expect(takeIntent(st, 'demo')).toBeNull();
    st.setItem('openflow.modelFeature.intent.demo', JSON.stringify({ provider: 'x' }));
    expect(takeIntent(st, 'demo')).toBeNull();
  });
  it('works when storage is blocked', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(() => saveIntent(blocked, 'demo', A)).not.toThrow();
    expect(takeIntent(blocked, 'demo')).toBeNull();
    expect(takeIntent(null, 'demo')).toBeNull();
  });
});

describe('wording', () => {
  const sentences = (): string[] => {
    const out: string[] = [];
    for (const v of Object.values(MODEL_FEATURE_COPY)) {
      out.push(typeof v === 'function' ? (v as (...a: unknown[]) => string)({ provider: 'P', model: 'M', reason: 'R' }) : v);
    }
    return out;
  };
  it('uses no semicolons', () => {
    for (const t of sentences()) expect(t).not.toContain(';');
  });
  it('writes the missing key message the way Liam asked', () => {
    expect(MODEL_FEATURE_COPY.keyMissing('DeepSeek')).toBe('This feature needs an API key for DeepSeek.');
  });
  it('says the recommendation is about cost and that any provider works', () => {
    expect(MODEL_FEATURE_COPY.recommendedNote).toMatch(/cost/);
    expect(MODEL_FEATURE_COPY.recommendedNote).toMatch(/any provider/);
  });
  it('names no provider in the fixed wording', () => {
    for (const t of sentences()) expect(t).not.toMatch(/deepseek|openai|anthropic|claude|gemini|grok/i);
  });
});

describe('a feature that is not ready', () => {
  const notReady = () => initialCardState(feature({ ready: false }));
  it('says it is not available and cannot be switched on', () => {
    const s = notReady();
    expect(statusLine(s)).toBe(MODEL_FEATURE_COPY.notAvailable);
    const chosen = nextCardState(s, { type: 'choose', choice: A });
    expect(nextCardState(chosen, { type: 'toggle', on: true })).toBe(chosen);
  });
  it('treats a missing ready flag as ready', () => {
    expect(initialCardState(feature()).ready).toBe(true);
  });
  it('shows the server refusal and stops offering the switch', () => {
    const s = run([
      { type: 'choose', choice: A },
      { type: 'toggle', on: true },
      { type: 'confirm' },
      { type: 'result', result: { ok: false, code: 'NOT_READY' } },
    ]);
    expect(s).toMatchObject({ ready: false, stage: 'error', error: MODEL_FEATURE_COPY.notReadyDetail, enabled: false });
  });
  it('can still be switched off if it was on', () => {
    const s = initialCardState(feature({ ready: false, enabled: true, active: A }));
    expect(nextCardState(s, { type: 'toggle', on: false }).stage).toBe('saving');
  });
});
