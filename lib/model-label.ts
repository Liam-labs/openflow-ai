export interface ModelLabelEntry {
  id: string;
  aliases?: string[];
  label?: string;
  apiId?: string;
  capabilities?: { reasoningOnly?: boolean };
}

function capitalize(value: string): string {
  if (!value) return '';
  // Preserve known acronyms: gpt-X → GPT-X
  if (/^gpt/i.test(value)) return value.toUpperCase();
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function getModelLabel(
  modelId: string | undefined | null,
  registry: readonly ModelLabelEntry[]
): string {
  if (!modelId) return '';
  const entry = registry.find(m => m.id === modelId || m.aliases?.includes(modelId));
  // Return the registry label verbatim. The 1M-context distinction belongs in
  // the label itself (e.g. "Opus 4.8 · 1M"), not in an auto-appended "[1m]" —
  // bolting it on produced confusing double-labels like "Opus (1M)[1m]".
  return entry?.label ?? capitalize(modelId);
}

export function isReasoningOnlyModel(
  modelId: string | undefined | null,
  registry: readonly ModelLabelEntry[]
): boolean {
  if (!modelId) return false;
  const entry = registry.find(m => m.id === modelId || m.aliases?.includes(modelId));
  return entry?.capabilities?.reasoningOnly === true;
}
