import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAdminData, useAction, PageHead, Empty, RiskBadge, Drawer, KV, Tabs, Kpi, Confirm, money, timeAgo, int } from '../ui.jsx';
import { TxDetail } from './TransactionsPage.jsx';

const COUNTRIES = ['US', 'GB', 'DE', 'FR', 'CA', 'IN', 'BR', 'NG'];

function TempPasswordModal({ info, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <h3>🔑 Temporary password</h3>
        <p style={{ color: 'var(--text-dim)', fontSize: 13.5, margin: '6px 0 12px' }}>For <b>{info.email}</b>. Shown <b>once</b>: only a bcrypt hash is stored. The user must change it at next sign-in.</p>
        <div className="mono temp-pwd-box">{info.password}</div>
        <div className="actions">
          <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(info.password)}>Copy</button>
          <button className="btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function MoneyPanel({ detail, flash, reload }) {
  const [busy, run] = useAction(flash);
  const [form, setForm] = useState({ accountId: detail.accounts[0]?._id || '', direction: 'CREDIT', amount: '', reason: '' });
  const [limits, setLimits] = useState({});
  const account = detail.accounts.find((a) => a._id === form.accountId);
  const submit = (e) => {
    e.preventDefault();
    run('adjust', () => api(`/admin/accounts/${form.accountId}/adjust`, { method: 'POST', body: { direction: form.direction, amount: Number(form.amount), reason: form.reason } }),
      `${form.direction === 'CREDIT' ? 'Credited' : 'Debited'} ${money(form.amount)}.`).then((r) => { if (r) { setForm((f) => ({ ...f, amount: '', reason: '' })); reload(); } });
  };
  return (
    <>
      <div className="acct-grid">
        {detail.accounts.map((a) => (
          <div key={a._id} className={`acct ${form.accountId === a._id ? 'on' : ''}`} onClick={() => setForm((f) => ({ ...f, accountId: a._id }))}>
            <div className="faint" style={{ fontSize: 12 }}>{a.type} · <span className="mono">{a.accountNumber}</span></div>
            <div className="acct-bal">{money(a.balance)}</div>
            <div className="faint" style={{ fontSize: 12 }}>available {money(a.balance - a.heldAmount)} · held {money(a.heldAmount)}</div>
            <div className="row" style={{ gap: 6, marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
              <input type="number" min="0" step="100" placeholder={`limit ${a.dailyLimit}`} value={limits[a._id] ?? ''} onChange={(e) => setLimits({ ...limits, [a._id]: e.target.value })} style={{ padding: '6px 9px', fontSize: 12.5 }} title="Daily limit (USD)" />
              <button className="btn ghost sm" disabled={!limits[a._id] || !!busy} onClick={() => run('limit', () => api(`/admin/accounts/${a._id}`, { method: 'PATCH', body: { dailyLimit: Number(limits[a._id]) } }), 'Daily limit updated.').then((r) => { if (r) { setLimits({ ...limits, [a._id]: '' }); reload(); } })}>Set limit</button>
            </div>
          </div>
        ))}
      </div>
      {!detail.accounts.some((a) => a.type === 'SAVINGS') && (
        <button className="btn ghost sm" style={{ marginTop: 10 }} disabled={!!busy} onClick={() => run('open', () => api(`/admin/users/${detail.user._id}/accounts`, { method: 'POST', body: { type: 'SAVINGS' } }), 'Savings account opened.').then(reload)}>+ Open savings account</button>
      )}
      <div className="section-label">Credit or debit</div>
      <form onSubmit={submit}>
        <div className="form-row">
          <div className="field">
            <label>Direction</label>
            <div className="seg" style={{ width: '100%' }}>
              {['CREDIT', 'DEBIT'].map((d) => <button type="button" key={d} className={form.direction === d ? 'on' : ''} style={{ flex: 1 }} onClick={() => setForm({ ...form, direction: d })}>{d === 'CREDIT' ? '＋ Add money' : '− Remove money'}</button>)}
            </div>
          </div>
          <div className="field"><label>Amount (USD)</label><input required type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="100.00" /></div>
        </div>
        <div className="field"><label>Reason (shown to the user, kept in the ledger)</label><input required minLength={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Refund for disputed payment" /></div>
        <button className={`btn ${form.direction === 'DEBIT' ? 'danger' : 'success'}`} disabled={!!busy || !account}>
          {busy === 'adjust' ? 'Saving…' : `${form.direction === 'CREDIT' ? 'Credit' : 'Debit'} ${form.amount ? money(form.amount) : ''} ${account ? `· ${account.accountNumber}` : ''}`}
        </button>
      </form>
    </>
  );
}

function ProfilePanel({ detail, flash, reload }) {
  const u = detail.user;
  const [busy, run] = useAction(flash);
  const [form, setForm] = useState({ fullName: u.fullName, email: u.email, homeCountry: u.homeCountry || 'US', phone: u.phone || '', role: u.role });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <form onSubmit={(e) => { e.preventDefault(); run('save', () => api(`/admin/users/${u._id}`, { method: 'PATCH', body: form }), 'Profile saved.').then(reload); }}>
      <div className="form-row">
        <div className="field"><label>Full name</label><input required value={form.fullName} onChange={set('fullName')} /></div>
        <div className="field"><label>Email</label><input required type="email" value={form.email} onChange={set('email')} /></div>
      </div>
      <div className="form-row">
        <div className="field"><label>Home country</label><select value={form.homeCountry} onChange={set('homeCountry')}>{COUNTRIES.map((c) => <option key={c}>{c}</option>)}</select>
          <div className="hint">Payments to other countries score as higher risk.</div></div>
        <div className="field"><label>Phone</label><input value={form.phone} onChange={set('phone')} placeholder="optional" /></div>
        <div className="field"><label>Role</label><select value={form.role} onChange={set('role')}><option value="user">user</option><option value="admin">admin</option></select></div>
      </div>
      <button className="btn" disabled={!!busy}>{busy ? 'Saving…' : 'Save profile'}</button>
    </form>
  );
}

function SecurityPanel({ detail, flash, reload, onTempPassword, onDeleted }) {
  const u = detail.user;
  const [busy, run] = useAction(flash);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const setStatus = (status) => run(status, () => api(`/admin/users/${u._id}/status`, { method: 'PATCH', body: { status } }), `Status set to ${status}.`).then(reload);
  return (
    <>
      <div className="section-label" style={{ marginTop: 0 }}>Account status</div>
      <div className="status-choices">
        {[['ACTIVE', 'Active', 'Can sign in and pay'], ['PENDING', 'Pending', 'Waiting for approval'], ['DISABLED', 'Disabled', 'Cannot sign in'], ['BLOCKED', 'Blocked', 'Suspected fraud']].map(([s, l, d]) => (
          <button key={s} className={`status-choice ${u.status === s ? 'on' : ''}`} disabled={!!busy || u.status === s} onClick={() => setStatus(s)}>
            <span className={`badge ${s}`}>{l}</span><span className="faint" style={{ fontSize: 12 }}>{d}</span>
          </button>
        ))}
      </div>
      <div className="section-label">Credentials</div>
      <button className="btn sm" disabled={!!busy} onClick={() => run('pwd', () => api(`/admin/users/${u._id}/temp-password`, { method: 'POST' })).then((r) => { if (r) { onTempPassword({ email: u.email, password: r.temporaryPassword }); reload(); } })}>Issue temporary password</button>
      {u.mustChangePassword && <span className="badge MEDIUM" style={{ marginLeft: 8 }}>must change password</span>}
      <div className="section-label">Danger zone</div>
      <button className="btn danger sm" onClick={() => setConfirmDelete(true)}>Delete user and all data</button>
      {confirmDelete && (
        <Confirm title="Delete this user?" danger confirmLabel="Delete permanently" busy={busy === 'del'}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => run('del', () => api(`/admin/users/${u._id}`, { method: 'DELETE' }), `${u.email} deleted.`).then((r) => { setConfirmDelete(false); if (r) onDeleted(); })}>
          <b>{u.email}</b>, their {detail.accounts.length} account(s), {detail.transactions.length} transaction(s), payees and notifications are removed from MongoDB. Rows already landed in the lakehouse stay there.
        </Confirm>
      )}
    </>
  );
}

function UserDrawer({ id, onClose, flash, onListChanged }) {
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState('money');
  const [tx, setTx] = useState(null);
  const [temp, setTemp] = useState(null);
  const load = async () => {
    try { setDetail(await api(`/admin/users/${id}`)); onListChanged(); }
    catch (err) { flash('error', err.message); onClose(); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [id]);
  if (!detail) return <Drawer title="Loading…" onClose={onClose}><p className="faint">Loading user…</p></Drawer>;
  const { user: u, summary } = detail;
  const shared = { detail, flash, reload: load };
  return (
    <Drawer wide title={u.fullName} sub={`${u.email} · ${u.role} · joined ${new Date(u.createdAt).toLocaleDateString()}`} onClose={onClose}>
      <div className="kpi-row compact">
        <Kpi label="Balance" value={money(detail.accounts.reduce((a, x) => a + x.balance, 0))} />
        <Kpi label="Sent (completed)" value={money(summary.totalSent)} />
        <Kpi label="Transactions" value={int(detail.transactions.length)} />
        <Kpi label="Blocked" value={int(summary.blocked)} tone={summary.blocked ? 'danger' : undefined} />
        <Kpi label="Avg risk" value={summary.avgRisk == null ? '—' : `${Math.round(summary.avgRisk * 100)}%`} />
      </div>
      {(summary.challenged + summary.stuck) > 0 && (
        <div className="flash warn" style={{ marginTop: 12 }}><span>⚠️</span><div>{summary.challenged + summary.stuck} transaction(s) are waiting for a decision — open them in the Transactions tab below to approve or block.</div></div>
      )}
      <div style={{ margin: '14px 0' }}>
        <Tabs value={tab} onChange={setTab} tabs={[
          { id: 'money', label: 'Money' }, { id: 'tx', label: 'Transactions', count: detail.transactions.length },
          { id: 'profile', label: 'Profile' }, { id: 'payees', label: 'Payees', count: detail.beneficiaries.length },
          { id: 'security', label: 'Access' }, { id: 'notifs', label: 'Notifications' }
        ]} />
      </div>
      {tab === 'money' && (detail.accounts.length ? <MoneyPanel {...shared} /> : <Empty icon="🏦" title="No accounts" text="This user has no bank account." />)}
      {tab === 'profile' && <ProfilePanel {...shared} />}
      {tab === 'security' && <SecurityPanel {...shared} onTempPassword={setTemp} onDeleted={() => { onListChanged(); onClose(); }} />}
      {tab === 'tx' && (detail.transactions.length === 0 ? <Empty icon="🧾" title="No transactions" text="This user has not transacted yet." /> : (
        <div className="table-wrap"><table className="data clickable">
          <thead><tr><th>When</th><th>Tx</th><th>Type</th><th>Amount</th><th>Status</th><th>Risk</th></tr></thead>
          <tbody>{detail.transactions.map((t) => (
            <tr key={t._id} onClick={() => setTx({ ...t, userId: u })}>
              <td className="faint" style={{ whiteSpace: 'nowrap' }}>{timeAgo(t.createdAt)}</td>
              <td className="mono">{t.txId}</td><td className="faint">{t.type}</td>
              <td className={`amount ${t.type === 'DEPOSIT' ? 'in' : ''}`}>{t.type === 'DEPOSIT' ? '+' : '−'}{money(t.amount)}</td>
              <td><span className={`badge ${t.status}`}>{t.status === 'PENDING_RISK_CHECK' ? 'STUCK' : t.status}</span></td>
              <td><RiskBadge p={t.fraudProbability} /></td>
            </tr>))}</tbody>
        </table></div>
      ))}
      {tab === 'payees' && (detail.beneficiaries.length === 0 ? <Empty icon="👥" title="No payees" text="Payments to unknown accounts score as higher risk." /> : (
        <table className="data"><thead><tr><th>Nickname</th><th>Account</th><th>Bank</th><th /></tr></thead>
          <tbody>{detail.beneficiaries.map((b) => (
            <tr key={b._id}><td><b>{b.nickname}</b></td><td className="mono">{b.accountNumber}</td><td>{b.bankName || '—'}</td>
              <td style={{ textAlign: 'right' }}><button className="btn ghost sm" onClick={async () => { try { await api(`/admin/beneficiaries/${b._id}`, { method: 'DELETE' }); flash('ok', 'Payee removed.'); load(); } catch (e) { flash('error', e.message); } }}>Remove</button></td></tr>))}</tbody>
        </table>
      ))}
      {tab === 'notifs' && (detail.notifications.length === 0 ? <Empty icon="🔔" title="No notifications" text="Nothing sent to this user yet." /> : detail.notifications.map((n) => (
        <div key={n._id} className="notif"><div className="title">{n.title} <span className={`badge ${n.type}`}>{n.type}</span></div><div className="body">{n.body}</div><div className="time">{timeAgo(n.createdAt)}{n.read ? ' · read' : ' · unread'}</div></div>
      )))}
      {tx && <TxDetail tx={tx} flash={flash} onClose={() => setTx(null)} onChanged={load} />}
      {temp && <TempPasswordModal info={temp} onClose={() => setTemp(null)} />}
    </Drawer>
  );
}

function CreateUser({ onClose, flash, onCreated }) {
  const [busy, run] = useAction(flash);
  const [form, setForm] = useState({ fullName: '', email: '', homeCountry: 'US', initialBalance: 5000 });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); run('create', () => api('/admin/users', { method: 'POST', body: { ...form, initialBalance: Number(form.initialBalance) } }), 'User created.').then((r) => { if (r) onCreated({ email: r.user.email, password: r.temporaryPassword }); }); }}>
        <h3>Create user</h3>
        <p className="faint" style={{ fontSize: 13, margin: '4px 0 14px' }}>The account is approved immediately and gets a one-time temporary password.</p>
        <div className="field"><label>Full name</label><input required value={form.fullName} onChange={set('fullName')} /></div>
        <div className="field"><label>Email</label><input required type="email" value={form.email} onChange={set('email')} /></div>
        <div className="form-row">
          <div className="field"><label>Home country</label><select value={form.homeCountry} onChange={set('homeCountry')}>{COUNTRIES.map((c) => <option key={c}>{c}</option>)}</select></div>
          <div className="field"><label>Opening balance</label><input type="number" min="0" value={form.initialBalance} onChange={set('initialBalance')} /></div>
        </div>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={!!busy}>{busy ? 'Creating…' : 'Create user'}</button>
        </div>
      </form>
    </div>
  );
}

