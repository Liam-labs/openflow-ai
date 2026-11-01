/**
 * Logic and wording for ModelFeatureCard, the one screen every model-using feature reuses.
 *
 * The rule behind it: a feature is off until the person turns it on, no provider is a default,
 * the recommendation is shown and never applied, and the person sees exactly what is sent before
 * anything leaves the machine. No provider name is written in this file. Providers and models
 * come from the server.
 */

// ─── What the screen reads and writes (the server side is McKay's) ──────────

export interface ModelRef {
  provider: string;
  model: string;
}

export interface Recommendation extends ModelRef {
  reason: string;
}

/** How automatic a feature is, for features that act on their own. The list runs from least to most automatic. */
export interface FeatureLevel {
  id: string;
  label: string;
  description?: string;
}

export interface ModelFeatureInfo {
  id: string;
  name: string;
  enabled: boolean;
  active: ModelRef | null;
  recommended: Recommendation;
  /** Plain sentences: exactly what leaves the machine. */
  dataSent: string[];
  keyConfigured: boolean;
  /** False until the feature's owner has checked what it sends. The server refuses to switch it on. Missing means ready. */
  ready?: boolean;
  /** Set only for features that act on their own. The first level is where a first switch-on starts. */
  levels?: FeatureLevel[];
  level?: string | null;
}

export interface ModelOption extends ModelRef {
  label?: string;
  /** The model runs on this computer, so nothing is sent to a provider and no key is needed. */
  local?: boolean;
}

/** Everything the card needs to draw one feature. The client builds it from the server answer. */
export interface ModelFeatureData {
  feature: ModelFeatureInfo;
  options: ModelOption[];
  linkedProviders: string[];
}

export interface ModelFeatureClient extends ModelFeatureService {
  load(id: string): Promise<ModelFeatureData>;
}

export interface UpdateRequest {
  enabled: boolean;
  level?: string;
  provider?: string;
  model?: string;
}

export type UpdateResult =
  | { ok: true; feature: ModelFeatureInfo }
  | { ok: false; code: 'KEY_MISSING'; provider: string; linkUrl: string }
  | { ok: false; code: 'NOT_READY' }
  | { ok: false; code: 'ERROR'; message: string };

export interface ModelFeatureService {
  update(id: string, request: UpdateRequest): Promise<UpdateResult>;
}

// ─── Card state ─────────────────────────────────────────────────────────────

export type CardStage = 'idle' | 'need-model' | 'confirm' | 'saving' | 'key-missing' | 'error';

export interface CardState {
  /** False when the feature cannot be switched on yet. */
  ready: boolean;
  /** What the server says. */
  enabled: boolean;
  active: ModelRef | null;
  /** What the selector shows. Nothing is chosen until the person chooses. */
  choice: ModelRef | null;
  /** The levels in order, least automatic first. Empty when the feature has none. */
  levels: FeatureLevel[];
  /** The level the selector shows, or null when the feature has no levels. */
  level: string | null;
  /** The level the server has. */
  activeLevel: string | null;
  stage: CardStage;
  /** The request sent while saving. */
  request: UpdateRequest | null;
  keyMissing: { provider: string; linkUrl: string } | null;
  error: string | null;
}

export type CardEvent =
  | { type: 'choose'; choice: ModelRef | null }
  | { type: 'toggle'; on: boolean }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'set-level'; id: string }
  | { type: 'resume'; choice: ModelRef; level: string | null }
  | { type: 'result'; result: UpdateResult }
  | { type: 'retry' };

/** The level a feature shows: the one the server has, else the least automatic, else none. */
export function startLevel(feature: ModelFeatureInfo): string | null {
  if (!feature.levels?.length) return null;
  const known = feature.levels.some((l) => l.id === feature.level);
  return known && feature.level ? feature.level : feature.levels[0].id;
}

export function initialCardState(feature: ModelFeatureInfo): CardState {
  const level = startLevel(feature);
  return {
    ready: feature.ready !== false,
    enabled: feature.enabled,
    active: feature.active,
    choice: feature.active,
    levels: feature.levels ?? [],
    level,
    activeLevel: feature.enabled ? level : null,
    stage: 'idle',
    request: null,
    keyMissing: null,
    error: null,
  };
}

export function sameModel(a: ModelRef | null, b: ModelRef | null): boolean {
  return !!a && !!b && a.provider === b.provider && a.model === b.model;
}

/** Where a level sits in the list. An unknown or missing level ranks below every real one. */
export function levelRank(levels: FeatureLevel[], id: string | null): number {
  return id === null ? -1 : levels.findIndex((l) => l.id === id);
}

const saving = (state: CardState, request: UpdateRequest): CardState => ({
  ...state,
  stage: 'saving',
  request,
  keyMissing: null,
  error: null,
});

/**
 * One step forward. Anything that would send data starts with a confirm click, and nothing is
 * sent before a model is chosen. A late answer on the wrong stage changes nothing.
 */
