import React, { useMemo } from 'react';
import './authbg.css';

const W = 1600, H = 900;
const BANDS = [
  ['Sources', '#60a5fa'], ['Bronze', '#c9803f'], ['Silver', '#a3b1c8'], ['Gold', '#e2b43b'], ['Model', '#8b5cf6']
];
const BW = W / BANDS.length;
const LANES = [140, 240, 340, 450, 560, 660, 770];

function streams() {
  return LANES.map((y, i) => {
    const amp = 26 + (i % 3) * 12, dir = i % 2 ? -1 : 1;
    let d = `M-40,${y}`;
    for (let x = 0; x < W; x += 320) {
      d += ` C${x + 110},${y + amp * dir} ${x + 210},${y - amp * dir} ${x + 320},${y}`;
    }
    return { d, dur: 11 + (i % 4) * 1.6, i };
  });
}

function Particle({ s, k }) {
  const dur = `${s.dur}s`, begin = `${-((s.i * 1.9 + k * s.dur / 3) % s.dur).toFixed(2)}s`;
  const c = BANDS.map((b) => b[1]);
  // path runs x = -40..1600, so these keyTimes land on each band's centre
  const fills = [c[0], ...c, c[4]].join(';');
  // lanes 2 and 5 carry records that fail the Silver quality checks
  const dropped = k === 1 && (s.i === 2 || s.i === 5);
  return (
    <circle r="5.5" className="adb-pk">
      <animateMotion dur={dur} begin={begin} repeatCount="indefinite" path={s.d} />
      <animate attributeName="fill" dur={dur} begin={begin} repeatCount="indefinite" values={fills} keyTimes="0;0.122;0.317;0.512;0.707;0.902;1" />
      {dropped && <animate attributeName="opacity" dur={dur} begin={begin} repeatCount="indefinite" values="1;1;0;0" keyTimes="0;0.5;0.56;1" />}
    </circle>
  );
}

export function AuthBackdrop() {
  const lanes = useMemo(streams, []);
  const still = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return (
    <div className="adb" aria-hidden="true">
      <svg className="adb-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="adb-stream" x1="0" x2={W} y1="0" y2="0" gradientUnits="userSpaceOnUse">
            {BANDS.map(([, c], i) => <stop key={c} offset={i / (BANDS.length - 1)} stopColor={c} />)}
          </linearGradient>
          <pattern id="adb-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0H0V40" className="adb-gridline" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#adb-grid)" />
        {BANDS.map(([name, c], i) => (
          <g key={name}>
            <rect x={i * BW} y="0" width={BW} height={H} fill={c} className="adb-band" />
            {i > 0 && <line x1={i * BW} x2={i * BW} y1="0" y2={H} className="adb-sep" />}
            <text x={i * BW + BW / 2} y="70" className="adb-label" fill={c}>{name.toUpperCase()}</text>
          </g>
        ))}
        {lanes.map((s) => <path key={s.i} d={s.d} className="adb-lane" stroke="url(#adb-stream)" />)}
        {!still && lanes.flatMap((s) => [0, 1, 2].map((k) => <Particle key={`${s.i}-${k}`} s={s} k={k} />))}
      </svg>
    </div>
  );
}
