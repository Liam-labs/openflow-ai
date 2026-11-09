/**
 * What feature code calls to learn which model to use. Feature code has no provider name written in it.
 * It never falls back to another provider: a feature that is off, or whose key is missing, does nothing and says why.
 */
import { resolveSecretStore } from '../secret-store';
import { featureById, providerById, FEATURES, type ModelFeature } from './registry';
import { choiceFor } from './store';

export class FeatureOff extends Error {
  constructor(readonly featureId: string) {
    super(`The feature "${featureId}" is switched off.`);
    this.name = 'FeatureOff';
  }
}

export class KeyMissing extends Error {
  constructor(readonly featureId: string, readonly provider: string) {
    super(`This feature needs an API key for ${provider}.`);
    this.name = 'KeyMissing';
  }
}

export function keyConfigured(providerId: string, env: Record<string, string | undefined> = process.env, names: () => string[] = () => resolveSecretStore().names()): boolean {
  const provider = providerById(providerId);
  if (!provider) return false;
  if (!provider.secretName) return true;                       // a local model needs no key
  return names().includes(provider.secretName) || !!(env[provider.secretName] || '').trim();
}

export async function resolveFeatureModel(id: string, opts: { features?: ModelFeature[]; file?: string; hasKey?: (provider: string) => boolean } = {}): Promise<{ provider: string; model: string; mode?: string }> {
  const feature = featureById(id, opts.features ?? FEATURES);
  if (!feature) throw new FeatureOff(id);
  const choice = await choiceFor(id, opts.file);
  if (!feature.ready || !choice.enabled || !choice.model) throw new FeatureOff(id);
  if (!(opts.hasKey ?? ((p) => keyConfigured(p)))(choice.model.provider)) throw new KeyMissing(id, choice.model.provider);
  return { provider: choice.model.provider, model: choice.model.id, ...(choice.mode ? { mode: choice.mode } : {}) };
}
