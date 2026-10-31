'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Globe, Loader2, TriangleAlert } from 'lucide-react';
import {
  ADDRESS_COPY as T,
  INITIAL_ADDRESS_STATE,
  canContinue,
  domainCheckMessage,
  fallbackAddress,
  nextAddressState,
  normaliseDomain,
  ownDomainHost,
  unavailableMessage,
  type AddressChoice,
  type AddressService,
  type DomainCheckResult,
} from '@/lib/setup/address-step';

/** How often the screen asks how far the installer has got. The installer has no push channel yet. */
const CLAIM_POLL_MS = 2000;

interface AddressStepProps {
  service: AddressService;
  /** Called once with the final address, when the person presses Continue on the last screen. */
  onDone: (address: string) => void;
}

function CopyButton({ value, label = T.buttons.copy }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* The value stays selectable on the page. */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`${label} ${value}`}
      className="glass-button inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-white/70 hover:text-white"
    >
      {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

function Tick({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 text-sm">
      {done ? (
        <Check className="w-4 h-4 text-emerald-400 flex-shrink-0" aria-hidden="true" />
      ) : (
        <Loader2 className="w-4 h-4 text-white/40 animate-spin flex-shrink-0 motion-reduce:animate-none" aria-hidden="true" />
      )}
      <span className={done ? 'text-white/90' : 'text-white/50'}>
        {children}
        <span className="sr-only">{done ? ' (done)' : ' (waiting)'}</span>
      </span>
    </li>
  );
}

function Card({ children, innerRef }: { children: React.ReactNode; innerRef: React.Ref<HTMLDivElement> }) {
  return (
    <div ref={innerRef} className="glass-card p-6 sm:p-8 relative z-10">
      {children}
    </div>
  );
}

function Heading({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 mb-6">
      <div
        className="flex-shrink-0 p-3 rounded-xl"
        style={{ background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.25)' }}
      >
        <Globe className="w-6 h-6 text-[#60a5fa]" aria-hidden="true" />
      </div>
      <div>
        <h2 tabIndex={-1} className="text-lg font-semibold text-white leading-tight outline-none">{children}</h2>
        {sub ? <p className="text-sm text-white/50 mt-0.5">{sub}</p> : null}
      </div>
    </div>
  );
}

function PrimaryButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="glass-button primary px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

function SecondaryButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="glass-button px-4 py-2.5 text-sm text-white/70 hover:text-white">
      {children}
    </button>
  );
}

