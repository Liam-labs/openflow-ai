// @vitest-environment jsdom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WizardShellContext, type Tone } from '@/components/wizards/WizardShell';
import { StatusPill, WizardFrame } from '@/components/wizards/WizardFrame';

// The dialog opens on the step a person needs, shows what changes beside the action, and moves to the test by itself.
describe('WizardFrame in a dialog', () => {
  let container: HTMLDivElement;
  let body: HTMLDivElement;
  let root: Root;

  const slots = {
    check: React.createElement('p', null, 'CHECK-TEXT'),
    explain: React.createElement('p', null, 'EXPLAIN-TEXT'),
    doIt: React.createElement('button', { type: 'button' }, 'DO-BUTTON'),
    prove: React.createElement('p', null, 'PROVE-TEXT'),
    undo: React.createElement('p', null, 'UNDO-TEXT'),
  };
  const render = (tone: Tone, testSignal?: number, holdSetup?: string | null, message?: { ok: boolean; text: string } | null) => act(async () => {
    root.render(React.createElement(WizardShellContext.Provider,
      { value: { cardStatusEl: null, modalStatusEl: null, bodyEl: body, setTone: () => undefined } },
      React.createElement(WizardFrame, { title: 'T', status: React.createElement(StatusPill, { tone }, 'x'), ...slots, testSignal, holdSetup, message })));
  });
  const heading = () => body.querySelector('h3.sc-step-h')?.textContent;
  const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });
  const buttonByText = (t: string) => Array.from(body.querySelectorAll('button')).find(b => b.textContent?.includes(t)) ?? null;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    body = document.createElement('div');
    document.body.append(container, body);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); body.remove(); });

  it('shows the last result on whichever step is open, the Test and Undo steps included', async () => {
    await render('good', 0, null, { ok: true, text: 'RESULT-TEXT' });
    expect(heading()).toBe('Check that it works');
    expect(body.textContent).toContain('RESULT-TEXT');
    await click(buttonByText('Continue'));
    expect(heading()).toBe('Undo it');
    expect(body.textContent).toContain('RESULT-TEXT');
    await render('good', 0, null, null);
    expect(body.textContent).not.toContain('RESULT-TEXT');
  });

  it('opens on Set it up when nothing is on, with the action and what it changes on the same step', async () => {
    await render('idle');
    expect(heading()).toBe('Set it up');
    expect(body.textContent).toContain('DO-BUTTON');
    expect(body.textContent).toContain('EXPLAIN-TEXT');
    expect(body.querySelector('details')?.hasAttribute('open')).toBe(true);
    expect(body.textContent).not.toContain('CHECK-TEXT');
  });

  it('holds Continue and the later step dots on Set it up while a reason is given, but still goes back and to the test by signal', async () => {
    await render('idle', 0, 'Press Switch on first.');
    expect(body.textContent).toContain('Press Switch on first.');
    expect((buttonByText('Continue') as HTMLButtonElement).disabled).toBe(true);
    await click(buttonByText('Continue'));
    expect(heading()).toBe('Set it up');
    const dots = Array.from(body.querySelectorAll('.sc-dot')) as HTMLButtonElement[];
    expect(dots.map(d => d.disabled)).toEqual([false, false, false, true, false]);
    await click(dots[3]);
    expect(heading()).toBe('Set it up');
    await click(dots[4]);
    expect(heading()).toBe('Undo it');                                              // a saved token or part-made setup must stay removable
    await click(dots[2]);
    expect(heading()).toBe('Set it up');
    await click(dots[1]);
    expect(heading()).toBe('What this changes');
    expect(body.textContent).not.toContain('Press Switch on first.');
    await render('idle', 1, 'Press Switch on first.');
    expect(heading()).toBe('Check that it works');
    await render('idle', 1, null);
    await click(dots[2]); await click(buttonByText('Continue'));
    expect(heading()).toBe('Check that it works');
  });

  it('opens on the test when it is already on', async () => {
    await render('good');
    expect(heading()).toBe('Check that it works');
    expect(body.textContent).toContain('PROVE-TEXT');
    expect(body.textContent).not.toContain('EXPLAIN-TEXT');
  });

  it('shows what changes only on the Set it up step, and every step is still one click away', async () => {
    await render('idle');
    for (const [i, h] of [[0, 'Where things stand'], [1, 'What this changes'], [3, 'Check that it works'], [4, 'Undo it'], [2, 'Set it up']] as const) {
      await click(body.querySelectorAll('.sc-dot')[i]);
      expect(heading()).toBe(h);
    }
    await click(body.querySelectorAll('.sc-dot')[0]);
    expect(body.querySelector('details')).toBeNull();
  });

  it('moves to the Test step when the signal changes, and not when it stays the same', async () => {
    await render('idle', 0);
    expect(heading()).toBe('Set it up');
    await render('idle', 0);
    expect(heading()).toBe('Set it up');
    await render('idle', 1);
    expect(heading()).toBe('Check that it works');
    await click(body.querySelectorAll('.sc-dot')[2]);
    await render('idle', 1);
    expect(heading()).toBe('Set it up');
    await render('idle', 2);
    expect(heading()).toBe('Check that it works');
  });

  it('keeps Back and Continue working from the opening step', async () => {
    await render('idle');
    await click(buttonByText('Back'));
    expect(heading()).toBe('What this changes');
    await click(buttonByText('Continue'));
    expect(heading()).toBe('Set it up');
    await click(buttonByText('Continue'));
    expect(heading()).toBe('Check that it works');
  });
});
