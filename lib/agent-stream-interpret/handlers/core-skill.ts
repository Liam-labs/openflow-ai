/**
 * Sprint 5 — Skill (slash commands). Catalogue §6 (65+ entries).
 *
 * Sub-dispatch via SKILL_META: per-skill icon + verb. Unknown skills fall
 * through to a generic shape. Tone is resolved separately by `resolveTone`
 * via `SKILL_CATEGORY_TONES` (catalogue §10f).
 */

import type { FamilyHandler, Handler, IconName } from '../types';
import { truncate } from '../utils';
import { PRODUCT_NAME } from '@/lib/brand';

interface SkillMeta {
  icon: IconName;
  verb: string;
}

const SKILL_META: Readonly<Record<string, SkillMeta>> = {
  // Git / commits
  gitcommit: { icon: 'git-branch', verb: 'Git commit (skill)' },
  // PR / review
  review: { icon: 'search', verb: 'Review PR' },
  'security-review': { icon: 'shield', verb: 'Security review' },
  // Init / setup
  init: { icon: 'map', verb: 'Init CLAUDE.md' },
  'init-project': { icon: 'map', verb: 'Init project' },
  // Debug
  debug: { icon: 'wrench', verb: 'Debug' },
  // Loop
  'ralph-loop': { icon: 'clock', verb: 'Ralph loop' },
  'cancel-ralph': { icon: 'clock', verb: 'Cancel Ralph' },
  loop: { icon: 'clock', verb: 'Loop' },
  schedule: { icon: 'clock', verb: 'Schedule' },
  // Browser / terminal
  'browser-test': { icon: 'globe', verb: 'Browser test' },
  'ai-terminal': { icon: 'terminal', verb: 'AI terminal' },
  // Collab
  'collab-post': { icon: 'message-square', verb: 'Collab post' },
  'collab-poll': { icon: 'message-square', verb: 'Collab poll' },
  'collab-join': { icon: 'message-square', verb: 'Join channel' },
  broadcast: { icon: 'message-square', verb: 'Broadcast' },
  ask: { icon: 'help-circle', verb: 'Ask session' },
  sessions: { icon: 'eye', verb: 'List sessions' },
  'register-session': { icon: 'message-square', verb: 'Register session' },
  doc: { icon: 'file-text', verb: 'Doc' },
  devflow: { icon: 'rocket', verb: `Register ${PRODUCT_NAME}` },
  'flush-journal': { icon: 'pen-tool', verb: 'Flush journal' },
  'task-claim': { icon: 'clipboard-list', verb: 'Claim task' },
  'sprint-plan': { icon: 'clipboard-list', verb: 'Sprint plan' },
  // Config
  'update-config': { icon: 'settings', verb: 'Update config' },
  simplify: { icon: 'wrench', verb: 'Simplify' },
  audit: { icon: 'search', verb: 'Audit' },
  // UI / design
  'frontend-design': { icon: 'image', verb: 'Frontend design' },
  'ui-ux': { icon: 'image', verb: 'UI/UX' },
  animate: { icon: 'sparkles', verb: 'Animate' },
  harden: { icon: 'shield', verb: 'Harden' },
  optimize: { icon: 'sparkles', verb: 'Optimize' },
  adapt: { icon: 'smartphone', verb: 'Adapt (responsive)' },
  colorize: { icon: 'image', verb: 'Colorize' },
  typeset: { icon: 'pen-tool', verb: 'Typeset' },
  polish: { icon: 'sparkles', verb: 'Polish' },
  arrange: { icon: 'sparkles', verb: 'Arrange' },
  bolder: { icon: 'sparkles', verb: 'Bolder' },
  distill: { icon: 'wrench', verb: 'Distill' },
  quieter: { icon: 'sparkles', verb: 'Quieter' },
  overdrive: { icon: 'rocket', verb: 'Overdrive' },
  normalize: { icon: 'sparkles', verb: 'Normalize' },
  delight: { icon: 'sparkles', verb: 'Delight' },
  onboard: { icon: 'sparkles', verb: 'Onboard' },
  clarify: { icon: 'message-square', verb: 'Clarify' },
  extract: { icon: 'package', verb: 'Extract' },
  critique: { icon: 'pen-tool', verb: 'Critique' },
  humanizer: { icon: 'pen-tool', verb: 'Humanizer' },
  // SEO
  'image-optimization': { icon: 'image', verb: 'Image optimization' },
  'internal-linking': { icon: 'globe', verb: 'Internal linking' },
  'ux-seo': { icon: 'search', verb: 'UX/SEO' },
  'technical-seo': { icon: 'search', verb: 'Technical SEO' },
  'content-quality': { icon: 'pen-tool', verb: 'Content quality' },
  'meta-tags-optimization': { icon: 'tag', verb: 'Meta tags' },
  reporter: { icon: 'bar-chart', verb: 'SEO report' },
  executor: { icon: 'sparkles', verb: 'SEO executor' },
  meta: { icon: 'tag', verb: 'SEO meta' },
  // API integrations
  rightmove: { icon: 'home', verb: 'Rightmove API' },
  shopify: { icon: 'package', verb: 'Shopify' },
  android: { icon: 'smartphone', verb: 'Android' },
  'cloudflare-tunnels': { icon: 'globe', verb: 'Cloudflare tunnels' },
  'one-plus': { icon: 'smartphone', verb: 'OnePlus' },
  'claude-api': { icon: 'brain', verb: 'Claude API' },
  // Misc
  'fewer-permission-prompts': { icon: 'settings', verb: 'Reduce permission prompts' },
  'keybindings-help': { icon: 'keyboard', verb: 'Keybindings' },
  'teach-impeccable': { icon: 'graduation-cap', verb: 'Teach impeccable' },
};

export const skillHandler: Handler = (input, item) => {
  const skill = typeof input.skill === 'string' ? input.skill : '';
  const args = typeof input.args === 'string' ? input.args : '';
  const meta = SKILL_META[skill];
  return {
    icon: meta?.icon ?? 'sparkles',
    verb: meta?.verb ?? `Skill: /${skill || 'unknown'}`,
    subject: meta ? '' : skill,
    detail: truncate(args, 60),
    outcome: null,
    tone: 'mutate', // overridden by resolveTone via SKILL_CATEGORY_TONES
    toolName: 'Skill',
    toolUseId: item.toolUseId ?? '',
  };
};

export function registerHandlers(
  exact: Record<string, Handler>,
  _family: Record<string, FamilyHandler>,
): void {
  exact.Skill = skillHandler;
}