export function AddressStep({ service, onDone }: AddressStepProps) {
  const [state, dispatch] = useReducer(nextAddressState, INITIAL_ADDRESS_STATE);
  const [installDomain, setInstallDomain] = useState<string | null>(null);
  const [serverAddress, setServerAddress] = useState<string | null>(null);
  const [domainInput, setDomainInput] = useState('');
  const [domainError, setDomainError] = useState(false);
  const [checking, setChecking] = useState(false);
  const [serverError, setServerError] = useState(false);
  const doneSent = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const shownScreen = useRef(state.screen);

  // The install domain and the server address are read once. The wording never contains them as text.
  useEffect(() => {
    let alive = true;
    service.installDomain().then((d) => alive && setInstallDomain(d)).catch(() => undefined);
    service.vpsAddress().then((a) => alive && setServerAddress(a)).catch(() => alive && setServerError(true));
    return () => {
      alive = false;
    };
  }, [service]);

  // Free route: ask for a name when the screen opens, or when the person asks for another.
  const needsName = state.screen === 'free' && state.name === null;
  useEffect(() => {
    if (!needsName) return;
    let alive = true;
    service
      .suggestName()
      .then((suggestion) => alive && dispatch({ type: 'suggested', suggestion }))
      .catch(() => alive && dispatch({ type: 'suggested', suggestion: { ok: false, reason: 'unreachable' } }));
    return () => {
      alive = false;
    };
  }, [needsName, service]);

  // Watch the claim until the padlock is issued. A timer is used because the installer has no push channel yet.
  const watched =
    state.screen === 'free' && state.name && !state.padlock
      ? state.name
      : state.screen === 'own-ticks' && !state.padlock
        ? state.host
        : null;
  useEffect(() => {
    if (!watched) return;
    let alive = true;
    const ask = () =>
      service
        .claimStatus(watched)
        .then((status) => alive && dispatch({ type: 'claim', status }))
        .catch(() => undefined);
    ask();
    const timer = setInterval(ask, CLAIM_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [watched, service]);

  // A screen change replaces the button the person pressed. Move focus to the new heading so keyboard and screen reader users keep their place.
  useEffect(() => {
    if (shownScreen.current === state.screen) return;
    shownScreen.current = state.screen;
    rootRef.current?.querySelector('h2')?.focus({ preventScroll: true });
  }, [state.screen]);

  const finish = useCallback(() => {
    dispatch({ type: 'finish' });
  }, []);

  useEffect(() => {
    if (state.screen === 'done' && !doneSent.current) {
      doneSent.current = true;
      onDone(state.address);
    }
  }, [state, onDone]);

  const exampleName = useMemo(() => (installDomain ? `calm-otter-4821.${installDomain}` : 'calm-otter-4821'), [installDomain]);
  const record = state.screen === 'own-record' ? state : null;
  const expected = serverAddress ?? '';

  const checkDomain = async () => {
    if (!record || !serverAddress) return;
    setChecking(true);
    let result: DomainCheckResult;
    try {
      result = await service.checkOwnDomain(record.host, serverAddress);
    } catch {
      result = { result: 'not-found' };
    }
    dispatch({ type: 'domain-checked', result });
    setChecking(false);
  };

  const submitDomain = () => {
    if (!normaliseDomain(domainInput)) {
      setDomainError(true);
      return;
    }
    setDomainError(false);
    dispatch({ type: 'domain-entered', domain: domainInput });
  };

  // ── Screens ──────────────────────────────────────────────────────────────

  if (state.screen === 'choose') {
    const cards: { id: AddressChoice; title: string; body: string }[] = [
      { id: 'free', title: T.freeCardTitle, body: T.freeCardBody(exampleName) },
      { id: 'own', title: T.ownCardTitle, body: T.ownCardBody },
    ];
    return (
      <Card innerRef={rootRef}>
        <Heading>{T.chooseTitle}</Heading>
        <fieldset className="flex flex-col gap-3 border-0 p-0 m-0">
          <legend className="sr-only">{T.chooseTitle}</legend>
          {cards.map((c) => {
            const selected = state.choice === c.id;
            return (
              <label
                key={c.id}
                className={`flex gap-3 rounded-xl p-4 cursor-pointer border transition-colors focus-within:ring-2 focus-within:ring-[#60a5fa] ${
                  selected ? 'border-[#60a5fa] bg-[rgba(59,130,246,0.10)]' : 'border-white/10 hover:border-white/25'
                }`}
              >
                <input
                  type="radio"
                  name="address-choice"
                  value={c.id}
                  checked={selected}
                  onChange={() => dispatch({ type: 'pick', choice: c.id })}
                  className="mt-1 h-4 w-4 flex-shrink-0 appearance-none rounded-full border border-white/40 checked:border-[#60a5fa] checked:bg-[#60a5fa] checked:shadow-[inset_0_0_0_3px_#0a1020]"
                />
                <span>
                  <span className="block text-sm font-medium text-white">{c.title}</span>
                  <span className="block text-sm text-white/60 mt-1">{c.body}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <div className="flex justify-end mt-6">
          <PrimaryButton onClick={() => dispatch({ type: 'continue' })}>{T.buttons.continue}</PrimaryButton>
        </div>
      </Card>
    );
  }

  if (state.screen === 'free' || state.screen === 'own-ticks') {
    const name = state.screen === 'free' ? state.name : state.host;
    const ready = state.padlock && !!name;
    return (
      <Card innerRef={rootRef}>
        <Heading>{T.freeTitle}</Heading>
        <ul className="flex flex-col gap-3" aria-live="polite">
          <Tick done={!!name}>{name ? T.tickChosen(name) : 'Choosing an address'}</Tick>
          <Tick done={state.pointed}>{T.tickPointed}</Tick>
          <Tick done={state.padlock}>{T.tickPadlock}</Tick>
        </ul>
        {ready ? (
          <div className="mt-6" role="status">
            <p className="text-sm font-medium text-white">{T.ready}</p>
            <p className="mt-2 break-all text-sm text-[#93c5fd]">{name}</p>
            <div className="flex flex-wrap gap-2 mt-3">
              <CopyButton value={name} />
              <a
                href={`https://${name}`}
                target="_blank"
                rel="noreferrer"
                className="glass-button inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-white/70 hover:text-white"
              >
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                {T.buttons.openIt}
              </a>
            </div>
          </div>
        ) : null}
        <div className="flex items-center justify-between mt-6">
          {state.screen === 'free' && !state.padlock && state.name ? (
            <button
              type="button"
              onClick={() => dispatch({ type: 'choose-another' })}
              className="text-xs text-white/50 hover:text-white underline underline-offset-2"
            >
              {T.chooseAnother}
            </button>
          ) : (
            <span />
          )}
          <PrimaryButton onClick={finish} disabled={!canContinue(state)}>
            {T.buttons.continue}
          </PrimaryButton>
        </div>
      </Card>
    );
  }

  if (state.screen === 'own-domain') {
    const preview = ownDomainHost(domainInput);
    return (
      <Card innerRef={rootRef}>
        <Heading sub={T.ownDomainHelp}>{T.ownDomainTitle}</Heading>
        <label htmlFor="own-domain" className="sr-only">
          {T.ownDomainTitle}
        </label>
        <input
          id="own-domain"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={domainInput}
          onChange={(e) => {
            setDomainInput(e.target.value);
            setDomainError(false);
          }}
          onKeyDown={(e) => e.key === 'Enter' && submitDomain()}
          placeholder="example.com"
          aria-invalid={domainError}
          aria-describedby={domainError ? 'own-domain-error' : undefined}
          className="w-full rounded-xl bg-white/[0.04] border border-white/10 px-4 py-3 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[#60a5fa]"
        />
        {domainError ? (
          <p id="own-domain-error" role="alert" className="mt-2 text-sm text-red-400">
            {T.ownDomainInvalid}
          </p>
        ) : preview ? (
          <p className="mt-2 text-sm text-white/60">{T.ownDomainUse(preview)}</p>
        ) : null}
        <div className="flex justify-end mt-6">
          <PrimaryButton onClick={submitDomain}>{T.buttons.next}</PrimaryButton>
        </div>
      </Card>
    );
  }

  if (state.screen === 'own-record') {
    const label = state.host.split('.')[0];
    const message = state.check ? domainCheckMessage(state.check, expected) : null;
    const passed = state.check?.result === 'found';
    return (
      <Card innerRef={rootRef}>
        <Heading>{T.recordTitle}</Heading>
        <dl className="flex flex-col divide-y divide-white/10 rounded-xl border border-white/10">
          {[
            { term: 'Name', value: label },
            { term: 'Type', value: 'A' },
            { term: 'Address', value: serverAddress },
          ].map((row) => (
            <div key={row.term} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <dt className="text-sm text-white/50 w-20">{row.term}</dt>
              <dd className="flex flex-1 flex-wrap items-center justify-end gap-2 text-sm text-white/90 m-0">
                {row.value ? (
                  <>
                    <code className="break-all">{row.value}</code>
                    <CopyButton value={row.value} />
                  </>
                ) : serverError ? (
                  <span className="text-red-400">{T.unreachable}</span>
                ) : (
                  <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-label="Loading" />
                )}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-sm text-white/60">{T.recordCloudflare}</p>
        <div aria-live="polite" className="mt-4 min-h-6">
          {passed ? (
            <p className="text-sm text-emerald-400 flex items-center gap-2">
              <Check className="w-4 h-4" aria-hidden="true" />
              {T.found}
            </p>
          ) : message ? (
            <p role="alert" className="text-sm text-amber-300 flex items-start gap-2">
              <TriangleAlert className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
              {message}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 mt-6">
          {passed ? (
            <PrimaryButton onClick={() => dispatch({ type: 'continue' })}>{T.buttons.continue}</PrimaryButton>
          ) : (
            <PrimaryButton onClick={checkDomain} disabled={checking || !serverAddress}>
              {checking ? 'Checking…' : state.check ? T.buttons.checkAgain : T.buttons.check}
            </PrimaryButton>
          )}
        </div>
      </Card>
    );
  }

  if (state.screen === 'unavailable') {
    const fallback = serverAddress ? fallbackAddress(serverAddress) : null;
    return (
      <Card innerRef={rootRef}>
        <Heading>{unavailableMessage(state.reason)}</Heading>
        {fallback ? (
          <p className="text-sm text-white/70">{T.unavailableBody(fallback)}</p>
        ) : (
          <p className="text-sm text-white/70">{serverError ? T.unreachable : 'Reading your server address…'}</p>
        )}
        <div className="flex flex-wrap justify-end gap-2 mt-6">
          <SecondaryButton onClick={() => dispatch({ type: 'retry' })}>{T.buttons.tryAgain}</SecondaryButton>
          <SecondaryButton onClick={() => dispatch({ type: 'use-own-domain' })}>{T.buttons.useOwnDomain}</SecondaryButton>
          <PrimaryButton
            onClick={() => fallback && dispatch({ type: 'use-server-address', address: fallback })}
            disabled={!fallback}
          >
            {T.buttons.useServerAddress}
          </PrimaryButton>
        </div>
      </Card>
    );
  }

  if (state.screen === 'padlock-failed') {
    return (
      <Card innerRef={rootRef}>
        <Heading>{T.padlockFailed(state.reason)}</Heading>
        <details className="text-sm text-white/50">
          <summary className="cursor-pointer">{T.showDetails}</summary>
          <p className="mt-2 break-all">{state.name}</p>
        </details>
        <div className="flex justify-end mt-6">
          <PrimaryButton onClick={() => dispatch({ type: 'retry' })}>{T.buttons.tryAgain}</PrimaryButton>
        </div>
      </Card>
    );
  }

  return null;
}
