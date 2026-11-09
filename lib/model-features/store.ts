/**
 * The person's choice for each model feature: .AppData/model-features.json
 *   { "<feature id>": { "enabled": bool, "model": { "provider": string, "id": string } | null, "mode"?: string } }
 * Nothing is on by default and no provider is a default. A damaged file is an error (readJsonFileStrict keeps a copy), never "empty".
 */
import path from 'path';
import { DataPaths } from '../data-paths';
import { readJsonFileStrict, writeJsonFile, withFileLock } from '../data-io';

export interface FeatureChoice {
  enabled: boolean;
  model: { provider: string; id: string } | null;
  mode?: string;
}

export type FeatureSettings = Record<string, FeatureChoice>;

export const OFF: FeatureChoice = { enabled: false, model: null };

export function settingsFile(): string {
  return path.join(path.dirname(DataPaths.dashboardAuth), 'model-features.json');
}

function text(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null;
}

function clean(raw: unknown): FeatureChoice {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const m = (r.model && typeof r.model === 'object' ? r.model : {}) as Record<string, unknown>;
  const provider = text(m.provider, 60);
  const id = text(m.id);
  const mode = text(r.mode, 40);
  return { enabled: r.enabled === true, model: provider && id ? { provider, id } : null, ...(mode ? { mode } : {}) };
}

export async function readSettings(file = settingsFile()): Promise<FeatureSettings> {
  const data = await readJsonFileStrict<Record<string, unknown>>(file, {});
  const out: FeatureSettings = {};
  for (const [id, raw] of Object.entries(data ?? {})) out[id] = clean(raw);
  return out;
}

export async function choiceFor(id: string, file = settingsFile()): Promise<FeatureChoice> {
  return (await readSettings(file))[id] ?? OFF;
}

/** Change one feature under a file lock, so two saves at once cannot lose each other. */
export async function saveChoice(id: string, choice: FeatureChoice, file = settingsFile()): Promise<FeatureChoice> {
  return withFileLock(file, async () => {
    const settings = await readSettings(file);
    settings[id] = clean(choice);
    await writeJsonFile(file, settings);
    return settings[id];
  });
}
