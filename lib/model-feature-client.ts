/**
 * Talks to the model feature routes and turns their answers into the shapes ModelFeatureCard uses.
 * Every difference between the two lives here: the server says `id` where the card says `model`,
 * and `mode` where the card says `level`. The routes are McKay's. See docs/model-features.md.
 */
import type {
  FeatureLevel,
  ModelFeatureClient,
  ModelFeatureData,
  ModelFeatureInfo,
  ModelOption,
  Recommendation,
  UpdateRequest,
  UpdateResult,
} from '@/lib/model-feature-card';

export interface ServerModelRef {
  provider: string;
  id: string;
}

export interface ServerFeature {
  id: string;
  name: string;
  ready: boolean;
  enabled: boolean;
  active: ServerModelRef | null;
  mode: string | null;
  modes: { id: string; label: string }[] | null;
  recommended: Recommendation;
  dataSent: string[];
  keyConfigured: boolean | null;
}

export interface ServerProvider {
  id: string;
  label: string;
  local: boolean;
  linked: boolean;
}

export interface ServerList {
  features: ServerFeature[];
  providers: ServerProvider[];
}

/** One model of the model registry (`GET /api/models`). */
export interface RegistryModel {
  id: string;
  provider: string;
  label?: string;
}

export function featureFromServer(f: ServerFeature): ModelFeatureInfo {
  const levels: FeatureLevel[] | undefined = f.modes?.length ? f.modes.map((m) => ({ id: m.id, label: m.label })) : undefined;
  return {
    id: f.id,
    name: f.name,
    ready: f.ready,
    enabled: f.enabled,
    active: f.active ? { provider: f.active.provider, model: f.active.id } : null,
    recommended: f.recommended,
    dataSent: f.dataSent,
    keyConfigured: f.keyConfigured === true,
    ...(levels ? { levels, level: f.mode } : {}),
  };
}

/**
 * The selector options: every registry model of a provider the server knows, then the recommended
 * model if the registry does not hold it. A provider the server does not know is left out, because the
 * server would refuse it.
 */
export function optionsFromModels(models: RegistryModel[], providers: ServerProvider[], recommended: Recommendation): ModelOption[] {
  const known = new Map(providers.map((p) => [p.id, p]));
  const options: ModelOption[] = [];
  for (const m of models) {
    const p = known.get(m.provider);
    if (!p) continue;
    options.push({ provider: m.provider, model: m.id, label: m.label, ...(p.local ? { local: true } : {}) });
  }
  const rec = known.get(recommended.provider);
  if (rec && !options.some((o) => o.provider === recommended.provider && o.model === recommended.model)) {
    options.push({ provider: recommended.provider, model: recommended.model, ...(rec.local ? { local: true } : {}) });
  }
  return options;
}

/** The page to come back to after the key page. It is this page without the resume marker. */
export function returnToFor(location: { pathname: string; search: string }): string {
  const params = new URLSearchParams(location.search);
  params.delete('resume');
  params.delete('returnTo');
  params.delete('provider');
  const query = params.toString();
  return query ? `${location.pathname}?${query}` : location.pathname;
}

export function requestToServer(request: UpdateRequest, returnTo: string | null): Record<string, unknown> {
  return {
    enabled: request.enabled,
    model: request.provider && request.model ? { provider: request.provider, id: request.model } : null,
    ...(request.level ? { mode: request.level } : {}),
    ...(returnTo ? { returnTo } : {}),
  };
}

interface ErrorBody {
  error?: unknown;
  code?: unknown;
  provider?: unknown;
  linkUrl?: unknown;
}

/** The result of a PUT. `reload` reads the feature again, because the PUT answer is not the whole feature. */
export async function resultFromResponse(
  status: number,
  body: ErrorBody,
  reload: () => Promise<ModelFeatureInfo>,
): Promise<UpdateResult> {
  if (status >= 200 && status < 300) {
    try {
      return { ok: true, feature: await reload() };
    } catch {
      return { ok: false, code: 'ERROR', message: 'It was saved, but the screen could not read it back.' };
    }
  }
  if (status === 409 && body.code === 'KEY_MISSING' && typeof body.provider === 'string' && typeof body.linkUrl === 'string') {
    return { ok: false, code: 'KEY_MISSING', provider: body.provider, linkUrl: body.linkUrl };
  }
  if (status === 409 && body.code === 'FEATURE_NOT_READY') return { ok: false, code: 'NOT_READY' };
  const message = typeof body.error === 'string' && body.error ? body.error : 'The server refused it.';
  return { ok: false, code: 'ERROR', message };
}

/** The client the real screens use. A test or the preview passes its own `fetch`. */
export function makeHttpClient(
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  currentLocation: () => { pathname: string; search: string } | null = () => (typeof window === 'undefined' ? null : window.location),
): ModelFeatureClient {
  const readList = async (): Promise<ServerList> => {
    const res = await fetchImpl('/api/model-features');
    if (!res.ok) throw new Error('list failed');
    return (await res.json()) as ServerList;
  };
  const readModels = async (): Promise<RegistryModel[]> => {
    try {
      const res = await fetchImpl('/api/models');
      if (!res.ok) return [];
      const json = (await res.json()) as { models?: RegistryModel[] };
      return Array.isArray(json.models) ? json.models : [];
    } catch {
      return [];
    }
  };
  const load = async (id: string): Promise<ModelFeatureData> => {
    const [list, models] = await Promise.all([readList(), readModels()]);
    const raw = list.features.find((f) => f.id === id);
    if (!raw) throw new Error('no such feature');
    return {
      feature: featureFromServer(raw),
      options: optionsFromModels(models, list.providers, raw.recommended),
      linkedProviders: list.providers.filter((p) => p.linked).map((p) => p.id),
    };
  };
  return {
    load,
    async update(id, request) {
      const loc = currentLocation();
      const res = await fetchImpl(`/api/model-features/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestToServer(request, loc ? returnToFor(loc) : null)),
      });
      const body = (await res.json().catch(() => ({}))) as ErrorBody;
      return resultFromResponse(res.status, body, async () => (await load(id)).feature);
    },
  };
}
