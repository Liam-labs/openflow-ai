import { AppWindow, Brain, KeyRound } from 'lucide-react';
import type { WizardMeta } from '@/components/wizards/WizardShell';

/** What each setup wizard says about itself on its Set up more card. The steps themselves live in the wizard. */
export const WIZARD_META: Record<'signIn' | 'tailscale' | 'cloudflare' | 'browser' | 'memory', WizardMeta> = {
  signIn: {
    headline: 'A password for other devices',
    summary: 'Protect your dashboard with one password, so you can open it from your phone or another computer.',
    why: [
      'Needed before any remote access can be switched on',
      'This computer never asks for it',
      'Five wrong guesses pause sign-in for 15 minutes',
    ],
    Glyph: KeyRound,
    recommended: 'Start here',
  },
  tailscale: {
    headline: 'Open it on your phone with Tailscale',
    summary: 'Reach your dashboard from your own devices over a private network. Nothing goes on the public internet.',
    why: [
      'Only devices signed in to your Tailscale can see it',
      'You still sign in with your password',
      'Switching it off removes one entry and nothing else',
    ],
    brand: 'tailscale',
    Glyph: KeyRound,
  },
  cloudflare: {
    headline: 'Open it from anywhere on your own domain',
    summary: 'Put the dashboard at an address like openflow.yourdomain.com, behind a one-time code sent to your email.',
    why: [
      'Works from any browser, with nothing to install on the device',
      'Only the email addresses you list can get in',
      'The dashboard still asks for its own password after that',
    ],
    brand: 'cloudflare',
    Glyph: KeyRound,
  },
  browser: {
    headline: 'A browser your agents can use',
    summary: 'Agents get their own browser to open pages, click around and take screenshots.',
    why: [
      'Your everyday browser and its logins are never touched',
      'Sites you sign in to stay signed in for your agents',
      'It only listens on this computer',
    ],
    Glyph: AppWindow,
  },
  memory: {
    headline: 'Shared memory for your team',
    summary: 'Your agents can save notes and search them later, once you give them access, so the team stops solving the same problem twice. It keeps notes your agents write, never your files, and stays on this computer.',
    why: [
      'Runs on this computer, so nothing is sent away',
      'Every agent can store and search the same notes',
      'Set up once, with a test at the end to prove it works',
    ],
    Glyph: Brain,
  },
};
