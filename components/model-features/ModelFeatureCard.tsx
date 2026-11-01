'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Brain, Loader2, TriangleAlert } from 'lucide-react';
import {
  MODEL_FEATURE_COPY as T,
  confirmLabel,
  confirmLevelLabel,
  decodeChoice,
  encodeChoice,
  groupByProvider,
  initialCardState,
  nextCardState,
  optionLabel,
  saveIntent,
  sameModel,
  sendsIntro,
  statusLine,
  takeIntent,
  toggleIsOn,
  type ModelFeatureClient,
  type ModelFeatureData,
} from '@/lib/model-feature-card';

interface ModelFeatureCardProps {
  featureId: string;
  /** The server client. The preview and the tests pass a pretend one. */
  client: ModelFeatureClient;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Loads the feature, then draws it. Every model feature screen reuses this one component. */
export function ModelFeatureCard({ featureId, client }: ModelFeatureCardProps) {
  const [data, setData] = useState<ModelFeatureData | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    client
      .load(featureId)
      .then((d) => alive && setData(d))
      .catch(() => alive && setLoadFailed(true));
    return () => {
      alive = false;
    };
  }, [client, featureId, attempt]);

  if (loadFailed) {
    return (
      <div className="glass-card p-6" role="alert">
        <p className="text-sm text-white/80">{T.loadFailed}</p>
        <button type="button" onClick={() => {
            setLoadFailed(false);
            setAttempt((n) => n + 1);
          }} className="glass-button mt-3 px-4 py-2 text-sm text-white/80">
          {T.retry}
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="glass-card p-6 flex items-center gap-2 text-sm text-white/60" role="status">
        <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        {T.loading}
      </div>
    );
  }
  return <CardBody data={data} client={client} />;
}

