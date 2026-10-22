/**
 * The account owner's profile and sidebar layout: the limits and the validation.
 *
 * Pure (no file access), so the screen can use the same limits. The profile limits match the
 * scaffolding sync that renders the profile into every agent's `user-profile.md`: a name of 1-40
 * characters on one line, an email of at most 254, "About you" of at most 4,000, and no control
 * characters other than newline or tab. A profile saved here is never refused there.
 *
 * Lengths count characters (code points), the way the sync counts them.
 */

export const DISPLAY_NAME_MAX = 40;
export const EMAIL_MAX = 254;
export const ABOUT_MAX = 4000;

export interface AccountProfile {
  displayName: string;
  /** Empty string when none is set. */
  email: string;
  about: string;
}

export interface FieldError {
  field: string;
  message: string;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

/** Anything except tab and newline: C0 controls, DEL and C1 controls. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
// Line breaks, including the Unicode line and paragraph separators (U+2028, U+2029).
const LINE_BREAKS = new RegExp(`[\n\r${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`);
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function length(text: string): number {
  return Array.from(text).length;
}

function formatCount(count: number): string {
  return count.toLocaleString('en-GB');
}

function validateDisplayName(raw: unknown): Validated<string> {
  const field = 'displayName';
  if (typeof raw !== 'string') return { ok: false, errors: [{ field, message: 'Your name must be text.' }] };
  const trimmed = raw.trim();
  if (LINE_BREAKS.test(trimmed)) return { ok: false, errors: [{ field, message: 'Your name must be on one line.' }] };
  const name = trimmed.replace(/\s+/g, ' ');
  if (CONTROL_CHARS.test(name)) return { ok: false, errors: [{ field, message: "Your name can't contain control characters." }] };
  const count = length(name);
  if (count < 1 || count > DISPLAY_NAME_MAX) {
    return { ok: false, errors: [{ field, message: `Your name must be 1 to ${DISPLAY_NAME_MAX} characters.` }] };
  }
  return { ok: true, value: name };
}

function validateEmail(raw: unknown): Validated<string> {
  const field = 'email';
  if (raw === null || raw === undefined) return { ok: true, value: '' };
  if (typeof raw !== 'string') return { ok: false, errors: [{ field, message: 'Your email address must be text.' }] };
  const email = raw.trim();
  if (email === '') return { ok: true, value: '' };
  if (length(email) > EMAIL_MAX) {
    return { ok: false, errors: [{ field, message: `Your email address can be up to ${EMAIL_MAX} characters.` }] };
  }
  if (LINE_BREAKS.test(email) || CONTROL_CHARS.test(email) || !EMAIL_SHAPE.test(email)) {
    return { ok: false, errors: [{ field, message: "That doesn't look like an email address." }] };
  }
  return { ok: true, value: email };
}

function validateAbout(raw: unknown): Validated<string> {
  const field = 'about';
  if (raw === null || raw === undefined) return { ok: true, value: '' };
  if (typeof raw !== 'string') return { ok: false, errors: [{ field, message: '"About you" must be text.' }] };
  // Line endings from any editor become newlines, so the stored text is the same everywhere.
  const about = raw.replace(/\r\n?/g, '\n');
  if (CONTROL_CHARS.test(about)) {
    return { ok: false, errors: [{ field, message: '"About you" can\'t contain control characters (new lines and tabs are fine).' }] };
  }
  const count = length(about);
  if (count > ABOUT_MAX) {
    return { ok: false, errors: [{ field, message: `"About you" can be up to ${formatCount(ABOUT_MAX)} characters; this is ${formatCount(count)}.` }] };
  }
  return { ok: true, value: about };
}

const PROFILE_FIELDS = ['displayName', 'email', 'about'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate the profile fields that are present. Unknown fields are refused so a typo is not silently dropped. */
export function validateProfilePatch(raw: unknown): Validated<Partial<AccountProfile>> {
  if (!isPlainObject(raw)) return { ok: false, errors: [{ field: 'profile', message: 'The profile must be an object.' }] };
  const errors: FieldError[] = [];
  const value: Partial<AccountProfile> = {};
  for (const key of Object.keys(raw)) {
    if (!(PROFILE_FIELDS as readonly string[]).includes(key)) {
      errors.push({ field: key, message: `Unknown profile field "${key}".` });
    }
  }
  const checks: Array<[keyof AccountProfile, (v: unknown) => Validated<string>]> = [
    ['displayName', validateDisplayName],
    ['email', validateEmail],
    ['about', validateAbout],
  ];
  for (const [key, check] of checks) {
    if (!(key in raw) || raw[key] === undefined) continue;
    const result = check(raw[key]);
    if (result.ok) value[key] = result.value;
    else errors.push(...result.errors);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** Validate a whole profile: name, email and about all present (the first-run seed). */
export function validateFullProfile(raw: unknown): Validated<AccountProfile> {
  const patch = validateProfilePatch(raw);
  if (!patch.ok) return patch;
  const missing = PROFILE_FIELDS.filter(key => patch.value[key] === undefined);
  if (missing.length > 0) {
    return { ok: false, errors: missing.map(field => ({ field, message: `The profile has no ${field}.` })) };
  }
  return { ok: true, value: patch.value as AccountProfile };
}

// ---------------------------------------------------------------------------
// Sidebar layout
// ---------------------------------------------------------------------------

/** The sections of the sidebar that can be shown, hidden and reordered. */
export const SIDEBAR_SECTION_IDS = ['commander', 'pinned', 'groups', 'archived', 'channel-tools', 'roles'] as const;
export type SidebarSectionId = typeof SIDEBAR_SECTION_IDS[number];

export interface SidebarSection {
  id: SidebarSectionId;
  visible: boolean;
}

export const DEFAULT_SIDEBAR_SECTIONS: readonly SidebarSection[] =
  SIDEBAR_SECTION_IDS.map(id => ({ id, visible: true }));

/** Group ids that are folded away. Only collapsed groups are listed. */
export type CollapsedGroups = Record<string, true>;

const GROUP_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_COLLAPSED_GROUPS = 200;

/**
 * The stored sections made complete: unknown ids dropped, repeats dropped, any section the list does
 * not mention appended (shown), so a newer section is never lost to an older screen. Defaults when
 * nothing is stored.
 */
export function effectiveSidebarSections(stored?: readonly unknown[] | null): SidebarSection[] {
  const seen = new Set<string>();
  const sections: SidebarSection[] = [];
  for (const entry of stored ?? []) {
    if (!isPlainObject(entry)) continue;
    const id = entry.id;
    if (typeof id !== 'string' || !(SIDEBAR_SECTION_IDS as readonly string[]).includes(id) || seen.has(id)) continue;
    seen.add(id);
    sections.push({ id: id as SidebarSectionId, visible: entry.visible !== false });
  }
  for (const id of SIDEBAR_SECTION_IDS) {
    if (!seen.has(id)) sections.push({ id, visible: true });
  }
  return sections;
}

function validateSections(raw: unknown): Validated<SidebarSection[]> {
  const field = 'sidebar.sections';
  if (!Array.isArray(raw)) return { ok: false, errors: [{ field, message: 'The sections must be a list.' }] };
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || typeof entry.visible !== 'boolean') {
      return { ok: false, errors: [{ field, message: 'Each section needs an id and a visible true or false.' }] };
    }
    if (!(SIDEBAR_SECTION_IDS as readonly string[]).includes(entry.id)) {
      return { ok: false, errors: [{ field, message: `Unknown sidebar section "${entry.id}".` }] };
    }
    if (seen.has(entry.id)) {
      return { ok: false, errors: [{ field, message: `The section "${entry.id}" is listed twice.` }] };
    }
    seen.add(entry.id);
  }
  return { ok: true, value: effectiveSidebarSections(raw) };
}

function validateCollapsedPatch(raw: unknown): Validated<Record<string, boolean>> {
  const field = 'sidebar.collapsedGroups';
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ field, message: 'Collapsed groups must be an object of group id to true or false.' }] };
  }
  const keys = Object.keys(raw);
  if (keys.length > MAX_COLLAPSED_GROUPS) {
    return { ok: false, errors: [{ field, message: `Send at most ${MAX_COLLAPSED_GROUPS} groups at a time.` }] };
  }
  const value: Record<string, boolean> = {};
  for (const key of keys) {
    if (!GROUP_ID_SHAPE.test(key) || typeof raw[key] !== 'boolean') {
      return { ok: false, errors: [{ field, message: 'Collapsed groups must be an object of group id to true or false.' }] };
    }
    value[key] = raw[key] as boolean;
  }
  return { ok: true, value };
}

