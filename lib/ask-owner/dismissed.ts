/** Browser-local persistence for non-destructively hiding answered Ask-owner cards. */

export const ASK_OWNER_DISMISSED_STORAGE_KEY = 'devflow-ask-owner-dismissed-question-ids';
export const ASK_OWNER_DISMISSED_CHANGE_EVENT = 'devflow:ask-owner-dismissed-change';

const MAX_DISMISSED_QUESTION_IDS = 500;

export function parseDismissedQuestionIds(raw: string | null): Set<string> {
  if (!raw) return new Set();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();

    const ids = parsed.filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    return new Set(ids.slice(-MAX_DISMISSED_QUESTION_IDS));
  } catch {
    return new Set();
  }
}

export function addDismissedQuestionId(current: ReadonlySet<string>, questionId: string): Set<string> {
  const id = questionId.trim();
  if (!id) return new Set(current);

  const next = new Set(current);
  next.delete(id);
  next.add(id);
  return new Set([...next].slice(-MAX_DISMISSED_QUESTION_IDS));
}

export function serializeDismissedQuestionIds(questionIds: ReadonlySet<string>): string {
  return JSON.stringify([...questionIds].slice(-MAX_DISMISSED_QUESTION_IDS));
}

/** Stable serialized snapshot for React.useSyncExternalStore. */
export function readDismissedQuestionIdsSnapshot(): string {
  if (typeof window === 'undefined') return '[]';
  try {
    return localStorage.getItem(ASK_OWNER_DISMISSED_STORAGE_KEY) ?? '[]';
  } catch {
    return '[]';
  }
}

export function subscribeToDismissedQuestionIds(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const handleStorage = (event: StorageEvent) => {
    if (event.key === ASK_OWNER_DISMISSED_STORAGE_KEY) onStoreChange();
  };
  window.addEventListener('storage', handleStorage);
  window.addEventListener(ASK_OWNER_DISMISSED_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(ASK_OWNER_DISMISSED_CHANGE_EVENT, onStoreChange);
  };
}

export function notifyDismissedQuestionIdsChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(ASK_OWNER_DISMISSED_CHANGE_EVENT));
  }
}