function CardBody({ data, client }: { data: ModelFeatureData; client: ModelFeatureClient }) {
  const { feature, options } = data;
  const [state, dispatch] = useReducer(nextCardState, feature, initialCardState);
  const params = useSearchParams();
  const resumeId = params.get('resume');
  const resumed = useRef(false);

  // Coming back from the key page: finish the switch-on the person already confirmed.
  useEffect(() => {
    if (resumed.current || resumeId !== feature.id) return;
    resumed.current = true;
    const intent = takeIntent(storage(), feature.id);
    if (intent) dispatch({ type: 'resume', choice: intent.choice, level: intent.level });
  }, [resumeId, feature.id]);

  // Send the request the reducer prepared. One request for each time the stage becomes saving.
  const request = state.stage === 'saving' ? state.request : null;
  useEffect(() => {
    if (!request) return;
    let alive = true;
    client
      .update(feature.id, request)
      .then((result) => alive && dispatch({ type: 'result', result }))
      .catch(() => alive && dispatch({ type: 'result', result: { ok: false, code: 'ERROR', message: 'The server did not answer.' } }));
    return () => {
      alive = false;
    };
  }, [request, client, feature.id]);

  const groups = groupByProvider(options);
  const on = toggleIsOn(state);
  const busy = state.stage === 'saving';
  const recommended = feature.recommended;
  const recommendedShown = !sameModel(state.choice, recommended);
  const headingId = `mf-${feature.id}-title`;
  const goToKeyPage = useCallback(() => {
    if (state.choice) saveIntent(storage(), feature.id, state.choice, state.level);
  }, [state.choice, state.level, feature.id]);

  return (
    <section className="glass-card p-6 sm:p-8 flex flex-col gap-5" aria-labelledby={headingId}>
      <header className="flex items-start gap-4">
        <div
          className="hidden sm:block flex-shrink-0 p-3 rounded-xl"
          style={{ background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.25)' }}
        >
          <Brain className="w-6 h-6 text-[#60a5fa]" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 id={headingId} className="text-lg font-semibold text-white leading-tight">
            {feature.name}
          </h2>
          <p className="text-sm text-white/60 mt-1" aria-live="polite">
            {statusLine(state)}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={T.toggleLabel(feature.name)}
          disabled={busy || (!state.ready && !on)}
          onClick={() => dispatch({ type: 'toggle', on: !on })}
          className={`relative flex-shrink-0 h-7 w-12 rounded-full border transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#60a5fa] ${
            on ? 'bg-[#3b82f6] border-[#60a5fa]' : 'bg-white/10 border-white/20'
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all motion-reduce:transition-none ${on ? 'left-6' : 'left-0.5'}`}
          />
        </button>
      </header>

      {!state.ready && !on ? <p className="text-sm text-white/60">{T.notAvailableBody}</p> : null}

      <div className="flex flex-col gap-2">
        <label htmlFor={`mf-${feature.id}-model`} className="text-sm font-medium text-white/70">
          {T.modelLabel}
        </label>
        <select
          id={`mf-${feature.id}-model`}
          value={encodeChoice(state.choice)}
          disabled={busy}
          onChange={(e) => dispatch({ type: 'choose', choice: decodeChoice(e.target.value) })}
          className="w-full rounded-xl bg-white/[0.04] border border-white/10 px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#60a5fa] disabled:opacity-50"
        >
          <option value="">{T.chooseModel}</option>
          {groups.map((g) => (
            <optgroup key={g.provider} label={g.provider}>
              {g.options.map((o) => (
                <option key={encodeChoice(o)} value={encodeChoice(o)}>
                  {optionLabel(o)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <p className="text-sm text-white/60">{T.recommended(recommended)}</p>
        <p className="text-xs text-white/40">{T.recommendedNote}</p>
        {recommendedShown ? (
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() => dispatch({ type: 'choose', choice: { provider: recommended.provider, model: recommended.model } })}
              className="glass-button px-3 py-1.5 text-xs text-white/80 hover:text-white disabled:opacity-50"
            >
              {T.useRecommended}
            </button>
          </div>
        ) : null}
      </div>

      {state.levels.length > 0 && (on || state.stage === 'confirm') ? (
        <fieldset className="flex flex-col gap-2 border-0 p-0 m-0" disabled={busy}>
          <legend className="text-sm font-medium text-white/70 mb-1">{T.levelTitle}</legend>
          {state.levels.map((l) => (
            <label
              key={l.id}
              className={`flex gap-3 rounded-xl p-3 cursor-pointer border transition-colors focus-within:ring-2 focus-within:ring-[#60a5fa] ${
                state.level === l.id ? 'border-[#60a5fa] bg-[rgba(59,130,246,0.10)]' : 'border-white/10 hover:border-white/25'
              }`}
            >
              <input
                type="radio"
                name={`mf-${feature.id}-level`}
                value={l.id}
                checked={state.level === l.id}
                onChange={() => dispatch({ type: 'set-level', id: l.id })}
                className="mt-1 h-4 w-4 flex-shrink-0 appearance-none rounded-full border border-white/40 checked:border-[#60a5fa] checked:bg-[#60a5fa] checked:shadow-[inset_0_0_0_3px_#0a1020]"
              />
              <span>
                <span className="block text-sm font-medium text-white">{l.label}</span>
                {l.description ? <span className="block text-sm text-white/60 mt-0.5">{l.description}</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}

      <div className="rounded-xl border border-white/10 p-4">
        <h3 className="text-sm font-medium text-white">{T.sendsTitle}</h3>
        <p className="text-sm text-white/60 mt-1">{sendsIntro(options, state.choice)}</p>
        <ul className="mt-2 list-disc pl-5 text-sm text-white/80 flex flex-col gap-1">
          {feature.dataSent.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      <div aria-live="polite" className="flex flex-col gap-3">
        {state.stage === 'need-model' ? (
          <p role="alert" className="text-sm text-amber-300 flex items-start gap-2">
            <TriangleAlert className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
            {T.needModel}
          </p>
        ) : null}

        {state.stage === 'confirm' ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => dispatch({ type: 'confirm' })}
              className="glass-button primary px-5 py-2.5 text-sm font-medium text-white"
            >
              {state.enabled && sameModel(state.choice, state.active)
                ? confirmLevelLabel(state.levels, state.level)
                : confirmLabel(options, state.choice)}
            </button>
            <button type="button" onClick={() => dispatch({ type: 'cancel' })} className="glass-button px-4 py-2.5 text-sm text-white/70 hover:text-white">
              {T.cancel}
            </button>
          </div>
        ) : null}

        {busy ? (
          <p className="text-sm text-white/60 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {T.saving}
          </p>
        ) : null}

        {state.stage === 'key-missing' && state.keyMissing ? (
          <div role="alert" className="rounded-xl border border-amber-300/30 bg-amber-300/5 p-4">
            <p className="text-sm font-medium text-amber-200">{T.keyMissing(state.keyMissing.provider)}</p>
            <p className="text-sm text-white/60 mt-1">{T.keyMissingBody}</p>
            <div className="flex flex-wrap gap-2 mt-3">
              <a
                href={state.keyMissing.linkUrl}
                onClick={goToKeyPage}
                className="glass-button primary inline-flex items-center px-4 py-2 text-sm font-medium text-white"
              >
                {T.addKey(state.keyMissing.provider)}
              </a>
              <button type="button" onClick={() => dispatch({ type: 'cancel' })} className="glass-button px-4 py-2 text-sm text-white/70 hover:text-white">
                {T.cancel}
              </button>
            </div>
          </div>
        ) : null}

        {state.stage === 'error' ? (
          <div role="alert" className="text-sm text-red-300">
            <p>{T.error(state.error ?? '')}</p>
            <button type="button" onClick={() => dispatch({ type: 'retry' })} className="glass-button mt-2 px-4 py-2 text-sm text-white/80">
              {T.retry}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
