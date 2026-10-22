/**
 * The provider names for the Models page filter.
 *
 * GET /api/models answers `providers` as an object (each provider's sign-in state), but the page wanted a list of names, so the
 * whole tab failed with "i.map is not a function" (found 22 Oct 2026, on the live DevFlow too). Names come from the response when
 * it carries a list, from the keys of the provider object, and always from the models themselves; sorted, no repeats, no blanks.
 */
export function providerNames(response: { models?: Array<{ provider?: string }>; providers?: unknown }): string[] {
  const names = new Set<string>();
  const given = response.providers;
  if (Array.isArray(given)) given.forEach(name => typeof name === 'string' && name && names.add(name));
  else if (given && typeof given === 'object') Object.keys(given).forEach(name => name && names.add(name));
  (response.models ?? []).forEach(model => model.provider && names.add(model.provider));
  return [...names].sort();
}
