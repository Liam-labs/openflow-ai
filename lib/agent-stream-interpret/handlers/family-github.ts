/**
 * Sprint 5 — GitHub MCP family (catalogue §3e, 40 actions).
 */

import type { FamilyHandler, Handler, IconName, InterpretedAction, ToneName } from '../types';
import { truncate } from '../utils';

interface ActionMeta {
  verb: string;
  icon?: IconName;
  subject?: (input: Record<string, unknown>) => string;
  detail?: (input: Record<string, unknown>) => string;
}

function repoSlug(input: Record<string, unknown>): string {
  const owner = typeof input.owner === 'string' ? input.owner : '';
  const repo = typeof input.repo === 'string' ? input.repo : '';
  return owner && repo ? `${owner}/${repo}` : repo || owner;
}

function basenameOf(p: unknown): string {
  if (typeof p !== 'string' || !p) return '';
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

const ACTIONS: Readonly<Record<string, ActionMeta>> = {
  // Repo
  create_repository: { verb: 'create repo', subject: (i) => String(i.name ?? '') },
  fork_repository: { verb: 'fork', subject: repoSlug },
  get_file_contents: { verb: 'read file', subject: (i) => basenameOf(i.path), detail: repoSlug },
  create_or_update_file: { verb: 'write file', subject: (i) => basenameOf(i.path), detail: repoSlug },
  delete_file: { verb: 'delete file', subject: (i) => basenameOf(i.path), detail: repoSlug },
  push_files: { verb: 'push files', subject: (i) => `${repoSlug(i)}@${String(i.branch ?? '')}` },
  get_me: { verb: 'get current user' },
  // Branches & tags
  create_branch: { icon: 'git-branch', verb: 'create branch', subject: (i) => String(i.branch ?? '') },
  list_branches: { icon: 'git-branch', verb: 'list branches', subject: repoSlug },
  list_tags: { icon: 'git-branch', verb: 'list tags', subject: repoSlug },
  get_tag: { icon: 'git-branch', verb: 'get tag', subject: (i) => String(i.tag ?? '') },
  // Commits & releases
  get_commit: { verb: 'get commit', subject: (i) => String(i.sha ?? '').slice(0, 7) },
  list_commits: { verb: 'list commits', subject: repoSlug },
  list_releases: { verb: 'list releases', subject: repoSlug },
  get_latest_release: { verb: 'latest release', subject: repoSlug },
  get_release_by_tag: { verb: 'release', subject: (i) => String(i.tag ?? '') },
  // Issues
  issue_read: { verb: 'issue', subject: (i) => `#${String(i.issue_number ?? '')}`, detail: repoSlug },
  issue_write: { verb: 'write issue', subject: repoSlug },
  list_issues: { verb: 'list issues', subject: repoSlug },
  add_issue_comment: { verb: 'comment on issue', subject: (i) => `#${String(i.issue_number ?? '')}` },
  assign_copilot_to_issue: { verb: 'assign Copilot', subject: (i) => `#${String(i.issue_number ?? '')}` },
  sub_issue_write: { verb: 'sub-issue', subject: (i) => `on #${String(i.parent_issue_number ?? '')}` },
  list_issue_types: { verb: 'list issue types', subject: repoSlug },
  get_label: { verb: 'label', subject: (i) => String(i.name ?? '') },
  // PRs
  create_pull_request: {
    verb: 'PR create',
    subject: repoSlug,
    detail: (i) => truncate(String(i.title ?? ''), 60),
  },
  list_pull_requests: { verb: 'list PRs', subject: repoSlug },
  pull_request_read: { verb: 'PR', subject: (i) => `#${String(i.pull_number ?? '')}`, detail: repoSlug },
  merge_pull_request: { verb: 'merge PR', subject: (i) => `#${String(i.pull_number ?? '')}` },
  update_pull_request: { verb: 'update PR', subject: (i) => `#${String(i.pull_number ?? '')}` },
  update_pull_request_branch: { verb: 'update PR branch', subject: (i) => `#${String(i.pull_number ?? '')}` },
  pull_request_review_write: {
    verb: 'PR review',
    subject: (i) => `#${String(i.pull_number ?? '')}`,
    detail: (i) => String(i.method ?? ''),
  },
  add_comment_to_pending_review: { verb: 'add review comment', subject: (i) => `#${String(i.pull_number ?? '')}` },
  add_reply_to_pull_request_comment: { verb: 'reply to PR comment', subject: '' as unknown as undefined },
  request_copilot_review: { verb: 'request Copilot review', subject: (i) => `#${String(i.pull_number ?? '')}` },
  // Search
  search_repositories: { verb: 'search repos', subject: (i) => truncate(String(i.query ?? ''), 60) },
  search_issues: { verb: 'search issues', subject: (i) => truncate(String(i.query ?? ''), 60) },
  search_pull_requests: { verb: 'search PRs', subject: (i) => truncate(String(i.query ?? ''), 60) },
  search_code: { verb: 'search code', subject: (i) => truncate(String(i.query ?? ''), 60) },
  search_users: { verb: 'search users', subject: (i) => truncate(String(i.query ?? ''), 60) },
  // Teams
  get_teams: { verb: 'get teams', subject: (i) => String(i.org ?? '') },
  get_team_members: { verb: 'team members', subject: (i) => String(i.team_slug ?? '') },
};

function defaultIconForAction(action: string): IconName {
  if (
    action.includes('pull_request') ||
    action === 'create_pull_request' ||
    action === 'merge_pull_request'
  ) {
    return 'git-pull-request';
  }
  if (action.includes('branch') || action.includes('tag')) return 'git-branch';
  return 'git-pull-request';
}

export const githubFamily: FamilyHandler = (action, input, item): InterpretedAction => {
  const meta = ACTIONS[action];
  const subject = meta?.subject ? meta.subject(input) : '';
  const detail = meta?.detail ? meta.detail(input) : '';
  const verb = meta ? `GitHub ${meta.verb}` : `GitHub ${action}`;
  return {
    icon: meta?.icon ?? defaultIconForAction(action),
    verb,
    subject,
    detail,
    outcome: null,
    tone: 'external' as ToneName, // overridden by resolveTone
    toolName: `mcp__github__${action}`,
    toolUseId: item.toolUseId ?? '',
  };
};

export function registerHandlers(
  _exact: Record<string, Handler>,
  family: Record<string, FamilyHandler>,
): void {
  family.github = githubFamily;
}
