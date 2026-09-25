import React from 'react';
import { useAdminData, PageHead, StateDot, int, timeAgo } from '../ui.jsx';

function Tile({ ico, title, state, headline, rows }) {
  return (
    <div className={`card health ${state}`}>
      <div className="row between"><div className="row" style={{ gap: 10 }}><span className="health-ico">{ico}</span><h3 style={{ margin: 0 }}>{title}</h3></div><StateDot state={state} /></div>
      <div className="health-head">{headline}</div>
      {rows.map(([k, v]) => <div key={k} className="mini-kv"><span>{k}</span><b>{v}</b></div>)}
    </div>
  );
}

export default function SystemPage() {
  const { data } = useAdminData({ system: '/admin/system', status: '/admin/databricks/status' }, 10000);
  const s = data.system;
  const d = data.status;
  const fe = s?.fraudEngine ?? {};
  return (
    <>
      <PageHead title="System health" sub={`Every service the platform depends on, checked live every 10 seconds${s?.time ? ` · last check ${timeAgo(s.time)}` : ''}.`} />
      <div className="grid cols-3">
        <Tile ico="🟢" title="Node.js API" state={s ? 'ok' : 'error'} headline={s ? 'Online' : 'Unreachable'} rows={[['Port', '4000'], ['Realtime', 'Socket.IO']]} />
        <Tile ico="🗄️" title="MongoDB" state={s?.mongo?.connected ? 'ok' : 'error'} headline={s?.mongo?.connected ? 'Connected' : 'Disconnected'}
          rows={[['Users', int(s?.counts?.users)], ['Transactions', int(s?.counts?.totalTx)], ['Fraud alerts', int(s?.counts?.fraudAlerts)]]} />
        <Tile ico="🧠" title="Fraud engine" state={!fe.reachable ? 'error' : fe.modelLoaded ? 'ok' : 'warn'}
          headline={!fe.reachable ? 'Offline → fallback rules' : fe.modelLoaded ? 'ML model active' : 'Base model (rules) active'}
          rows={[['URL', fe.url || '—'], ['Mode', fe.mode || '—'], ['Features', fe.features ?? '—']]} />
        <Tile ico="🔥" title="Kafka" state={s?.kafka?.enabled ? 'ok' : 'idle'} headline={s?.kafka?.enabled ? 'Enabled' : 'Disabled (KAFKA_ENABLED=false)'}
          rows={[['Brokers', (s?.kafka?.brokers || []).join(', ') || '—'], ['Lakehouse path', s?.kafka?.enabled ? 'Kafka → bridge → volume' : 'API landing export']]} />
        <Tile ico="🧱" title="Databricks" state={!d ? 'idle' : !d.configured ? 'error' : d.ready ? 'ok' : 'warn'}
          headline={!d ? 'Checking…' : !d.configured ? 'Not configured' : d.ready ? 'Workspace ready' : 'Connected · set-up incomplete'}
          rows={[['Workspace', d?.host?.replace(/^https?:\/\//, '') || '—'], ['Catalog', d?.catalog || '—'], ['Resources ready', d?.checks ? `${d.checks.filter((c) => c.state === 'ok').length}/${d.checks.length}` : '—']]} />
        <Tile ico="🧮" title="SQL warehouse" state={d?.checks?.find((c) => c.key === 'warehouse')?.state === 'ok' ? 'ok' : 'warn'}
          headline={d?.checks?.find((c) => c.key === 'warehouse')?.detail || '—'} rows={[['Used for', 'table row counts, DDL fallback']]} />
      </div>
    </>
  );
}