/** Fold the groups in a patch into the stored set: true folds a group, false opens it. */
export function mergeCollapsedGroups(
  current: Readonly<Record<string, unknown>> | undefined,
  patch: Readonly<Record<string, boolean>>,
): CollapsedGroups {
  const merged: CollapsedGroups = {};
  for (const [key, value] of Object.entries(current ?? {})) {
    if (value === true && GROUP_ID_SHAPE.test(key)) merged[key] = true;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value) merged[key] = true;
    else delete merged[key];
  }
  const keys = Object.keys(merged);
  if (keys.length > MAX_COLLAPSED_GROUPS) {
    for (const key of keys.slice(0, keys.length - MAX_COLLAPSED_GROUPS)) delete merged[key];
  }
  return merged;
}

// ---------------------------------------------------------------------------
// A whole PUT body
// ---------------------------------------------------------------------------

export interface SidebarPatch {
  /** The new order and visibility, or null to go back to the default layout. */
  sections?: SidebarSection[] | null;
  /** Group id to true (fold) or false (open); groups not mentioned are left as they are. */
  collapsedGroups?: Record<string, boolean>;
}

export interface AccountPatch {
  profile?: Partial<AccountProfile>;
  sidebar?: SidebarPatch;
}

/** Validate a PUT /api/account body. At least one of `profile` and `sidebar` is needed. */
export function validateAccountPatch(raw: unknown): Validated<AccountPatch> {
  if (!isPlainObject(raw)) return { ok: false, errors: [{ field: 'body', message: 'Send an object with a profile and/or a sidebar.' }] };
  const errors: FieldError[] = [];
  const value: AccountPatch = {};

  for (const key of Object.keys(raw)) {
    if (key !== 'profile' && key !== 'sidebar') errors.push({ field: key, message: `Unknown field "${key}".` });
  }

  if (raw.profile !== undefined) {
    const profile = validateProfilePatch(raw.profile);
    if (profile.ok) value.profile = profile.value;
    else errors.push(...profile.errors);
  }

  if (raw.sidebar !== undefined) {
    if (!isPlainObject(raw.sidebar)) {
      errors.push({ field: 'sidebar', message: 'The sidebar must be an object.' });
    } else {
      const sidebar: SidebarPatch = {};
      for (const key of Object.keys(raw.sidebar)) {
        if (key !== 'sections' && key !== 'collapsedGroups') errors.push({ field: `sidebar.${key}`, message: `Unknown sidebar field "${key}".` });
      }
      if (raw.sidebar.sections !== undefined) {
        if (raw.sidebar.sections === null) {
          sidebar.sections = null;
        } else {
          const sections = validateSections(raw.sidebar.sections);
          if (sections.ok) sidebar.sections = sections.value;
          else errors.push(...sections.errors);
        }
      }
      if (raw.sidebar.collapsedGroups !== undefined) {
        const collapsed = validateCollapsedPatch(raw.sidebar.collapsedGroups);
        if (collapsed.ok) sidebar.collapsedGroups = collapsed.value;
        else errors.push(...collapsed.errors);
      }
      value.sidebar = sidebar;
    }
  }

  if (errors.length === 0 && value.profile === undefined && value.sidebar === undefined) {
    errors.push({ field: 'body', message: 'Send a profile and/or a sidebar to change.' });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}
