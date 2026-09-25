import React from 'react';

/*
 * Small inline SVG tech illustrations for page headers and empty space.
 * Pure vector, no downloads, themed with the app palette; the dashes/dots use
 * CSS animation classes (.art-flow, .art-blink) that respect reduced motion.
 */

const Defs = ({ id }) => (
  <defs>
    <linearGradient id={`${id}-a`} x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stopColor="#4f7cff" />
      <stop offset="1" stopColor="#8b5cf6" />
    </linearGradient>
    <linearGradient id={`${id}-b`} x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stopColor="#f97316" />
      <stop offset="1" stopColor="#ff3621" />
    </linearGradient>
    <linearGradient id={`${id}-c`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#34d399" />
      <stop offset="1" stopColor="#06b6d4" />
    </linearGradient>
    <radialGradient id={`${id}-glow`}>
      <stop offset="0" stopColor="#4f7cff" stopOpacity=".45" />
      <stop offset="1" stopColor="#4f7cff" stopOpacity="0" />
    </radialGradient>
  </defs>
);

/** Source → Bronze → Silver → Gold → Model: the lakehouse flow in one strip. */
export function PipelineArt({ className = '' }) {
  const id = 'pl';
  const stops = [
    [40, 'DB', `url(#${id}-c)`], [130, 'B', '#cd7f32'], [220, 'S', '#c0c8d8'], [310, 'G', '#f5c542'], [400, 'ML', `url(#${id}-a)`]
  ];
  return (
    <svg className={`art ${className}`} viewBox="0 0 440 120" aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="220" cy="60" rx="210" ry="55" fill={`url(#${id}-glow)`} />
      <path d="M40 60 H400" stroke="#2f4670" strokeWidth="3" />
      <path className="art-flow" d="M40 60 H400" stroke={`url(#${id}-b)`} strokeWidth="3" strokeDasharray="6 14" />
      {stops.map(([x, t, fill]) => (
        <g key={t} transform={`translate(${x} 60)`}>
          {t === 'DB' ? (
            <g>
              <ellipse cx="0" cy="-16" rx="20" ry="7" fill={fill} />
              <rect x="-20" y="-16" width="40" height="30" fill={fill} opacity=".85" />
              <ellipse cx="0" cy="14" rx="20" ry="7" fill={fill} />
              <ellipse cx="0" cy="-16" rx="20" ry="7" fill="none" stroke="#fff" strokeOpacity=".4" />
            </g>
          ) : t === 'ML' ? (
            <g>
              <polygon points="0,-24 21,-12 21,12 0,24 -21,12 -21,-12" fill={fill} />
              <circle r="5" fill="#fff" className="art-blink" />
            </g>
          ) : (
            <g>
              <ellipse cx="0" cy="6" rx="24" ry="9" fill={fill} opacity=".45" />
              <ellipse cx="0" cy="0" rx="24" ry="9" fill={fill} />
              <text y="4" textAnchor="middle" fontSize="11" fontWeight="800" fill="#0b1220">{t}</text>
            </g>
          )}
        </g>
      ))}
    </svg>
  );
}

/** A small neural network with firing nodes. */
export function NeuralArt({ className = '' }) {
  const id = 'nn';
  const layers = [[20, 45, 70, 95], [30, 60, 90], [40, 80], [60]];
  const xs = [40, 120, 200, 280];
  const edges = [];
  layers.forEach((ys, li) => {
    if (li === layers.length - 1) return;
    ys.forEach((y1) => layers[li + 1].forEach((y2) => edges.push([xs[li], y1, xs[li + 1], y2])));
  });
  return (
    <svg className={`art ${className}`} viewBox="0 0 320 120" aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="160" cy="60" rx="150" ry="55" fill={`url(#${id}-glow)`} />
      {edges.map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#4f7cff" strokeOpacity=".28" strokeWidth="1.2" />
      ))}
      {layers.map((ys, li) => ys.map((y, i) => (
        <circle key={`${li}-${i}`} cx={xs[li]} cy={y} r={li === 3 ? 10 : 7} fill={li === 3 ? '#eab308' : `url(#${id}-a)`}
          className={(li + i) % 2 ? 'art-blink' : ''} style={{ animationDelay: `${(li * 0.3 + i * 0.2).toFixed(1)}s` }} />
      )))}
    </svg>
  );
}