export function nextCardState(state: CardState, event: CardEvent): CardState {
  switch (event.type) {
    case 'choose': {
      if (state.stage === 'saving') return state;
      // Changing the model of a feature that is on sends data to a new provider, so it asks again.
      if (state.enabled && event.choice && !sameModel(event.choice, state.active)) {
        return { ...state, choice: event.choice, stage: 'confirm', keyMissing: null, error: null };
      }
      return { ...state, choice: event.choice, stage: 'idle', keyMissing: null, error: null };
    }

    case 'toggle': {
      if (state.stage === 'saving') return state;
      if (!event.on) {
        if (!state.enabled) return { ...state, stage: 'idle', keyMissing: null, error: null };
        return saving(state, { enabled: false, ...(state.active ?? {}) });
      }
      if (state.enabled || !state.ready) return state;
      return state.choice
        ? { ...state, stage: 'confirm', keyMissing: null, error: null }
        : { ...state, stage: 'need-model', keyMissing: null, error: null };
    }

    case 'confirm':
      if (state.stage !== 'confirm' || !state.choice) return state;
      return saving(state, {
        enabled: true,
        provider: state.choice.provider,
        model: state.choice.model,
        ...(state.level ? { level: state.level } : {}),
      });

    case 'set-level': {
      if (state.stage === 'saving' || state.level === null) return state;
      if (event.id === state.level) return state;
      if (!state.enabled) return { ...state, level: event.id };
      // Raising how automatic a feature is asks again. Lowering it saves at once.
      const raising = levelRank(state.levels, event.id) > levelRank(state.levels, state.activeLevel);
      if (raising) return { ...state, level: event.id, stage: 'confirm', keyMissing: null, error: null };
      if (!state.active) return state;
      return saving(
        { ...state, level: event.id },
        { enabled: true, provider: state.active.provider, model: state.active.model, level: event.id },
      );
    }

    case 'cancel':
      if (state.stage !== 'confirm' && state.stage !== 'need-model' && state.stage !== 'key-missing') return state;
      return {
        ...state,
        stage: 'idle',
        choice: state.enabled ? state.active : state.choice,
        level: state.enabled ? state.activeLevel : state.level,
        keyMissing: null,
        error: null,
      };

    case 'resume':
      // The person already confirmed before leaving to link the key.
      if (state.enabled || state.stage === 'saving') return state;
      return saving(
        { ...state, choice: event.choice, level: event.level ?? state.level },
        {
          enabled: true,
          provider: event.choice.provider,
          model: event.choice.model,
          ...((event.level ?? state.level) ? { level: (event.level ?? state.level) as string } : {}),
        },
      );

    case 'result': {
      if (state.stage !== 'saving') return state;
      const r = event.result;
      if (r.ok) {
        const level = startLevel(r.feature);
        return {
          ready: r.feature.ready !== false,
          enabled: r.feature.enabled,
          active: r.feature.active,
          choice: r.feature.active ?? state.choice,
          levels: r.feature.levels ?? state.levels,
          level,
          activeLevel: r.feature.enabled ? level : null,
          stage: 'idle',
          request: null,
          keyMissing: null,
          error: null,
        };
      }
      if (r.code === 'NOT_READY') {
        return { ...state, ready: false, stage: 'error', request: null, error: MODEL_FEATURE_COPY.notReadyDetail };
      }
      if (r.code === 'KEY_MISSING') {
        return { ...state, stage: 'key-missing', request: null, keyMissing: { provider: r.provider, linkUrl: r.linkUrl } };
      }
      return { ...state, stage: 'error', request: null, error: r.message };
    }

    case 'retry':
      return state.stage === 'error' ? { ...state, stage: 'idle', error: null } : state;
  }
}

/** Whether the toggle shows as on. It follows the server, never the person's unconfirmed click. */
export function toggleIsOn(state: CardState): boolean {
  return state.enabled;
}

/** The line under the heading. It always says whether anything is being sent. */
export function statusLine(state: CardState): string {
  if (!state.ready && !state.enabled) return MODEL_FEATURE_COPY.notAvailable;
  if (state.enabled && state.active) {
    const level = state.levels.find((l) => l.id === state.activeLevel);
    return level
      ? `${MODEL_FEATURE_COPY.active(state.active)} ${MODEL_FEATURE_COPY.mode(level.label)}`
      : MODEL_FEATURE_COPY.active(state.active);
  }
  return state.choice ? MODEL_FEATURE_COPY.offWithChoice : MODEL_FEATURE_COPY.offNoModel;
}

// ─── Model options ──────────────────────────────────────────────────────────

/** Whether the chosen model runs on this computer. An unknown model counts as not local, so the data warning stays. */
export function isLocalChoice(options: ModelOption[], choice: ModelRef | null): boolean {
  if (!choice) return false;
  return options.some((o) => o.local === true && sameModel(o, choice));
}

/** The label of a model in the selector. */
export function optionLabel(option: ModelOption): string {
  const name = option.label ?? option.model;
  return option.local ? `${name} (${MODEL_FEATURE_COPY.local})` : name;
}

