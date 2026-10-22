/**
 * Sprint 5 — Bash handler with sub-tool sniffing.
 *
 * Inspects the leading token of `command` and produces a more specific
 * verb/icon/tone where possible (git, npm, gh, pm2, curl, psql, docker,
 * python, node, sqlite3, jq, tsc, vitest, file ops). Compound patterns
 * like `npm run build` and `pm2 restart <name>` get tightened headlines.
 */

import type { FamilyHandler, Handler, IconName, InterpretedAction, ToneName } from '../types';
import {
  shortUrl,
  stripCdPrelude,
  stripEnvAndSudo,
  stripUserPath,
  truncate,
} from '../utils';

interface BashShape {
  icon: IconName;
  verb: string;
  subject: string;
  detail: string;
  tone: ToneName;
}

function tokenize(command: string): string[] {
  return command.trim().split(/\s+/);
}

// `stripCdPrelude` and `stripEnvAndSudo` are imported from utils.ts so
// that tone.ts can share the exact same normalization — if these diverge,
// the handler and the tone resolver classify the same command differently,
// which has bitten us before.

// rm only — mv can overwrite but isn't recursive-destructive, classified
// as mutate at resolver level (catalogue §10e implicit). Keeps the
// danger flag exclusive to truly destructive ops.
const FILE_OPS_DANGER = new Set(['rm']);
// File ops that get the wrench icon + verb-as-command headline. Tone
// is resolved separately by tone.ts so this set is purely cosmetic.
const FILE_OPS_NEUTRAL = new Set([
  'cp', 'mv', 'mkdir', 'ls', 'cat', 'head', 'tail', 'wc', 'chmod', 'chown',
]);