/** Cloud lakehouse with stacked layers. */
export function LakehouseArt({ className = '' }) {
  const id = 'lh';
  return (
    <svg className={`art ${className}`} viewBox="0 0 240 120" aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="120" cy="62" rx="115" ry="55" fill={`url(#${id}-glow)`} />
      <path d="M70 48 a24 24 0 0 1 44 -14 a20 20 0 0 1 36 8 a16 16 0 0 1 2 32 H74 a14 14 0 0 1 -4 -26z" fill="none" stroke={`url(#${id}-a)`} strokeWidth="3" />
      {[['#cd7f32', 86], ['#c0c8d8', 96], ['#f5c542', 106]].map(([c, y]) => (
        <rect key={y} x="84" y={y} width="72" height="7" rx="3.5" fill={c} opacity=".9" />
      ))}
      <path className="art-flow" d="M120 74 V84" stroke="#f97316" strokeWidth="3" strokeDasharray="3 4" />
    </svg>
  );
}

/** Shield with a check: security / fraud protection. */
export function ShieldArt({ className = '' }) {
  const id = 'sh';
  return (
    <svg className={`art ${className}`} viewBox="0 0 160 120" aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="80" cy="60" rx="75" ry="55" fill={`url(#${id}-glow)`} />
      <path d="M80 12 L118 26 V58 C118 82 100 100 80 108 C60 100 42 82 42 58 V26 Z" fill={`url(#${id}-a)`} opacity=".9" />
      <path d="M62 60 L76 74 L100 48" fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="80" cy="60" r="52" fill="none" stroke="#4f7cff" strokeOpacity=".25" strokeDasharray="4 6" className="art-spin" />
    </svg>
  );
}

/** Server rack with blinking LEDs. */
export function ServerArt({ className = '' }) {
  const id = 'sv';
  return (
    <svg className={`art ${className}`} viewBox="0 0 160 120" aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="80" cy="60" rx="75" ry="55" fill={`url(#${id}-glow)`} />
      {[20, 50, 80].map((y, i) => (
        <g key={y}>
          <rect x="40" y={y} width="80" height="24" rx="5" fill="#16213a" stroke={`url(#${id}-a)`} strokeWidth="2" />
          <circle cx="54" cy={y + 12} r="3.5" fill={i === 1 ? '#fbbf24' : '#34d399'} className="art-blink" style={{ animationDelay: `${i * 0.4}s` }} />
          <rect x="66" y={y + 10} width="44" height="4" rx="2" fill="#2f4670" />
        </g>
      ))}
    </svg>
  );
}

/** People network: users connected to the platform. */
export function UsersArt({ className = '' }) {
  const id = 'us';
  const people = [[40, 70], [80, 40], [120, 70], [160, 45], [200, 72]];
  return (
    <svg className={`art ${className}`} viewBox="0 0 240 120" aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="120" cy="62" rx="115" ry="55" fill={`url(#${id}-glow)`} />
      {people.slice(1).map(([x, y], i) => (
        <line key={i} x1={people[i][0]} y1={people[i][1]} x2={x} y2={y} stroke="#4f7cff" strokeOpacity=".35" strokeWidth="2" className="art-flow" strokeDasharray="4 5" />
      ))}
      {people.map(([x, y], i) => (
        <g key={i} transform={`translate(${x} ${y})`}>
          <circle r="15" fill="#16213a" stroke={i === 2 ? `url(#${id}-c)` : `url(#${id}-a)`} strokeWidth="2.5" />
          <circle cy="-4" r="4.5" fill="#a8b6cf" />
          <path d="M-7 8 a7 6 0 0 1 14 0" fill="#a8b6cf" />
        </g>
      ))}
    </svg>
  );
}
