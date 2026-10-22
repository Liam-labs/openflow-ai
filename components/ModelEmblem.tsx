'use client';

import React from 'react';
import { emblemFamily, type EmblemFamily, type EmblemState } from '@/lib/model-emblem';

// The real model logos (public/icons/platforms/*.png), cut into pieces that can move.
// While an agent works the pieces move (see the .me-* rules in globals.css):
//   thinking: breathe and turn
//   tool:     the pieces fly apart and snap back together, one after another
//   writing:  a quick ripple
// An idle emblem is the plain, uncut logo. prefers-reduced-motion switches all motion off.
// All coordinates are in a 24x24 box centred on 0,0; each logo fills -10..10.

type Vars = React.CSSProperties;
const vars = (v: Record<string, number>) => v as unknown as Vars;

const PATHS: Record<Exclude<EmblemFamily, 'openai'>, { href: string; w: number; h: number }> = {
  claude: { href: '/icons/platforms/claude.png', w: 20, h: 20 },
  gemini: { href: '/icons/platforms/gemini.png', w: 20, h: 20 },
  deepseek: { href: '/icons/platforms/deepseek.png', w: 20, h: 20 },
  grok: { href: '/icons/platforms/grok.png', w: 20, h: 19.22 },
};

function Logo({ family }: { family: Exclude<EmblemFamily, 'openai'> }) {
  const { href, w, h } = PATHS[family];
  return <image href={href} x={-w / 2} y={-h / 2} width={w} height={h} />;
}

// OpenAI has no logo file in the app yet (platform-logos.tsx draws a placeholder star),
// so this animates that same star until the real file is added.
function OpenAIStar() {
  return <path transform="translate(-12 -12)" d="M12 2L14.5 8.5L21 11L14.5 13.5L12 20L9.5 13.5L3 11L9.5 8.5L12 2Z" fill="#fff" fillOpacity="0.85" />;
}

// ---- Claude: 12 wedges, one per ray (angles measured clockwise from straight up) ----
const CLAUDE_TIPS = [10, 40, 81, 102, 130, 150, 177, 208, 233, 272, 304, 336];
const rad = (deg: number) => (deg * Math.PI) / 180;
const polar = (deg: number, r: number): [number, number] => [Math.sin(rad(deg)) * r, -Math.cos(rad(deg)) * r];

const CLAUDE_WEDGES = CLAUDE_TIPS.map((tip, i) => {
  const prev = CLAUDE_TIPS[(i + CLAUDE_TIPS.length - 1) % CLAUDE_TIPS.length];
  const next = CLAUDE_TIPS[(i + 1) % CLAUDE_TIPS.length];
  const start = (i === 0 ? prev - 360 : prev) + ((tip - (i === 0 ? prev - 360 : prev)) / 2);
  const end = tip + (((i === CLAUDE_TIPS.length - 1 ? next + 360 : next) - tip) / 2);
  const mid = (start + end) / 2;
  const pts = [[0, 0] as [number, number]];
  for (let a = start; a < end; a += 10) pts.push(polar(a, 30));
  pts.push(polar(end, 30));
  const [dx, dy] = polar(mid, 1);
  return { points: pts.map(p => p.join(',')).join(' '), dx, dy };
});

// ---- Gemini / star: four quarters ----
const QUARTERS = [
  { x: 0, y: -14, dx: 0.7, dy: -0.7 },
  { x: 0, y: 0, dx: 0.7, dy: 0.7 },
  { x: -14, y: 0, dx: -0.7, dy: 0.7 },
  { x: -14, y: -14, dx: -0.7, dy: -0.7 },
];

// ---- DeepSeek: the tail is cut out so it can flick (box in logo units) ----
const TAIL = { x: 3.2, y: -8.4, w: 7, h: 5.7 };

// ---- Grok: the slash is cut out as a band along its diagonal ----
const SLASH_BAND = (() => {
  // band in image pixels (512x492), converted to units
  const toU = (px: number, py: number) => `${(px / 512) * 20 - 10},${(py / 492) * 19.22 - 9.61}`;
  const A = [0, 497], B = [512, -5], w = 46;
  const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const n = [-(B[1] - A[1]) / len, (B[0] - A[0]) / len];
  return [
    toU(A[0] + n[0] * w, A[1] + n[1] * w), toU(B[0] + n[0] * w, B[1] + n[1] * w),
    toU(B[0] - n[0] * w, B[1] - n[1] * w), toU(A[0] - n[0] * w, A[1] - n[1] * w),
  ].join(' ');
})();

