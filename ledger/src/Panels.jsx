import { useEffect, useRef, useState } from 'react';
import { BALANCE_TYPES, EVIDENCE, KNOBS, LABELS, TX_TTL_DAYS, tx, invariants, pendingCount } from './engine.js';
import { SCENARIOS, STASH_SCENARIOS, ERROR_REGISTER, runCell, typesOf } from './scenarios.js';
import { Chip, Pill, fmt, clockStr } from './ui.jsx';

export function EventLog({ state }) {
  return (
    <div className="panel">
      <h2>Event log <span className="right sub">newest first</span></h2>
      <div className="log">
        {state.events.length === 0 && <div className="info">No events yet.</div>}
        {state.events.map((e, i) => (
          <div key={state.events.length - i}><span className="t">{clockStr(e.t)}</span><span className={e.level}>{e.msg}</span></div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── transactions ───────────────────────── */

const bucketClass = (name) => (name.endsWith('Bonus') ? 'bonus' : name.endsWith('Stash') ? 'stash' : 'main');
const ADMIN = ['acpReset', 'acpConfiscate', 'acpReplace', 'acpAdjust'].map(tx);
const PAYMENT = ['deposit', 'withdrawal', 'withdrawalReversal', 'withdrawalDecline', 'withdrawalCancel', 'tip'].map(tx);
const FILTERS = {
  all: ['All', () => true],
  primary: ['Primary', (t) => bucketClass(t.balanceType) === 'main'],
  bonus: ['Bonus', (t) => bucketClass(t.balanceType) === 'bonus'],
  stash: ['Stash', (t) => bucketClass(t.balanceType) === 'stash'],
  bets: ['Bets', (t) => [tx('bet'), tx('payout'), tx('refund'), tx('sportsbookRollback')].includes(t.type)],
  payments: ['Payments', (t) => PAYMENT.includes(t.type)],
  admin: ['Admin', (t) => ADMIN.includes(t.type)],
};

function TransactionRow({ t, isNew, open, toggle }) {
  const metaStr = t.meta ? Object.entries(t.meta).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ') : '';
  return (
    <>
      <tr className={isNew ? 'new' : ''} onClick={toggle} style={{ cursor: 'pointer' }}>
        <td className="mono faint">…{t._id.slice(-6)}</td>
        <td className="mono">{t.type}</td>
        <td><span className={`tag ${bucketClass(t.balanceType)}`} style={{ textTransform: 'none' }}>{t.balanceType}</span></td>
        <td className={`num ${t.amount < 0 ? 'neg' : t.amount > 0 ? 'pos' : ''}`}>{t.amount > 0 ? '+' : ''}{fmt(t.amount)}</td>
        <td className="num">{fmt(t.currentBalance)}</td>
        <td className="sub mono ellipsis" style={{ maxWidth: 300 }}>{metaStr}</td>
        <td className="mono faint">{clockStr(t.createdAt)}</td>
      </tr>
      {open && (
        <tr><td colSpan={7}><pre className="mono" style={{ whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>{JSON.stringify(t, null, 2)}</pre></td></tr>
      )}
    </>
  );
}

export function Transactions({ state }) {
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState(null);
  const seen = useRef(new Set());
  const all = state.mongo.transactions;
  const stashOn = state.config.stash === 'on';
  const active = filter === 'stash' && !stashOn ? 'all' : filter;
  const rows = all.filter(FILTERS[active][1]).slice(0, 150);
  useEffect(() => { rows.forEach((t) => seen.current.add(t._id)); });
  return (
    <div className="panel">
      <h2>
        transactions
        <Chip label="Meeting" text="frozen" title={EVIDENCE['L-42'].text} />
        <span className="right sub">{all.length} rows · {TX_TTL_DAYS}-day TTL · warehouse {state.warehouse.length} · click a row for the document</span>
      </h2>
      <div className="seg" style={{ marginBottom: 8 }}>
        {Object.entries(FILTERS).filter(([k]) => k !== 'stash' || stashOn).map(([k, [l]]) => (
          <button key={k} className={active === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      <div className="scroll">
        <table>
          <thead><tr><th>_id</th><th>type</th><th>balanceType</th><th style={{ textAlign: 'right' }}>amount</th><th style={{ textAlign: 'right' }}>currentBalance</th><th>meta</th><th>createdAt</th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <TransactionRow key={t._id} t={t} isNew={!seen.current.has(t._id)} open={open === t._id} toggle={() => setOpen(open === t._id ? null : t._id)} />
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="sub">No rows.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ───────────────────────── invariants ───────────────────────── */

export function Invariants({ state }) {
  const list = invariants(state);
  const groups = [...new Set(list.map((i) => i.group))];
  const failing = list.filter((i) => !i.ok);
  const mark = (i) => <span title={i.detail} style={{ color: i.ok ? 'var(--ok)' : 'var(--err)' }}>{i.ok ? '✓' : '✗'}</span>;
  return (
    <div className="panel">
      <h2>Invariants <span className="right">{failing.length ? <span className="tag err">{failing.length} violated</span> : <span className="tag ok">all hold</span>}</span></h2>
      <div className="inv" style={{ gridTemplateColumns: `minmax(0, 1fr) repeat(${BALANCE_TYPES.length}, 44px)` }}>
        <div className="h" style={{ textAlign: 'left' }}>check</div>
        {BALANCE_TYPES.map((c) => <div key={c.code} className="h">{c.label}</div>)}
        {groups.map((g) => {
          const items = list.filter((i) => i.group === g);
          const perType = items.some((i) => i.cur !== 'All');
          return (
            <div className="inv-row" key={g}>
              <div className="inv-name">
                <span>{g}</span>
                <Chip label={items[0].evLabel} />
                {items[0].scope === 'simulator' && <span className="tag muted" title="Relies on bookkeeping only the simulator has. It could not be checked against the real stores.">simulator-only</span>}
              </div>
              {perType
                ? BALANCE_TYPES.map((c) => {
                  const i = items.find((it) => it.cur === c.label);
                  return <div key={c.code} className="c">{i ? mark(i) : ''}</div>;
                })
                : <div className="c all" style={{ gridColumn: `span ${BALANCE_TYPES.length}` }}>{mark(items[0])} <span className="faint">all types</span></div>}
            </div>
          );
        })}
      </div>
      {failing.length > 0 && (
        <ul className="inv-fail">
          {failing.slice(0, 8).map((i) => <li key={i.id}><strong>{i.group}{i.cur !== 'All' ? ` (${i.cur})` : ''}:</strong> <span className="mono">{i.detail}</span></li>)}
          {failing.length > 8 && <li className="faint">and {failing.length - 8} more</li>}
        </ul>
      )}
      <p className="sub" style={{ marginTop: 10 }}>Hover a mark for the numbers. The badge is the evidence label of the rule. Rules marked simulator-only compare with a ground truth that production does not have.</p>
    </div>
  );
}

/* ───────────────────────── side effects ───────────────────────── */

export function SideEffects({ state }) {
  const fx = state.sideEffects;
  const pending = pendingCount(state);
  const cell = (label, value, title) => <div className="stat" title={title}><b>{value}</b><span>{label}</span></div>;
  return (
    <div className="panel">
      <h2>Side effects <Chip label="Code" title={EVIDENCE['L-47'].text} /><span className="right sub">listeners on every row insert</span></h2>
      <div className="stats">
        {cell('socket events', fx.socket, 'transactionCreated')}
        {cell('stats', fx.stats)}
        {cell('lifetime stats', fx.lifetimeStats)}
        {cell('FastTrack', fx.fastTrack, 'CRM publishes of real_money')}
        {cell('RG listener', fx.rg, 'Responsible-gaming listener: not confirmed (Open)')}
        {cell('user notes', fx.userNotes.length, 'Written by REST overviewAdjustBalance only')}
        {cell('Slack lines', fx.slack.length, 'Written by REST overviewAdjustBalance only')}
        {cell('alerts', fx.alerts.length, 'Raised on a failed row insert when the knob says so')}
        {cell('audits', state.mongo.audits.length, 'audits.balanceChange records')}
        {cell('warehouse rows', state.warehouse.length, 'BigQuery copy; completeness unchecked')}
        {cell('pending entries', pending, 'Hardened / Stash: changes whose rows are not written yet')}
      </div>
      <p className="sub mono" style={{ marginTop: 8 }}>last FastTrack: {fx.lastFastTrack ? `${fx.lastFastTrack.bucket} real_money=${fmt(fx.lastFastTrack.real_money)}` : 'none'}</p>
      {fx.userNotes.length > 0 && <p className="sub mono ellipsis" title={fx.userNotes.at(-1).text}>note: {fx.userNotes.at(-1).text}</p>}
      {fx.slack.length > 0 && <p className="sub mono ellipsis" title={fx.slack.at(-1).text}>slack: {fx.slack.at(-1).text}</p>}
      {fx.alerts.length > 0 && <p className="sub mono ellipsis" style={{ color: 'var(--warn)' }}>alert: {fx.alerts.at(-1).type} on {fx.alerts.at(-1).balanceType}, {fx.alerts.at(-1).rows.length} row(s) missing</p>}
    </div>
  );
}

/* ───────────────────────── evidence ───────────────────────── */

/** The evidence ids the current state depends on: the steps of the last operation, plus the reference of every knob. */
export function Evidence({ state }) {
  const fromTrace = new Set(state.trace.map((s) => s.ev).filter(Boolean));
  const knobRefs = {};
  for (const [key, k] of Object.entries(KNOBS)) {
    if (k.only === 'stash' && state.config.stash !== 'on') continue;
    (knobRefs[k.ref] ||= []).push(key);
  }
  const ids = [...new Set([...fromTrace, ...Object.keys(knobRefs)])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const counts = Object.fromEntries(LABELS.map((l) => [l, ids.filter((id) => EVIDENCE[id]?.label === l).length]));
  return (
    <div className="panel">
      <h2>Evidence <span className="right sub">{ids.length} entries behind the current state</span></h2>
      <div className="btns" style={{ marginBottom: 8 }}>
        {LABELS.filter((l) => counts[l]).map((l) => <span key={l} className="ev"><Chip label={l} /><span className="sub">{counts[l]}</span></span>)}
      </div>
      <div className="scroll evlist">
        {ids.map((id) => {
          const e = EVIDENCE[id];
          return (
            <div key={id} className="evrow">
              <div className="evhead">
                <Chip label={e?.label} />
                <span className="ref mono">{id}</span>
                {fromTrace.has(id) && <span className="tag main" title="A step of the last operation rests on this">last operation</span>}
                {knobRefs[id] && <span className="tag muted" title={knobRefs[id].map((k) => KNOBS[k].label).join(', ')}>knob: {knobRefs[id].join(', ')}</span>}
              </div>
              <div className="sub">{e ? e.text : 'Not in the evidence register.'}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ───────────────────────── error register ───────────────────────── */

const findScenario = (id) => SCENARIOS.find((s) => s.id === id) || STASH_SCENARIOS.find((s) => s.id === id);

export function ErrorRegister({ presetKey, load }) {
  const [last, setLast] = useState(null);
  const reproduce = (e, id) => {
    const sc = findScenario(id);
    if (!sc) return;
    const bt = typesOf(sc)[0];
    const key = presetKey || 'current';
    const cell = runCell(sc, key, bt);
    setLast({ n: e.n, id, bt, key, status: cell.status, notes: cell.notes });
    if (cell.state) load(cell.state, key, false);
  };
  return (
    <div className="panel">
      <h2>Error register <span className="right sub">errors 1 to 10 · “Reproduce” runs the scenario under the active preset and loads its end state</span></h2>
      <table className="register">
        <thead><tr><th>#</th><th>Error</th><th>Status</th><th>Likelihood</th><th>Needs</th><th>Fix</th><th>Reproduce</th></tr></thead>
        <tbody>
          {ERROR_REGISTER.map((e) => (
            <tr key={e.n}>
              <td className="mono">{e.n}</td>
              <td><strong>{e.title}</strong></td>
              <td><span className="tag muted" style={{ textTransform: 'none' }}>{e.status}</span></td>
              <td className="sub">{e.likelihood}</td>
              <td className="sub">{e.needs}</td>
              <td className="sub">{e.fix}</td>
              <td>
                <div className="btns">
                  {e.scenarios.map((id) => (
                    <button key={id} className={`btn small ${last?.id === id ? 'on' : ''}`} title={findScenario(id)?.title} onClick={() => reproduce(e, id)}>{id}</button>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {last && (
        <div className="toast warn" style={{ marginTop: 10 }}>
          <Pill status={last.status} /> <strong>{last.id}</strong> for error {last.n}, preset {last.key}, on {last.bt}: {findScenario(last.id).title}
          <ul className="notes">{last.notes.map((n, i) => <li key={i} className="mono">{n}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
