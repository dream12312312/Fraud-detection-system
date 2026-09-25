import React, { useMemo } from 'react';
import { STATUS, LANES } from './graph.js';

const FLOW_COLOR = { hot: '#5b8cff', cold: '#ff8a3d', train: '#f5c542' };
const SX = 34; // px per scene unit (x)
const SZ = 30; // px per scene unit (z)
const W = 132;
const H = 50;

/**
 * Flat SVG version of the same model, used when WebGL is unavailable (or chosen).
 * Positions are the 3D floor coordinates (x, z) projected straight down.
 */
export default function Fallback2D({ nodes, edges, selected, focus = 'all', onSelect, showLanes }) {
  const box = useMemo(() => {
    const xs = nodes.map((nd) => nd.pos[0]);
    const zs = nodes.map((nd) => nd.pos[2]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
  }, [nodes]);
  const px = (x) => (x - box.x0) * SX + W / 2 + 20;
  const pz = (z) => (z - box.z0) * SZ + H / 2 + 24;
  const width = px(box.x1) + W / 2 + 20;
  const height = pz(box.z1) + H / 2 + 24;
  const byId = Object.fromEntries(nodes.map((nd) => [nd.id, nd]));
  const connected = selected ? new Set([selected, ...edges.filter((e) => e.from === selected || e.to === selected).flatMap((e) => [e.from, e.to])]) : null;
  const nodeFocus = (nd) => focus === 'all' || nd.lane === focus || edges.some((e) => e.flow === focus && (e.from === nd.id || e.to === nd.id));

  return (
    <svg className="arch2d" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="System architecture diagram">
      <defs>
        {Object.entries({ ...FLOW_COLOR, manual: '#94a3b8' }).map(([k, c]) => (
          <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill={c} />
          </marker>
        ))}
      </defs>
      {showLanes && LANES.map((l) => (
        <g key={l.id} opacity={focus === 'all' || focus === l.id ? 1 : 0.3}>
          <rect x="6" y={pz(l.z) - 52} width={width - 12} height="104" rx="12" fill={l.color} opacity="0.06" />
          <text x="16" y={pz(l.z) - 36} className="s" style={{ fill: l.color }}>{l.dir > 0 ? '→' : '←'} {l.label}</text>
        </g>
      ))}
      {edges.map((e) => {
        const a = byId[e.from]; const b = byId[e.to];
        if (!a || !b) return null;
        const dim = (connected && !(connected.has(e.from) && connected.has(e.to))) || (focus !== 'all' && e.flow !== focus);
        const color = e.manual ? '#94a3b8' : FLOW_COLOR[e.flow];
        const x1 = px(a.pos[0]); const y1 = pz(a.pos[2]); const x2 = px(b.pos[0]); const y2 = pz(b.pos[2]);
        const mx = (x1 + x2) / 2; const my = (y1 + y2) / 2 - Math.min(40, Math.hypot(x2 - x1, y2 - y1) * 0.12);
        return (
          <path key={`${e.from}>${e.to}`} d={`M${x1} ${y1} Q${mx} ${my} ${x2} ${y2}`} fill="none" stroke={color}
            strokeWidth={e.active ? 2.2 : 1.4} strokeDasharray={e.active && !e.manual && !e.optional ? undefined : '5 5'}
            opacity={dim ? 0.12 : e.active ? 0.9 : 0.45} markerEnd={`url(#arrow-${e.manual ? 'manual' : e.flow})`} />
        );
      })}
      {nodes.map((nd) => {
        const x = px(nd.pos[0]) - W / 2; const y = pz(nd.pos[2]) - H / 2;
        const st = STATUS[nd.status] ?? STATUS.gray;
        const dim = (connected && !connected.has(nd.id)) || !nodeFocus(nd);
        return (
          <g key={nd.id} className="arch2d-node" transform={`translate(${x} ${y})`} opacity={dim ? 0.25 : 1}
            role="button" tabIndex={0} aria-label={`${nd.label}: ${nd.statusLabel}`}
            onClick={() => onSelect(nd.id)} onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(nd.id); } }}>
            <rect width={W} height={H} rx="10" fill="#131d34" stroke={selected === nd.id ? '#fff' : st.color} strokeWidth={selected === nd.id ? 2 : 1.3} />
            <circle cx="14" cy="17" r="5" fill={st.color} />
            <text x="26" y="21" className="t">{nd.step != null ? `${nd.step}. ` : ''}{nd.label.length > 15 ? `${nd.label.slice(0, 14)}…` : nd.label}</text>
            <text x="12" y="39" className="s">{String(nd.value || nd.statusLabel).slice(0, 20)}</text>
          </g>
        );
      })}
    </svg>
  );
}