// The Grok logo is black, so (as in platform-logos.tsx) it sits on a white rounded tile.
function GrokTile({ children }: { children: React.ReactNode }) {
  return (
    <g>
      <rect x="-8.6" y="-8.6" width="17.2" height="17.2" rx="2.6" fill="#fff" />
      <g transform="scale(0.78)">{children}</g>
    </g>
  );
}

let emblemCounter = 0;

function Pieces({ family, uid }: { family: EmblemFamily; uid: string }) {
  if (family === 'claude') {
    return (
      <g className="me-turn">
        <defs>
          <clipPath id={`${uid}-core`}><circle r="3.4" /></clipPath>
          {CLAUDE_WEDGES.map((wedge, i) => <clipPath key={i} id={`${uid}-w${i}`}><polygon points={wedge.points} /></clipPath>)}
        </defs>
        <g clipPath={`url(#${uid}-core)`}><Logo family="claude" /></g>
        {CLAUDE_WEDGES.map((wedge, i) => (
          <g key={i} className="me-part me-wedge me-drift" clipPath={`url(#${uid}-w${i})`} style={vars({ '--i': i, '--dx': wedge.dx, '--dy': wedge.dy })}>
            <Logo family="claude" />
          </g>
        ))}
      </g>
    );
  }
  if (family === 'gemini' || family === 'openai') {
    return (
      <g className="me-turn">
        <defs>
          {QUARTERS.map((q, i) => <clipPath key={i} id={`${uid}-q${i}`}><rect x={q.x} y={q.y} width="14" height="14" /></clipPath>)}
        </defs>
        {QUARTERS.map((q, i) => (
          <g key={i} className="me-part me-drift" clipPath={`url(#${uid}-q${i})`} style={vars({ '--i': i, '--dx': q.dx, '--dy': q.dy })}>
            {family === 'gemini' ? <Logo family="gemini" /> : <OpenAIStar />}
          </g>
        ))}
      </g>
    );
  }
  if (family === 'deepseek') {
    return (
      <g className="me-bob">
        <defs>
          <mask id={`${uid}-body`} maskUnits="userSpaceOnUse" x="-14" y="-14" width="28" height="28">
            <rect x="-14" y="-14" width="28" height="28" fill="#fff" />
            <rect x={TAIL.x} y={TAIL.y} width={TAIL.w} height={TAIL.h} fill="#000" />
          </mask>
          <clipPath id={`${uid}-tail`}><rect x={TAIL.x} y={TAIL.y} width={TAIL.w} height={TAIL.h} /></clipPath>
        </defs>
        <g mask={`url(#${uid}-body)`}><Logo family="deepseek" /></g>
        <g className="me-part me-tail" clipPath={`url(#${uid}-tail)`}><Logo family="deepseek" /></g>
      </g>
    );
  }
  // grok: ring stays and pulses, the slash flies out along its diagonal
  return (
    <GrokTile>
      <defs>
        <mask id={`${uid}-ring`} maskUnits="userSpaceOnUse" x="-14" y="-14" width="28" height="28">
          <rect x="-14" y="-14" width="28" height="28" fill="#fff" />
          <polygon points={SLASH_BAND} fill="#000" />
        </mask>
        <clipPath id={`${uid}-slash`}><polygon points={SLASH_BAND} /></clipPath>
      </defs>
      <g className="me-part me-pulse" mask={`url(#${uid}-ring)`}><Logo family="grok" /></g>
      <g className="me-part me-drift" clipPath={`url(#${uid}-slash)`} style={vars({ '--i': 0, '--dx': 0.75, '--dy': -0.75 })}><Logo family="grok" /></g>
    </GrokTile>
  );
}

export function ModelEmblem({
  model,
  state = 'idle',
  size = 18,
  fallback = null,
}: {
  model: string | undefined | null;
  state?: EmblemState;
  size?: number;
  /** Shown when the model has no emblem. */
  fallback?: React.ReactNode;
}) {
  const family = emblemFamily(model);
  const uid = React.useMemo(() => `me${++emblemCounter}`, []);
  if (!family) return <>{fallback}</>;
  return (
    <svg
      className={`me-svg me-${state}`}
      width={size}
      height={size}
      viewBox="-12 -12 24 24"
      role="img"
      aria-label={`${family} emblem${state === 'idle' ? '' : `, ${state}`}`}
      data-family={family}
      data-state={state}
    >
      {state === 'idle'
        ? (family === 'openai' ? <OpenAIStar /> : family === 'grok' ? <GrokTile><Logo family="grok" /></GrokTile> : <Logo family={family} />)
        : <Pieces family={family} uid={uid} />}
    </svg>
  );
}