function classify(command: string): BashShape {
  const normalized = stripCdPrelude(command);
  const stripped = stripEnvAndSudo(tokenize(normalized));
  if (stripped.length === 0) {
    return { icon: 'terminal', verb: 'Bash', subject: '', detail: '', tone: 'neutral' };
  }
  const head = stripped[0];
  const rest = stripped.slice(1);

  switch (head) {
    case 'git': {
      const sub = rest[0] ?? '';
      if (sub === 'commit') {
        return { icon: 'git-branch', verb: 'git commit', subject: '', detail: '', tone: 'mutate' };
      }
      if (sub === 'push') {
        return {
          icon: 'git-branch',
          verb: 'git push',
          subject: rest.slice(1).find((t) => !t.startsWith('-')) ?? '',
          detail: '',
          tone: 'mutate',
        };
      }
      return {
        icon: 'git-branch',
        verb: `git ${sub}`.trim(),
        subject: '',
        detail: '',
        tone: sub === 'reset' || sub === 'rebase' ? 'mutate' : 'neutral',
      };
    }

    case 'npm':
    case 'pnpm':
    case 'yarn': {
      if (rest[0] === 'run' && rest[1]) {
        return {
          icon: 'package',
          verb: `${head} run`,
          subject: rest[1],
          detail: rest.slice(2).join(' ').slice(0, 60),
          tone: 'neutral',
        };
      }
      return {
        icon: 'package',
        verb: `${head} ${rest[0] ?? ''}`.trim(),
        subject: rest[1] ?? '',
        detail: '',
        tone: rest[0] === 'install' || rest[0] === 'add' ? 'mutate' : 'neutral',
      };
    }

    case 'npx':
    case 'bunx':
    case 'bun': {
      return {
        icon: 'package',
        verb: head,
        subject: rest.find((t) => !t.startsWith('-')) ?? '',
        detail: '',
        tone: 'neutral',
      };
    }

    case 'gh': {
      const sub = rest.slice(0, 2).join(' ');
      return {
        icon: 'git-pull-request',
        verb: `gh ${sub}`.trim(),
        subject: rest[2] ?? '',
        detail: '',
        tone: sub.includes('create') || sub.includes('merge') ? 'mutate' : 'neutral',
      };
    }

    case 'pm2': {
      const sub = rest[0] ?? '';
      const target = rest.slice(1).find((t) => !t.startsWith('-')) ?? '';
      return {
        icon: 'package',
        verb: `pm2 ${sub}`,
        subject: target,
        detail: '',
        tone: sub === 'restart' || sub === 'delete' || sub === 'stop' ? 'mutate' : 'neutral',
      };
    }

    case 'curl': {
      const url = rest.find((t) => /^https?:\/\//.test(t) || t.startsWith("'http") || t.startsWith('"http'));
      const cleanUrl = url ? url.replace(/^['"]|['"]$/g, '') : '';
      const method = (() => {
        const xIdx = rest.findIndex((t) => t === '-X');
        if (xIdx !== -1 && rest[xIdx + 1]) return rest[xIdx + 1];
        return 'GET';
      })();
      return {
        icon: 'globe',
        verb: 'curl',
        subject: cleanUrl ? shortUrl(cleanUrl) : '',
        detail: method,
        tone: 'external',
      };
    }

    case 'psql':
    case 'sqlite3': {
      return {
        icon: 'database',
        verb: head,
        subject: rest.find((t) => !t.startsWith('-')) ?? '',
        detail: '',
        tone: 'neutral',
      };
    }

    case 'docker': {
      const sub = rest[0] ?? '';
      return {
        icon: 'cloud',
        verb: `docker ${sub}`,
        subject: rest.slice(1).find((t) => !t.startsWith('-')) ?? '',
        detail: '',
        tone: sub === 'rm' || sub === 'stop' ? 'danger' : 'external',
      };
    }

    case 'python':
    case 'python3': {
      const script = rest.find((t) => !t.startsWith('-')) ?? '';
      return {
        icon: 'terminal',
        verb: 'python',
        subject: script ? stripUserPath(script) : '',
        detail: '',
        tone: 'neutral',
      };
    }

    case 'node': {
      const script = rest.find((t) => !t.startsWith('-')) ?? '';
      return {
        icon: 'terminal',
        verb: 'node',
        subject: script ? stripUserPath(script) : '',
        detail: '',
        tone: 'neutral',
      };
    }

    case 'tsc': {
      return { icon: 'terminal', verb: 'tsc', subject: '', detail: rest.join(' ').slice(0, 60), tone: 'neutral' };
    }

    case 'vitest':
    case 'jest': {
      return { icon: 'terminal', verb: head, subject: '', detail: rest.join(' ').slice(0, 60), tone: 'neutral' };
    }

    case 'jq': {
      return { icon: 'wrench', verb: 'jq', subject: rest[0] ?? '', detail: '', tone: 'neutral' };
    }

    case 'source': {
      const file = rest[0] ?? '';
      const stripped = stripUserPath(file);
      // Compound pattern: `source ~/.secrets` → "Load secrets"
      if (stripped === '~/.secrets') {
        return { icon: 'shield', verb: 'Load secrets', subject: '', detail: '', tone: 'neutral' };
      }
      return { icon: 'wrench', verb: 'source', subject: stripped, detail: '', tone: 'neutral' };
    }

    default: {
      if (FILE_OPS_DANGER.has(head)) {
        return {
          icon: 'wrench',
          verb: head,
          subject: rest.find((t) => !t.startsWith('-')) ?? '',
          detail: '',
          tone: 'danger',
        };
      }
      if (FILE_OPS_NEUTRAL.has(head)) {
        return {
          icon: 'wrench',
          verb: head,
          subject: rest.find((t) => !t.startsWith('-')) ?? '',
          detail: '',
          tone: 'neutral',
        };
      }
      return {
        icon: 'terminal',
        verb: 'Bash',
        subject: truncate(normalized, 60),
        detail: '',
        tone: 'neutral',
      };
    }
  }
}

export const bashHandler: Handler = (input, item): InterpretedAction => {
  const command = typeof input.command === 'string' ? input.command : '';
  const shape = classify(command);
  return {
    ...shape,
    outcome: null,
    toolName: 'Bash',
    toolUseId: item.toolUseId ?? '',
  };
};

export function registerHandlers(
  exact: Record<string, Handler>,
  _family: Record<string, FamilyHandler>,
): void {
  exact.Bash = bashHandler;
}
