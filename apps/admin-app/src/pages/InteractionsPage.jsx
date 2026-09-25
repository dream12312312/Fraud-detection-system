import React, { useCallback, useEffect, useState } from 'react';
import { api, getAccessToken } from '../api.js';
import { useAdminData, useAction, PageHead, Empty, Drawer, Confirm, KV, int, timeAgo } from '../ui.jsx';
import '../interactions.css';

/**
 * User interactions: the separate `sentinelpay_interactions` database.
 * Browse, filter, export and clean up what people did in the product.
 * Every number comes from that database through /admin/interactions.
 */

const CAT = {
  auth: { ico: '🔑', color: '#6366f1', label: 'Sign-in' },
  payment: { ico: '💸', color: '#3b82f6', label: 'Payments' },
  decision: { ico: '🗳️', color: '#f59e0b', label: 'Answers' },
  beneficiary: { ico: '👤', color: '#14b8a6', label: 'Payees' },
  alert: { ico: '🔔', color: '#ec4899', label: 'Alerts' },
  navigation: { ico: '🧭', color: '#8b5cf6', label: 'Page views' },
  ui: { ico: '🖱️', color: '#06b6d4', label: 'Clicks' },
  admin: { ico: '🛠️', color: '#64748b', label: 'Admin actions' }
};
const cat = (c) => CAT[c] || { ico: '•', color: '#94a3b8', label: c };
const bytes = (b) => (b == null ? '—' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const EMPTY = { category: '', type: '', source: '', label: '', userId: '', txId: '' };
const qs = (f) => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();

function PerDay({ perDay }) {
  const [hover, setHover] = useState(null);
  const end = new Date(); end.setUTCHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => new Date(end.getTime() - (13 - i) * 86400e3));
  const rows = days.map((d) => {
    const parts = perDay.filter((p) => new Date(p.day).getTime() === d.getTime());
    return { d, parts, total: parts.reduce((a, p) => a + p.n, 0) };
  });
  const max = Math.max(...rows.map((r) => r.total), 1);
  const h = hover != null ? rows[hover] : null;
  return (
    <div className="ix-days" onMouseLeave={() => setHover(null)}>
      <div className="ix-days-bars">
        {rows.map((r, i) => (
          <div key={i} className={`ix-day ${hover === i ? 'on' : ''}`} onMouseEnter={() => setHover(i)}>
            <div className="ix-day-stack" style={{ height: `${(r.total / max) * 100}%` }}>
              {r.parts.map((p) => <i key={p.category} style={{ flexGrow: p.n, background: cat(p.category).color }} />)}
            </div>
            <span>{r.d.toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(' ', ' ')}</span>
          </div>
        ))}
      </div>
      {h && (
        <div className="ix-tip" style={{ left: `${((hover + 0.5) / 14) * 100}%` }}>
          <b>{h.d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} · {h.total} events</b>
          {h.parts.length === 0 ? <div className="faint">no events</div> : h.parts.sort((a, b) => b.n - a.n).map((p) => (
            <div key={p.category}><i style={{ background: cat(p.category).color }} />{cat(p.category).label}<em>{p.n}</em></div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function InteractionsPage({ flash }) {
  const { data, reload } = useAdminData({ stats: '/admin/interactions/stats' }, 15000);
  const st = data.stats;
  const [f, setF] = useState(EMPTY);
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState(null);
  const [days, setDays] = useState(90);
  const [ask, setAsk] = useState(null);
  const [busy, run] = useAction(flash);

  const load = useCallback(async (more) => {
    try {
      const r = await api(`/admin/interactions?limit=50&${qs({ ...f, before: more || '' })}`);
      setItems((cur) => (more ? [...(cur || []), ...r.items] : r.items));
      setNext(r.nextBefore); setErr('');
    } catch (e) { setErr(e.message); setItems([]); }
  }, [f]);
  useEffect(() => { load(); }, [load]);

  const set = (k, v) => setF((x) => ({ ...x, [k]: x[k] === v ? '' : v }));
  const active = Object.entries(f).filter(([, v]) => v);

  const download = async (format) => {
    await run('export', async () => {
      const r = await fetch(`/api/v1/admin/interactions/export?${qs({ ...f, format })}`, { headers: { Authorization: `Bearer ${getAccessToken()}` } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Export failed (${r.status})`);
      const blob = await r.blob();
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || `interactions.${format}`;
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
      return name;
    }, (name) => `Downloaded ${name}`);
  };

  const remove = async () => {
    const body = { confirm: true, ...(ask === 'old' ? { olderThanDays: Number(days) } : { userId: f.userId }) };
    const r = await run('delete', () => api('/admin/interactions', { method: 'DELETE', body }), (x) => `Deleted ${int(x.deleted)} event(s).`);
    setAsk(null);
    if (r) { reload(); load(); }
  };

  const store = st?.store;
  const labels = st?.labels || {};
  const lab = (labels.legit || 0) + (labels.fraud || 0);
  const catTotal = Math.max(...(st?.byCategory || []).map((c) => c.n), 1);
  const userEmail = f.userId && (items?.find((i) => i.userId === f.userId)?.email || st?.topUsers?.find((u) => u.userId === f.userId)?.email);

  return (
    <div className="ix">
      <PageHead title="User interactions" sub="A separate database that records what people do in SentinelPay: sign-ins, payments, answers to flagged payments, page views and admin actions. Kept apart from the bank's data so it can be analysed, exported or wiped on its own.">
        <button className="btn ghost sm" onClick={() => download('csv')} disabled={busy === 'export' || !store?.connected}>⬇ CSV</button>
        <button className="btn ghost sm" onClick={() => download('jsonl')} disabled={busy === 'export' || !store?.connected}>⬇ JSON Lines</button>
        <button className="btn sm" onClick={() => { reload(); load(); }}>Refresh</button>
      </PageHead>

      {/* store status */}
      <div className={`ix-store ${store ? (store.connected ? 'ok' : 'bad') : ''}`}>
        <div className="ix-store-db">
          <span className="ix-db-ico">🗃️</span>
          <div>
            <div className="ix-db-name">{store?.database || 'sentinelpay_interactions'}</div>
            <div className="ix-db-state"><span className="ix-dot" />{!store ? 'checking…' : store.connected ? 'connected · separate MongoDB database' : `not connected${store.lastError ? `: ${store.lastError}` : ''}`}</div>
          </div>
        </div>
        {[
          ['Events', int(st?.total)],
          ['People', int(st?.users)],
          ['Size on disk', bytes(st?.size?.storageBytes)],
          ['Oldest', st?.oldest ? timeAgo(st.oldest) : '—'],
          ['Newest', st?.newest ? timeAgo(st.newest) : '—'],
          ['Written / dropped', store ? `${int(store.written)} / ${int(store.dropped)}` : '—']
        ].map(([l, v]) => <div key={l} className="ix-stat"><b>{v}</b><span>{l}</span></div>)}
      </div>

      {st && !st.total ? (
        <div className="card"><Empty icon="🗃️" title="No interactions yet" text="Events appear as soon as someone signs in, sends money or opens a page in the customer app." /></div>
      ) : (
        <>
          <div className="ix-grid">
            <div className="card">
              <div className="card-title"><h3><span className="ico">📅</span> Events per day</h3><span className="faint" style={{ fontSize: 12 }}>last 14 days (UTC)</span></div>
              {st ? <PerDay perDay={st.perDay || []} /> : <div className="faint">Loading…</div>}
            </div>
            <div className="card">
              <div className="card-title"><h3><span className="ico">🧩</span> By kind</h3><span className="faint" style={{ fontSize: 12 }}>click to filter</span></div>
              <div className="ix-cats">
                {(st?.byCategory || []).map((c) => (
                  <button key={c.category} className={f.category === c.category ? 'on' : ''} onClick={() => set('category', c.category)}>
                    <span className="ix-cat-ico" style={{ background: `${cat(c.category).color}22` }}>{cat(c.category).ico}</span>
                    <span className="ix-cat-l">{cat(c.category).label}</span>
                    <span className="ix-cat-bar"><i style={{ width: `${(c.n / catTotal) * 100}%`, background: cat(c.category).color }} /></span>
                    <b>{int(c.n)}</b>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="ix-grid three">
            <div className="card ix-labels">
              <div className="card-title"><h3><span className="ico">🏷️</span> Answers to flagged payments</h3></div>
              <div className="ix-lab-nums">
                <div className="legit"><b>{int(labels.legit || 0)}</b><span>“Yes, it was me”</span></div>
                <div className="fraud"><b>{int(labels.fraud || 0)}</b><span>“Not me, fraud”</span></div>
              </div>
              <div className="ix-lab-bar">{lab ? <><i className="legit" style={{ flexGrow: labels.legit || 0 }} /><i className="fraud" style={{ flexGrow: labels.fraud || 0 }} /></> : <i className="none" />}</div>
              <p className="ix-note">Real customer answers, stored with a <code>legit</code> / <code>fraud</code> label and the payment's <code>txId</code>. They can later be joined with the lakehouse and used as training labels.</p>
              <button className="btn ghost sm" onClick={() => setF(f.label === 'any' ? EMPTY : { ...EMPTY, label: 'any' })} disabled={!lab}>{f.label === 'any' ? 'Show all events' : 'Show labelled events'}</button>
            </div>
            <div className="card">
              <div className="card-title"><h3><span className="ico">🔥</span> Most common events</h3></div>
              <div className="ix-types">
                {(st?.byType || []).slice(0, 8).map((t) => (
                  <button key={t.type} className={f.type === t.type ? 'on' : ''} onClick={() => set('type', t.type)}>
                    <span style={{ color: cat(t.category).color }}>{cat(t.category).ico}</span><code>{t.type}</code><b>{int(t.n)}</b>
                  </button>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="card-title"><h3><span className="ico">👥</span> Most active people</h3></div>
              <div className="ix-types">
                {(st?.topUsers || []).map((u) => (
                  <button key={u.userId} className={f.userId === u.userId ? 'on' : ''} onClick={() => set('userId', u.userId)} title={u.userId}>
                    <span className="ix-av">{(u.email || '?').slice(0, 2).toUpperCase()}</span>
                    <span className="ix-who">{u.email || <span className="faint">deleted user</span>}<em>{timeAgo(u.last)}</em></span>
                    <b>{int(u.n)}</b>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* explorer */}
      <div className="card ix-explorer">
        <div className="card-title"><h3><span className="ico">🔎</span> Event explorer</h3><span className="faint" style={{ fontSize: 12 }}>newest first</span></div>
        <div className="ix-filters">
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            <option value="">All kinds</option>
            {Object.keys(CAT).map((c) => <option key={c} value={c}>{CAT[c].ico} {CAT[c].label}</option>)}
          </select>
          <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
            <option value="">Server + app</option><option value="server">Recorded by the server</option><option value="client">Sent by the app</option>
          </select>
          <select value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })}>
            <option value="">Any label</option><option value="any">Labelled only</option><option value="legit">legit</option><option value="fraud">fraud</option>
          </select>
          <input placeholder="Payment id (TX…)" value={f.txId} onChange={(e) => setF({ ...f, txId: e.target.value.trim() })} />
          {active.length > 0 && <button className="btn ghost sm" onClick={() => setF(EMPTY)}>Clear filters</button>}
        </div>
        {active.length > 0 && (
          <div className="ix-chips">
            {active.map(([k, v]) => <button key={k} onClick={() => setF({ ...f, [k]: '' })}>{k}: <b>{k === 'userId' ? userEmail || v.slice(-6) : v}</b> ✕</button>)}
          </div>
        )}
        {err ? <div className="flash error"><span>⛔</span><div>{err}</div></div> : !items ? <div className="faint">Loading…</div> : items.length === 0 ? (
          <Empty icon="🔎" title="Nothing matches" text="Try removing a filter." />
        ) : (
          <>
            <div className="ix-list">
              {items.map((i) => (
                <button key={i._id} className="ix-row" onClick={() => setSel(i)}>
                  <span className="ix-row-ico" style={{ background: `${cat(i.category).color}22`, color: cat(i.category).color }}>{cat(i.category).ico}</span>
                  <span className="ix-row-main">
                    <code>{i.type}</code>
                    <span className="faint">{i.email || (i.userId ? `user …${i.userId.slice(-6)}` : 'anonymous')}{i.target ? ` · ${i.target}` : ''}{i.txId ? ` · ${i.txId}` : ''}</span>
                  </span>
                  {i.label && <span className={`ix-lab ${i.label}`}>{i.label}</span>}
                  <span className={`ix-src ${i.source}`}>{i.source === 'server' ? 'server' : i.app}</span>
                  <span className="faint ix-when" title={new Date(i.ts).toLocaleString()}>{timeAgo(i.ts)}</span>
                </button>
              ))}
            </div>
            {next && <div style={{ textAlign: 'center', marginTop: 12 }}><button className="btn ghost sm" onClick={() => load(next)}>Load older events</button></div>}
          </>
        )}
      </div>

      {/* retention */}
      <div className="card ix-retain">
        <div className="card-title"><h3><span className="ico">🧹</span> Keep the database tidy</h3></div>
        <div className="ix-retain-row">
          <div>
            <b>Delete old events</b>
            <p className="faint">Remove everything older than a number of days. Labelled answers are deleted too, so export them first if you want to keep them.</p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <input type="number" min="1" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 90 }} /> days
            <button className="btn danger sm" onClick={() => setAsk('old')} disabled={!store?.connected || !(Number(days) >= 1)}>Delete…</button>
          </div>
        </div>
        <div className="ix-retain-row">
          <div>
            <b>Forget one person</b>
            <p className="faint">{f.userId ? <>Delete every event of <b>{userEmail || f.userId}</b>.</> : 'Pick a person under “Most active people” first. Deleting a user in Users & money also removes their events.'}</p>
          </div>
          <button className="btn danger sm" onClick={() => setAsk('user')} disabled={!store?.connected || !f.userId}>Delete their events…</button>
        </div>
      </div>

      {sel && (
        <Drawer title={sel.type} sub={new Date(sel.ts).toLocaleString()} onClose={() => setSel(null)}>
          <KV rows={[
            ['Kind', `${cat(sel.category).ico} ${cat(sel.category).label}`],
            ['Recorded by', sel.source === 'server' ? 'the server (trusted)' : `the ${sel.app}`],
            ['Person', sel.email || sel.userId],
            ['Role', sel.role],
            ['Session', sel.sessionId && <code>{sel.sessionId}</code>],
            ['Target', sel.target],
            ['Payment', sel.txId],
            ['Label', sel.label]
          ]} />
          <h4 style={{ margin: '16px 0 6px' }}>Details</h4>
          <pre className="ix-json">{JSON.stringify(sel.props || {}, null, 2)}</pre>
          <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {sel.userId && <button className="btn ghost sm" onClick={() => { setF({ ...EMPTY, userId: sel.userId }); setSel(null); }}>All events of this person</button>}
            {sel.txId && <button className="btn ghost sm" onClick={() => { setF({ ...EMPTY, txId: sel.txId }); setSel(null); }}>Everything about {sel.txId}</button>}
          </div>
        </Drawer>
      )}

      {ask && (
        <Confirm title={ask === 'old' ? `Delete events older than ${days} days?` : 'Delete this person’s events?'} danger confirmLabel="Delete permanently" busy={busy === 'delete'} onCancel={() => setAsk(null)} onConfirm={remove}>
          This permanently removes interaction events from <b>{store?.database}</b>. Banking data (accounts, payments) is not touched.
        </Confirm>
      )}
    </div>
  );
}
