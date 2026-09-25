import React, { useMemo } from 'react';
import './authbg.css';

const W = 1600, H = 900, HUB = [800, 450];
const SENDERS = [[250, 170, '$'], [390, 320, '€'], [235, 470, '£'], [380, 615, '¥'], [260, 760, '₹']];
const RECEIVERS = [[1345, 175, '🏪'], [1215, 330, '🏠'], [1370, 470, '🛒'], [1220, 620, '👤'], [1340, 765, '🏦']];
// one packet per route: ok passes the shield, review waits at it, block is stopped there
const KINDS = ['ok', 'review', 'ok', 'block', 'ok', 'ok', 'review', 'ok', 'block', 'ok'];

const bez = (a, c1, c2, b, t) => {
  const u = 1 - t;
  return [0, 1].map((i) => u * u * u * a[i] + 3 * u * u * t * c1[i] + 3 * u * t * t * c2[i] + t * t * t * b[i]);
};
const GATE_R = 300;
// total length, and the length up to where the curve first enters the checkpoint ring
const bezLen = (a, c1, c2, b) => {
  let len = 0, gate = null, prev = a;
  for (let i = 1; i <= 96; i++) {
    const p = bez(a, c1, c2, b, i / 96);
    len += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    if (gate == null && Math.hypot(p[0] - HUB[0], p[1] - HUB[1]) <= GATE_R) gate = len;
    prev = p;
  }
  return { len, gate: gate ?? len };
};

function routes() {
  return KINDS.map((kind, i) => {
    const s = SENDERS[i % 5], r = RECEIVERS[(i * 2 + 1) % 5];
    const a1 = [s[0] + 230, s[1]], a2 = [HUB[0] - 250, HUB[1]];
    const b1 = [HUB[0] + 250, HUB[1]], b2 = [r[0] - 230, r[1]];
    const d = `M${s[0]},${s[1]} C${a1} ${a2} ${HUB} C${b1} ${b2} ${r[0]},${r[1]}`;
    const l1 = bezLen([s[0], s[1]], a1, a2, HUB), l2 = bezLen(HUB, b1, b2, [r[0], r[1]]);
    return { kind, d, gate: +(l1.gate / (l1.len + l2.len)).toFixed(3), dur: 7 + (i % 4) * 0.9, begin: -(i * 1.37).toFixed(2) };
  });
}

function Packet({ p }) {
  const common = { dur: `${p.dur}s`, begin: `${p.begin}s`, repeatCount: 'indefinite', calcMode: 'linear' };
  if (p.kind === 'ok') {
    return <circle r="5" className="abg-pk ok"><animateMotion {...common} path={p.d} keyPoints="0;1" keyTimes="0;1" /></circle>;
  }
  if (p.kind === 'review') {
    return (
      <circle r="5.5" className="abg-pk review">
        <animateMotion {...common} path={p.d} keyPoints={`0;${p.gate};${p.gate};1`} keyTimes="0;0.25;0.5;1" />
        <animate attributeName="r" dur={common.dur} begin={common.begin} repeatCount="indefinite" values="5.5;5.5;8;5.5;8;5.5;5.5" keyTimes="0;0.25;0.31;0.37;0.43;0.5;1" />
      </circle>
    );
  }
  return (
    <circle r="5.5" className="abg-pk block">
      <animateMotion {...common} path={p.d} keyPoints={`0;${p.gate};${p.gate}`} keyTimes="0;0.3;1" />
      <animate attributeName="opacity" dur={common.dur} begin={common.begin} repeatCount="indefinite" values="1;1;0;0" keyTimes="0;0.3;0.42;1" />
      <animate attributeName="r" dur={common.dur} begin={common.begin} repeatCount="indefinite" values="5.5;5.5;20;20" keyTimes="0;0.3;0.42;1" />
    </circle>
  );
}

export function AuthBackdrop() {
  const paths = useMemo(routes, []);
  const still = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return (
    <div className="abg" aria-hidden="true">
      <div className="abg-blob b1" /><div className="abg-blob b2" /><div className="abg-blob b3" />
      <svg className="abg-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <defs>
          <pattern id="abg-dots" width="28" height="28" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1.2" className="abg-dot" />
          </pattern>
          <radialGradient id="abg-fade" cx="50%" cy="50%" r="60%">
            <stop offset="0%" stopColor="#fff" stopOpacity="1" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id="abg-mask"><rect width={W} height={H} fill="url(#abg-fade)" /></mask>
        </defs>
        <rect width={W} height={H} fill="url(#abg-dots)" mask="url(#abg-mask)" />

        <g className="abg-hub">
          <circle cx={HUB[0]} cy={HUB[1]} r="300" className="abg-ring r1" />
          <circle cx={HUB[0]} cy={HUB[1]} r="370" className="abg-ring r2" />
          <circle cx={HUB[0]} cy={HUB[1]} r="450" className="abg-ring r3" />
        </g>

        {paths.map((p, i) => <path key={i} d={p.d} className="abg-route" />)}

        {SENDERS.map(([x, y, g]) => (
          <g key={g} className="abg-node send">
            <circle cx={x} cy={y} r="24" /><text x={x} y={y + 6}>{g}</text>
          </g>
        ))}
        {RECEIVERS.map(([x, y, g]) => (
          <g key={g} className="abg-node recv">
            <circle cx={x} cy={y} r="24" /><text x={x} y={y + 7}>{g}</text>
          </g>
        ))}

        {!still && paths.map((p, i) => <Packet key={i} p={p} />)}
      </svg>
      <div className="abg-legend">
        <span className="lg-title">Every payment is checked before money moves</span>
        <span><i className="ok" />approved</span>
        <span><i className="review" />held for review</span>
        <span><i className="block" />blocked</span>
      </div>
    </div>
  );
}
