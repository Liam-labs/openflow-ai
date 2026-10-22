/**
 * The account owner's profile and sidebar layout, kept in `.AppData/account.json`.
 *
 * Server side and in one file, because the browser's storage is per browser and agents cannot read it:
 * the profile feeds every agent's `user-profile.md` (the scaffolding sync reads it through
 * GET /api/account), and the sidebar layout follows the owner to their phone. It is not kept in
 * collab-channels.json, which is the hot path and has its own single write path.
 *
 * The first read creates the file from `data/scaffolding/account-profile-seed.json`. If that seed is
 * missing or invalid, or the file is damaged, nothing is created or overwritten and the caller gets
 * a 503: serving or storing a blank profile would be worse than serving none.
 */

import { promises as fs } from 'fs';
import { appPath } from './app-paths';
import { DataPaths } from './data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from './data-io';
import {
  effectiveSidebarSections,
  mergeCollapsedGroups,
  validateFullProfile,
  validateProfilePatch,
  type AccountPatch,
  type AccountProfile,
  type CollapsedGroups,
  type FieldError,
  type SidebarSection,
} from './account-profile';
import { HUMAN_ROUTING_NAME } from './human-identity';

export interface AccountFile {
  version: 1;
  profile: AccountProfile;
  sidebar: {
    /** Missing means the default layout. */
    sections?: SidebarSection[];
    collapsedGroups?: CollapsedGroups;
  };
  createdAt: string;
  updatedAt: string;
}

/** What GET and PUT /api/account return. */
export interface AccountResponse {
  success: true;
  profile: AccountProfile;
  sidebar: {
    /** Always complete: the stored layout, or the default one. */
    sections: SidebarSection[];
    collapsedGroups: CollapsedGroups;
  };
  /** The name agents address the owner by. The display name never changes it. */
  routingName: string;
  createdAt: string;
  updatedAt: string;
}

export class AccountStoreError extends Error {
  constructor(message: string, readonly status: number = 503) {
    super(message);
    this.name = 'AccountStoreError';
  }
}

function seedPath(): string {
  return appPath('data', 'scaffolding', 'account-profile-seed.json');
}

function firstMessage(errors: readonly FieldError[]): string {
  return errors.map(error => error.message).join(' ');
}

async function readStoredFile(): Promise<AccountFile | null> {
  let text: string;
  try {
    text = await fs.readFile(DataPaths.account, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.error('[Account] account.json could not be read:', error);
    throw new AccountStoreError('The account file could not be read, so nothing was changed.');
  }
  try {
    const parsed = JSON.parse(text) as Partial<AccountFile>;
    const profile = validateFullProfile(parsed.profile);
    if (!profile.ok) throw new Error(firstMessage(profile.errors));
    return {
      version: 1,
      profile: profile.value,
      sidebar: {
        ...(Array.isArray(parsed.sidebar?.sections) ? { sections: effectiveSidebarSections(parsed.sidebar.sections) } : {}),
        ...(parsed.sidebar?.collapsedGroups ? { collapsedGroups: mergeCollapsedGroups(parsed.sidebar.collapsedGroups, {}) } : {}),
      },
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString(),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch (error) {
    console.error('[Account] account.json is damaged:', error instanceof Error ? error.message : error);
    throw new AccountStoreError('The account file is damaged, so it was left as it is. Restore it from a backup.');
  }
}

async function loadSeed(): Promise<AccountProfile> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(seedPath(), 'utf-8'));
  } catch (error) {
    console.error('[Account] starting profile could not be read:', error instanceof Error ? error.message : error);
    throw new AccountStoreError('The starting profile is missing or unreadable, so the account has not been created.');
  }
  const profile = validateFullProfile(raw);
  if (!profile.ok) {
    console.error('[Account] starting profile is invalid:', firstMessage(profile.errors));
    throw new AccountStoreError('The starting profile is invalid, so the account has not been created.');
  }
  return profile.value;
}

/** Create account.json from the seed. Call only while holding the account lock. */
async function createFromSeed(): Promise<AccountFile> {
  const now = new Date().toISOString();
  const account: AccountFile = { version: 1, profile: await loadSeed(), sidebar: {}, createdAt: now, updatedAt: now };
  await writeJsonFile(DataPaths.account, account);
  console.info('[Account] account.json created from the starting profile');
  return account;
}

/** The account, created from the starting profile on first use. */
export async function readAccount(): Promise<AccountFile> {
  const stored = await readStoredFile();
  if (stored) return stored;
  return withFileLock(DataPaths.account, async () => (await readStoredFile()) ?? createFromSeed());
}

/** The response body for GET and PUT /api/account. */
export function toAccountResponse(account: AccountFile): AccountResponse {
  return {
    success: true,
    profile: { ...account.profile },
    sidebar: {
      sections: effectiveSidebarSections(account.sidebar.sections),
      collapsedGroups: { ...(account.sidebar.collapsedGroups ?? {}) },
    },
    routingName: HUMAN_ROUTING_NAME,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function withoutTimestamp(account: AccountFile): string {
  return JSON.stringify({ ...account, updatedAt: '' });
}

/**
 * Apply a validated patch. Nothing is written when it changes nothing, so saving the same profile
 * twice is harmless. Returns the account and the profile fields that changed.
 */
export async function updateAccount(
  patch: AccountPatch,
): Promise<{ account: AccountFile; changedFields: string[] }> {
  return withFileLock(DataPaths.account, async () => {
    const current = (await readStoredFile()) ?? (await createFromSeed());
    const next: AccountFile = structuredClone(current);

    if (patch.profile) next.profile = { ...next.profile, ...patch.profile };
    if (patch.sidebar) {
      if (patch.sidebar.sections === null) delete next.sidebar.sections;
      else if (patch.sidebar.sections) next.sidebar.sections = patch.sidebar.sections;
      if (patch.sidebar.collapsedGroups) {
        const collapsed = mergeCollapsedGroups(next.sidebar.collapsedGroups, patch.sidebar.collapsedGroups);
        if (Object.keys(collapsed).length > 0) next.sidebar.collapsedGroups = collapsed;
        else delete next.sidebar.collapsedGroups;
      }
    }

    const changedFields: string[] = (Object.keys(next.profile) as Array<keyof AccountProfile>)
      .filter(key => next.profile[key] !== current.profile[key]);
    if (JSON.stringify(next.sidebar) !== JSON.stringify(current.sidebar)) changedFields.push('sidebar');
    if (withoutTimestamp(next) === withoutTimestamp(current)) return { account: current, changedFields: [] };

    next.updatedAt = new Date().toISOString();
    await writeJsonFile(DataPaths.account, next);
    return { account: next, changedFields };
  });
}

/**
 * The owner's display name for stamping on participant records. Best effort: it never creates the
 * file, never throws, and returns null when there is no usable name, so a write to the channels
 * file can never fail because of the account.
 */
export async function getHumanDisplayName(): Promise<string | null> {
  try {
    const file = DataPaths.account;
    if (typeof file !== 'string' || file === '') return null;
    const stored = await readJsonFile<{ profile?: { displayName?: unknown } } | null>(file, null);
    const checked = validateProfilePatch({ displayName: stored?.profile?.displayName });
    return checked.ok ? checked.value.displayName ?? null : null;
  } catch {
    return null;
  }
}
