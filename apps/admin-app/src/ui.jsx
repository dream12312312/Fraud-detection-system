import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const int = (n) => (n == null ? '—' : Number(n).toLocaleString());
export const fmt = (v, d = 3) => (v == null ? '—' : Number(v).toFixed(d));
export const pct = (v) => (v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`);
export const timeAgo = (iso) => {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};
export const duration = (a, b) => {
  if (!a) return '—';
  const s = Math.max(0, Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/**
 * Poll a set of admin endpoints. Each page asks only for what it shows, so a
 * page that is not open costs nothing. Returns { data, errors, reload, loading }.
 */
export function useAdminData(endpoints, intervalMs = 10000) {
  const [data, setData] = useState({});
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify(endpoints);
  const alive = useRef(true);

  // Each endpoint renders as soon as it answers — a slow Databricks call must
  // not hold back the fast MongoDB ones.
  const reload = useCallback(async () => {
    await Promise.allSettled(Object.entries(endpoints).map(([name, path]) => api(path).then(
      (value) => {
        if (!alive.current) return;
        setData((d) => ({ ...d, [name]: value }));
        setErrors((e) => { if (!(name in e)) return e; const { [name]: _drop, ...rest } = e; return rest; });
      },
      (err) => { if (alive.current) setErrors((e) => ({ ...e, [name]: err?.message || 'failed' })); }
    )));
    if (alive.current) setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    alive.current = true;
    reload();
    const t = setInterval(reload, intervalMs);
    return () => { alive.current = false; clearInterval(t); };
  }, [reload, intervalMs]);

  return { data, errors, reload, loading };
}

/** Run an async action with busy state + flash message. */
export function useAction(flash) {
  const [busy, setBusy] = useState(null);
  const run = async (name, fn, okText) => {
    setBusy(name);
    try {
      const r = await fn();
      if (okText) flash('ok', typeof okText === 'function' ? okText(r) : okText);
      return r;
    } catch (err) {
      flash('error', err.message);
      return null;
    } finally {
      setBusy(null);
    }
  };
  return [busy, run];
}

export function Empty({ icon, title, text, children }) {
  return (
    <div className="empty">
      <div className="icon">{icon}</div>
      <h4>{title}</h4>
      <p>{text}</p>
      {children && <div style={{ marginTop: 14 }}>{children}</div>}
    </div>
  );
}

export const RiskBadge = ({ p }) => {
  if (p == null) return <span className="faint">—</span>;
  const cls = p >= 0.7 ? 'HIGH' : p >= 0.3 ? 'MEDIUM' : 'LOW';
  return <span className={`badge ${cls}`}>{Math.round(p * 100)}%</span>;
};

export function PageHead({ title, sub, children }) {
  return (
    <div className="page-head row between" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0 }}>
        <h2>{title}</h2>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {children && <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>{children}</div>}
    </div>
  );
}

export function Kpi({ label, value, tone, hint, onClick }) {
  return (
    <div className={`kpi ${onClick ? 'clickable' : ''}`} title={hint} onClick={onClick}>
      <div className="v" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export function StateDot({ state }) {
  const cls = { ok: 'ok', running: 'run', missing: 'warn', warn: 'warn', error: 'bad', idle: 'idle' }[state] || 'idle';
  return <span className={`sdot ${cls}`} />;
}

export function BarChart({ data, height = 150, color = 'var(--primary)' }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="chart" style={{ height }}>
      {data.map((d, i) => (
        <div key={i} className="chart-col" title={`${d.label}: ${d.value}${d.sub ? ` · ${d.sub}` : ''}`}>
          <span className="chart-val">{d.value || ''}</span>
          <div className="chart-bar" style={{ height: `${Math.max((d.value / max) * 80, d.value ? 3 : 1)}%`, background: color }} />
          <span className="chart-label">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Horizontal grouped bars: compare several metrics across a few series. */
export function CompareBars({ metrics, series }) {
  return (
    <div className="cmp">
      {metrics.map(([key, label]) => (
        <div key={key} className="cmp-row">
          <div className="cmp-label">{label}</div>
          <div className="cmp-bars">
            {series.map((s) => {
              const v = s.values?.[key];
              return (
                <div key={s.name} className="cmp-bar-line" title={`${s.name}: ${fmt(v)}`}>
                  <div className="cmp-bar" style={{ width: `${v == null ? 0 : Math.max(v * 100, 1)}%`, background: s.color }} />
                  <span className="cmp-val">{fmt(v)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="cmp-legend">
        {series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}
      </div>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="seg" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'on' : ''} onClick={() => onChange(t.id)}>
          {t.label}{t.count != null && <span className="seg-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Drawer({ title, sub, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className={`drawer ${wide ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="drawer-head">
          <div style={{ minWidth: 0 }}>
            <h3>{title}</h3>
            {sub && <div className="faint" style={{ fontSize: 13 }}>{sub}</div>}
          </div>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/** Confirmation dialog for actions that cost money or change data. */
export function Confirm({ title, children, confirmLabel = 'Confirm', danger, onConfirm, onCancel, busy }) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div style={{ color: 'var(--text-dim)', fontSize: 13.5, margin: '8px 0 4px' }}>{children}</div>
        <div className="actions">
          <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className={`btn ${danger ? 'danger' : ''}`} onClick={onConfirm} disabled={busy}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function KV({ rows }) {
  return (
    <table className="arch-kv">
      <tbody>
        {rows.filter(Boolean).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v == null || v === '' ? '—' : v}</td></tr>)}
      </tbody>
    </table>
  );
}

export function ExtLink({ href, children }) {
  if (!href) return null;
  return <a className="ext" href={href} target="_blank" rel="noopener noreferrer">{children} ↗</a>;
}