/** The sentence above the list of what is sent. It depends on where the model runs. */
export function sendsIntro(options: ModelOption[], choice: ModelRef | null): string {
  if (!choice) return MODEL_FEATURE_COPY.sendsBefore;
  return isLocalChoice(options, choice)
    ? MODEL_FEATURE_COPY.sendsLocal
    : MODEL_FEATURE_COPY.sendsIntro(choice.provider);
}

/** The label of the confirm button when only the level changes. */
export function confirmLevelLabel(levels: FeatureLevel[], id: string | null): string {
  const level = levels.find((l) => l.id === id);
  return level ? MODEL_FEATURE_COPY.confirmLevel(level.label) : MODEL_FEATURE_COPY.confirmLocal;
}

/** The label of the confirm button. */
export function confirmLabel(options: ModelOption[], choice: ModelRef | null): string {
  if (!choice) return MODEL_FEATURE_COPY.confirmLocal;
  return isLocalChoice(options, choice)
    ? MODEL_FEATURE_COPY.confirmLocal
    : MODEL_FEATURE_COPY.confirm(choice.provider);
}

export interface ProviderGroup {
  provider: string;
  options: ModelOption[];
}

/** Groups the options by provider. Providers keep the order they first appear in. */
export function groupByProvider(options: ModelOption[]): ProviderGroup[] {
  const groups = new Map<string, ModelOption[]>();
  for (const o of options) {
    const list = groups.get(o.provider) ?? [];
    list.push(o);
    groups.set(o.provider, list);
  }
  return [...groups].map(([provider, list]) => ({ provider, options: list }));
}

/** The selector value for a model, and back. The two parts are joined with a character a name never holds. */
export function encodeChoice(choice: ModelRef | null): string {
  return choice ? `${choice.provider}\u0000${choice.model}` : '';
}

export function decodeChoice(value: string): ModelRef | null {
  const [provider, model] = value.split('\u0000');
  return provider && model ? { provider, model } : null;
}

// ─── Coming back from the key page ──────────────────────────────────────────

const INTENT_KEY = (id: string) => `openflow.modelFeature.intent.${id}`;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Remembers what the person asked for, so the switch-on can finish after the key page. */
export interface Intent {
  choice: ModelRef;
  level: string | null;
}

export function saveIntent(storage: StorageLike | null, id: string, choice: ModelRef, level: string | null = null): void {
  try {
    storage?.setItem(INTENT_KEY(id), JSON.stringify({ ...choice, level }));
  } catch {
    /* Storage can be blocked. The person then switches it on again. */
  }
}

/** Reads and clears the remembered request. Returns null when there is none or it is not valid. */
export function takeIntent(storage: StorageLike | null, id: string): Intent | null {
  try {
    const raw = storage?.getItem(INTENT_KEY(id));
    storage?.removeItem(INTENT_KEY(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ModelRef> & { level?: unknown };
    return typeof parsed.provider === 'string' && typeof parsed.model === 'string' && parsed.provider && parsed.model
      ? {
          choice: { provider: parsed.provider, model: parsed.model },
          level: typeof parsed.level === 'string' && parsed.level ? parsed.level : null,
        }
      : null;
  } catch {
    return null;
  }
}

// ─── Wording ────────────────────────────────────────────────────────────────
// Plain sentences, one topic each, no semicolons. No provider is named here.

export const MODEL_FEATURE_COPY = {
  active: (m: ModelRef) => `Active model: ${m.model} (${m.provider}).`,
  notAvailable: 'Not available yet.',
  notAvailableBody: 'Its owner has not yet checked what it sends, so it cannot be switched on.',
  notReadyDetail: 'It cannot be switched on yet. What it sends has not been checked.',
  offNoModel: 'Switched off. No model is chosen. Nothing is sent.',
  offWithChoice: 'Switched off. Nothing is sent.',
  modelLabel: 'Model',
  chooseModel: 'Choose a model',
  recommended: (r: Recommendation) => `Recommended: ${r.model} (${r.provider}). ${r.reason}`,
  recommendedNote: 'We recommend this for cost. You can use any provider you have.',
  useRecommended: 'Use the recommended model',
  needModel: 'Choose a model first. Nothing is sent until you do.',
  sendsTitle: 'What this sends',
  sendsIntro: (provider: string) => `When this is on, OpenFlow sends this to ${provider}:`,
  sendsBefore: 'This is what the feature sends once you choose a model.',
  sendsLocal: 'This stays on this computer:',
  local: 'stays on this computer',
  confirm: (provider: string) => `Switch on and send this to ${provider}`,
  confirmLocal: 'Switch on',
  confirmLevel: (label: string) => `Change to ${label}`,
  mode: (label: string) => `Mode: ${label}.`,
  levelTitle: 'How automatic it is',
  cancel: 'Cancel',
  keyMissing: (provider: string) => `This feature needs an API key for ${provider}.`,
  keyMissingBody: 'You come back to this screen afterwards.',
  addKey: (provider: string) => `Add the key for ${provider}`,
  saving: 'Saving…',
  error: (message: string) => `We could not save this. ${message}`,
  retry: 'Try again',
  loading: 'Loading…',
  loadFailed: 'We could not load this feature.',
  toggleLabel: (name: string) => `Turn on ${name}`,
} as const;