export default function UsersPage({ flash }) {
  const { data, reload } = useAdminData({ users: '/admin/users' }, 15000);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('recent');
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const [temp, setTemp] = useState(null);
  const users = data.users || [];
  const count = (s) => users.filter((u) => u.status === s).length;
  const shown = users
    .filter((u) => filter === 'all' || (filter === 'waiting' ? u.waitingCount > 0 : u.status === filter))
    .filter((u) => !q || `${u.fullName} ${u.email}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => sort === 'balance' ? b.balance - a.balance : sort === 'risk' ? b.blockedCount - a.blockedCount : sort === 'activity' ? b.txCount - a.txCount : new Date(b.createdAt) - new Date(a.createdAt));

  return (
    <>
      <PageHead title="Users & money" sub="Approve sign-ups, edit profiles, credit or debit balances, set limits, resolve waiting payments and manage access. Every change is logged and the user is notified." />
      <div className="kpi-row" style={{ marginBottom: 16 }}>
        <Kpi label="Users" value={int(users.length)} />
        <Kpi label="Pending approval" value={int(count('PENDING'))} tone={count('PENDING') ? 'warn' : undefined} onClick={() => setFilter('PENDING')} />
        <Kpi label="Blocked" value={int(count('BLOCKED'))} tone={count('BLOCKED') ? 'danger' : undefined} onClick={() => setFilter('BLOCKED')} />
        <Kpi label="With waiting payments" value={int(users.filter((u) => u.waitingCount > 0).length)} onClick={() => setFilter('waiting')} />
        <Kpi label="Total balances" value={money(users.reduce((a, u) => a + (u.balance || 0), 0))} />
      </div>
      <div className="toolbar">
        <Tabs value={filter} onChange={setFilter} tabs={[
          { id: 'all', label: 'All', count: users.length }, { id: 'PENDING', label: 'Pending', count: count('PENDING') },
          { id: 'ACTIVE', label: 'Active', count: count('ACTIVE') }, { id: 'BLOCKED', label: 'Blocked', count: count('BLOCKED') },
          { id: 'DISABLED', label: 'Disabled', count: count('DISABLED') }, { id: 'waiting', label: 'Waiting payments' }
        ]} />
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select value={sort} onChange={(e) => setSort(e.target.value)} style={{ width: 'auto' }}>
            <option value="recent">Newest first</option><option value="balance">Highest balance</option>
            <option value="activity">Most transactions</option><option value="risk">Most blocked</option>
          </select>
          <input placeholder="Search name or email…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 210 }} />
          <button className="btn sm" onClick={() => setCreating(true)}>+ Create user</button>
        </div>
      </div>
      <div className="card">
        {shown.length === 0 ? <Empty icon="👥" title="No users" text="Nothing matches this filter." /> : (
          <div className="table-wrap"><table className="data clickable">
            <thead><tr><th>User</th><th>Status</th><th>Country</th><th>Balance</th><th>Held</th><th>Tx</th><th>Blocked</th><th>Last activity</th><th /></tr></thead>
            <tbody>
              {shown.map((u) => (
                <tr key={u._id} onClick={() => setOpen(u._id)}>
                  <td><div className="row" style={{ gap: 10 }}><div className="avatar sm">{(u.fullName || u.email).slice(0, 2).toUpperCase()}</div><div style={{ minWidth: 0 }}><b>{u.fullName}</b>{u.role === 'admin' && <span className="badge INFO" style={{ marginLeft: 6 }}>admin</span>}<div className="faint" style={{ fontSize: 12 }}>{u.email}</div></div></div></td>
                  <td><span className={`badge ${u.status}`}>{u.status}</span>{u.mustChangePassword && <span className="badge MEDIUM" style={{ marginLeft: 4 }} title="Temporary password">TEMP</span>}</td>
                  <td>{u.homeCountry || 'US'}</td>
                  <td className="amount">{money(u.balance)}</td>
                  <td className="faint">{u.held ? money(u.held) : '—'}</td>
                  <td>{u.txCount}{u.waitingCount > 0 && <span className="badge CHALLENGED" style={{ marginLeft: 6 }}>{u.waitingCount} waiting</span>}</td>
                  <td style={{ color: u.blockedCount ? 'var(--danger)' : undefined }}>{u.blockedCount || '—'}</td>
                  <td className="faint">{u.lastTxAt ? timeAgo(u.lastTxAt) : 'never'}</td>
                  <td onClick={(e) => e.stopPropagation()} style={{ textAlign: 'right' }}>
                    {u.status === 'PENDING'
                      ? <button className="btn success sm" onClick={async () => { try { await api(`/admin/users/${u._id}/status`, { method: 'PATCH', body: { status: 'ACTIVE' } }); flash('ok', `${u.email} approved.`); reload(); } catch (e) { flash('error', e.message); } }}>Approve</button>
                      : <button className="btn ghost sm" onClick={() => setOpen(u._id)}>Manage</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
      {open && <UserDrawer id={open} flash={flash} onClose={() => setOpen(null)} onListChanged={reload} />}
      {creating && <CreateUser flash={flash} onClose={() => setCreating(false)} onCreated={(t) => { setCreating(false); setTemp(t); reload(); }} />}
      {temp && <TempPasswordModal info={temp} onClose={() => setTemp(null)} />}
    </>
  );
}
