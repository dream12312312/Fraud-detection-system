import React, { Component, Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { buildArchitecture, laneStops, STATUS, LAYERS, LANES } from './graph.js';
import Fallback2D from './Fallback2D.jsx';
import { useAdminData, timeAgo } from '../ui.jsx';
import { ms } from '../flow.jsx';

// three.js is only downloaded when a 3D view is opened.
const Scene3D = lazy(() => import('./Scene3D.jsx'));

export function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return Boolean(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

class GLBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { console.error('[architecture] 3D view failed, showing 2D diagram', err); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function DetailPanel({ node, edges, nodesById, onClose, onJump }) {
  const st = STATUS[node.status] ?? STATUS.gray;
  const upstream = edges.filter((e) => e.to === node.id && nodesById[e.from]).map((e) => ({ ...e, other: nodesById[e.from] }));
  const downstream = edges.filter((e) => e.from === node.id && nodesById[e.to]).map((e) => ({ ...e, other: nodesById[e.to] }));
  const lane = LANES.find((l) => l.id === node.lane);
  return (
    <aside className="arch-panel">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="arch-layer" style={{ color: lane?.color || LAYERS[node.layer]?.color }}>
            {lane ? `${lane.label} · step ${node.step}` : LAYERS[node.layer]?.label}
          </div>
          <h3 style={{ margin: '2px 0 8px', fontSize: 18 }}>{node.label}</h3>
        </div>
        <button className="btn ghost sm" onClick={onClose} aria-label="Close details">✕</button>
      </div>
      <div className="status-pill" style={{ color: st.color, borderColor: st.color }}>
        <span className="dot" style={{ background: st.color }} /> {node.statusLabel}
      </div>
      <p className="arch-purpose">{node.purpose}</p>

      <div className="section-label">Live details</div>
      <table className="arch-kv">
        <tbody>
          {node.metrics.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v == null || v === '' ? '—' : String(v)}</td></tr>)}
        </tbody>
      </table>

      {(upstream.length > 0 || downstream.length > 0) && (
        <>
          <div className="section-label">Data flow</div>
          {upstream.map((e) => (
            <button key={`u-${e.from}`} className="arch-conn" onClick={() => onJump(e.from)}>
              <span className="faint">in ←</span> <b>{e.other.label}</b> <span className="faint">· {e.label}{e.active ? '' : ' (idle)'}</span>
            </button>
          ))}
          {downstream.map((e) => (
            <button key={`d-${e.to}`} className="arch-conn" onClick={() => onJump(e.to)}>
              <span className="faint">out →</span> <b>{e.other.label}</b> <span className="faint">· {e.label}{e.active ? '' : ' (idle)'}</span>
            </button>
          ))}
        </>
      )}

      {node.links?.length > 0 && (
        <>
          <div className="section-label">Open in the real system</div>
          <div className="arch-links">
            {node.links.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer">{l.label} ↗</a>)}
          </div>
        </>
      )}
    </aside>
  );
}

function StageList({ lanes, platform, selected, onPick, focus }) {
  return (
    <div className="stage-list">
      {lanes.map((lane) => (
        <div key={lane.id} className={`sl-lane ${focus !== 'all' && focus !== lane.id ? 'dim' : ''}`}>
          <div className="sl-head" style={{ color: lane.color }}>{lane.dir > 0 ? '→' : '←'} {lane.label}</div>
          {lane.nodes.map((nd) => (
            <button key={nd.id} className={`sl-item ${selected === nd.id ? 'on' : ''}`} onClick={() => onPick(nd.id)}>
              <span className="sl-step" style={{ background: lane.color }}>{nd.step}</span>
              <span className="sl-name">{nd.label}</span>
              <span className="sl-val">{nd.value || ''}</span>
              <span className="dot" style={{ background: STATUS[nd.status]?.color }} title={nd.statusLabel} />
            </button>
          ))}
        </div>
      ))}
      {platform && (
        <button className={`sl-item platform ${selected === 'databricks' ? 'on' : ''}`} onClick={() => onPick('databricks')}>
          <span className="sl-step" style={{ background: '#ff3621' }}>DB</span>
          <span className="sl-name">Databricks workspace</span>
          <span className="dot" style={{ background: STATUS[platform.status]?.color }} title={platform.statusLabel} />
        </button>
      )}
    </div>
  );
}

const FOCUS = [{ id: 'all', label: 'Whole pipeline' }, ...LANES.map((l) => ({ id: l.id, label: l.label }))];

export default function ArchitectureTab({ lastEvent }) {
  const { data, errors, reload } = useAdminData({
    system: '/admin/system', pipeline: '/admin/pipeline', training: '/admin/training', mlflow: '/admin/training/mlflow', stats: '/admin/stats', flow: '/admin/dataflow'
  }, 6000);
  const apiOnline = data.system ? !errors.system : errors.system ? false : null;
  const webgl = useMemo(hasWebGL, []);
  const [view, setView] = useState(webgl ? '3d' : '2d');
  const [selected, setSelected] = useState(null);
  const [focus, setFocus] = useState('all');
  const [listOpen, setListOpen] = useState(() => window.innerWidth > 1080);
  const sceneRef = useRef(null);
  const autoFocused = useRef(false);

  const { nodes, edges, trainingActive, platform, medRunning } = useMemo(
    () => buildArchitecture({ ...data, apiOnline }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.system, data.pipeline, data.training, data.mlflow, data.stats, data.flow, apiOnline]
  );
  const nodesById = useMemo(() => ({ ...Object.fromEntries(nodes.map((nd) => [nd.id, nd])), databricks: platform }), [nodes, platform]);
  const lanes = useMemo(() => laneStops(nodes), [nodes]);

  // A new payment lands in MongoDB: refresh so its block joins the "waiting to land" queue
  // right after its pulse arrives (the queue is the real count, not a local guess).
  useEffect(() => {
    if (!lastEvent?.txId) return undefined;
    const t = setTimeout(reload, 2200);
    return () => clearTimeout(t);
  }, [lastEvent?.txId, reload]);

  // Training visual mode follows the real training-run state.
  useEffect(() => {
    if (trainingActive && !autoFocused.current) { autoFocused.current = true; setFocus('train'); }
    if (!trainingActive && autoFocused.current) { autoFocused.current = false; setFocus('all'); }
  }, [trainingActive]);

  const pick = (id) => {
    setSelected(id);
    if (id && id !== 'databricks') sceneRef.current?.focusNode(id);
  };

  const counts = nodes.reduce((acc, nd) => ({ ...acc, [nd.status]: (acc[nd.status] || 0) + 1 }), {});
  const shared = { nodes, edges, selected, focus, onSelect: setSelected, showLanes: true };
  const fallback = <Fallback2D {...shared} />;
  const f = data.flow;
  const lastRun = f?.runs?.[0];

  return (
    <>
      <div className="page-head row between" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2>Live data flow</h2>
          <div className="sub">Three lanes: real-time scoring → ingestion & lakehouse → machine-learning loop. Every payment pulses along its real path; orange blocks are rows waiting for the next stage. Status comes live from the API, Databricks and MLflow.</div>
        </div>
        <div className="arch-counts">
          {['green', 'blue', 'yellow', 'red', 'gray'].filter((s) => counts[s]).map((s) => (
            <span key={s} title={STATUS[s].label}><span className="dot" style={{ background: STATUS[s].color }} />{counts[s]} {STATUS[s].label.split(' ')[0].toLowerCase()}</span>
          ))}
        </div>
      </div>

      <div className="arch-toolbar">
        <div className="seg" role="tablist" aria-label="Highlight a lane">
          {FOCUS.map((f) => <button key={f.id} role="tab" aria-selected={focus === f.id} className={focus === f.id ? 'on' : ''} onClick={() => setFocus(f.id)}>{f.label}</button>)}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {view === '3d' && <button className="btn ghost sm" onClick={() => { setSelected(null); sceneRef.current?.resetView(); }}>Reset view</button>}
          <button className="btn ghost sm" onClick={() => setListOpen((v) => !v)}>{listOpen ? 'Hide stages' : 'Show stages'}</button>
          <div className="seg">
            <button className={view === '3d' ? 'on' : ''} disabled={!webgl} title={webgl ? '' : 'WebGL is not available in this browser'} onClick={() => setView('3d')}>3D</button>
            <button className={view === '2d' ? 'on' : ''} onClick={() => setView('2d')}>2D</button>
          </div>
        </div>
      </div>

      {f && (
        <div className="arch-hud" aria-label="Live pipeline numbers">
          <div><b>{f.hot.lastHour}</b><span>payments · last hour</span></div>
          <div><b>{ms(f.hot.latency.totalP95)}</b><span>p95 payment time</span></div>
          <div className={f.goldBehind ? 'warn' : ''}><b>{f.goldBehind}</b><span>payments not in Gold yet</span></div>
          <div><b>{lastRun ? (lastRun.result || lastRun.state).charAt(0) + (lastRun.result || lastRun.state).slice(1).toLowerCase() : '—'}</b><span>{lastRun ? `last pipeline run · ${timeAgo(lastRun.startTime)}` : 'no pipeline run yet'}</span></div>
        </div>
      )}
      {!webgl && <div className="flash info"><span>ℹ️</span><div>WebGL is not available in this browser, so the 2D diagram is shown. It has the same live data.</div></div>}

      <div className={`arch-layout ${listOpen ? 'with-list' : ''}`}>
        {listOpen && <StageList lanes={lanes} platform={platform} selected={selected} onPick={pick} focus={focus} />}
        <div className={`arch-stage ${view}`}>
          {(trainingActive || medRunning) && (
            <div className="arch-banner">
              <span className="dot pulse" /> {trainingActive ? 'Training is running on Databricks — follow the yellow loop.' : 'Medallion pipeline is running on Databricks.'}
            </div>
          )}
          {view === '3d' ? (
            <GLBoundary fallback={fallback}>
              <Suspense fallback={<div className="arch-loading">Loading 3D view…</div>}>
                <Scene3D ref={sceneRef} {...shared} platform={platform} trainingActive={trainingActive} lastEvent={lastEvent} engineUp={Boolean(data.system?.fraudEngine?.reachable)} />
              </Suspense>
            </GLBoundary>
          ) : fallback}
          <div className="arch-legend">
            {Object.entries(STATUS).map(([k, s]) => <span key={k}><span className="dot" style={{ background: s.color }} />{s.label}</span>)}
            <span><i className="leg-line hot" />real-time</span><span><i className="leg-line cold" />lakehouse</span><span><i className="leg-line train" />ML</span><span><i className="leg-line manual" />manual / optional</span>
          </div>
          {selected && nodesById[selected] && (
            <DetailPanel node={nodesById[selected]} edges={edges} nodesById={nodesById} onClose={() => setSelected(null)} onJump={pick} />
          )}
        </div>
      </div>
    </>
  );
}
