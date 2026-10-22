/** Persisted harness sign-in state: .AppData/harness-auth.json (credential states and which alerts have already been sent). */
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { DataPaths } from '@/lib/data-paths';
import { emptyStore, type Store } from './model';

const file = () => `${DataPaths.base}/harness-auth.json`;

export async function readStore(): Promise<Store> {
  const data = await readJsonFile<Partial<Store>>(file(), emptyStore());
  return { credentials: data.credentials ?? {}, alerts: data.alerts ?? {}, accounts: data.accounts ?? {} };
}

/** Read-modify-write under the file lock; `fn` is pure and returns the new store plus whatever the caller needs back. */
export async function updateStore<T>(fn: (store: Store) => { store: Store; result: T }): Promise<T> {
  return withFileLock(file(), async () => {
    const { store, result } = fn(await readStore());
    await writeJsonFile(file(), store);
    return result;
  });
}
