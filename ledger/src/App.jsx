import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BALANCE_TYPES, BT, PARTICIPANTS, PARTICIPANT_INFO, KNOBS, PRESETS, BONUS_DAYS, TX_TTL_DAYS,
  createState, deposit, concurrentDeposit, withdraw, chargeback, placeBet, settleBet, refundBet, playRound, concurrentBets,
  replayLast, grantBonus, completeBonus, expireBonus, adminSetBalance, setLimits, runReconciler, advanceDays, setFault,
  setConfig, readBalance, pendingCount, invariants,
} from './engine.js';
import { SCENARIOS, runScenario } from './scenarios.js';
import Database from './Database.jsx';
import Guide from './Guide.jsx';

// Every amount is USD, whatever the balance type.
const fmt = (n) => (Number(Number(n).toFixed(2)) === n ? Number(n).toFixed(2) : String(n));
const pad = (n) => String(n).padStart(2, '0');
const clockStr = (ms) => {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return `${d ? `${d}d ` : ''}${d || h ? `${pad(h)}:` : ''}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
const storeTag = (code) => (BT[code].store === 'portfolio' ? 'portfolio' : 'User doc');

// Starting point for demos: funds in one portfolio type and one legacy type, and an active bonus on USDT.
const seeded = (config) => [
  [deposit, { balanceType: 'usdt', amount: 500 }],
  [deposit, { balanceType: 'btc', amount: 250 }],
  [grantBonus, { balanceType: 'usdt', amount: 50 }],
].reduce((s, [fn, args]) => fn(s, args), createState(config));

export default function App() {
  // `#db` / `#scenarios` / `#guide` open that tab directly; `?preset=hardened` picks the starting preset.
  const [tab, setTab] = useState(() => (['db', 'scenarios', 'guide'].includes(window.location.hash.slice(1)) ? window.location.hash.slice(1) : 'sim'));
  const [preset, setPreset] = useState(() => {
    const p = new URLSearchParams(window.location.search).get('preset');
    return PRESETS[p] ? p : 'deployed';
  });
  const [state, setState] = useState(() => seeded(PRESETS[preset].config));

  const run = (fn, args) => setState((s) => fn(s, args));
  const applyPreset = (key) => {
    setPreset(key);
    setState((s) => setConfig(s, PRESETS[key].config));
  };
  const reset = () => setState((s) => seeded(s.config));
  const loadScenario = (scenarioState, key) => {
    setPreset(key);
    setState(scenarioState);
    setTab('sim');
  };

  return (
    <div className="app">
      <div className="topbar">
        <h1>Ledger <span>Simulator</span></h1>
        <div className="tabs">
          {[['sim', 'Simulator'], ['db', 'Database'], ['scenarios', 'Test scenarios'], ['guide', 'How it works']].map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <div className="spacer" />
        {tab === 'sim' && <span className="sub mono">sim clock {clockStr(state.clock)}</span>}
      </div>

      {tab === 'sim' && <Simulator state={state} run={run} setState={setState} preset={preset} applyPreset={applyPreset} reset={reset} />}
      {tab === 'db' && <Database state={state} />}
      {tab === 'scenarios' && <Scenarios load={loadScenario} />}
      {tab === 'guide' && <Guide />}
    </div>
  );
}

/* ───────────────────────── Simulator ───────────────────────── */

function Simulator({ state, run, setState, preset, applyPreset, reset }) {
  const [bt, setBt] = useState('usdt');
  return (
    <>
      <ConfigBar state={state} setState={setState} preset={preset} applyPreset={applyPreset} reset={reset} />
      <div className="grid">
        <div className="stack">
          <Balances state={state} bt={bt} setBt={setBt} />
          <Actions state={state} run={run} bt={bt} />
          <OpenBets state={state} run={run} />
        </div>
        <div className="stack center">
          <Sequence state={state} />
          <EventLog state={state} />
        </div>
        <div className="stack">
          <Stress state={state} run={run} setState={setState} bt={bt} />
          <Admin run={run} bt={bt} />
          <ResponsibleGaming state={state} run={run} />
        </div>
      </div>
      <div className="bottom">
        <Transactions state={state} />
        <Invariants state={state} />
      </div>
    </>
  );
}

function ConfigBar({ state, setState, preset, applyPreset, reset }) {
  const [showKnobs, setShowKnobs] = useState(false);
  const studied = PRESETS.deployed.config;
  const custom = !Object.entries(PRESETS[preset].config).every(([k, v]) => state.config[k] === v);
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div style={{ flex: 'none' }} className="seg">
          {Object.entries(PRESETS).map(([k, p]) => (
            <button key={k} className={preset === k && !custom ? 'on' : ''} onClick={() => applyPreset(k)}>{p.label}</button>
          ))}
        </div>
        <span className="sub" style={{ flex: 1 }}>{custom ? 'Custom configuration' : PRESETS[preset].blurb}</span>
        <button className="btn" style={{ flex: 'none' }} onClick={() => setShowKnobs(!showKnobs)}>{showKnobs ? 'Hide' : 'Show'} design knobs</button>
        <button className="btn danger" style={{ flex: 'none' }} onClick={reset}>Reset demo</button>
      </div>
      {showKnobs && (
        <div className="knobs">
          {Object.entries(KNOBS).map(([key, k]) => (
            <div key={key} className={`field knob ${state.config[key] !== studied[key] ? 'diff' : ''}`} title={state.config[key] !== studied[key] ? 'Differs from the ledger as studied' : ''}>
              <label>{k.label}</label>
              <select value={state.config[key]} onChange={(e) => setState((s) => setConfig(s, { ...s.config, [key]: e.target.value }))}>
                {Object.entries(k.options).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Balances({ state, bt, setBt }) {
  return (
    <div className="panel">
      <h2>Balances <span className="right sub">click a row to act on it</span></h2>
      <div className="balrow sub">
        <div />
        <div className="amt"><span className="tag main">primary</span></div>
        <div className="amt"><span className="tag bonus">bonus</span></div>
      </div>
      {BALANCE_TYPES.map(({ code, label }) => {
        const bonus = state.bonuses[code];
        const primary = readBalance(state, code);
        return (
          <div key={code} className="balrow" onClick={() => setBt(code)} style={{ cursor: 'pointer', background: bt === code ? 'color-mix(in srgb, var(--main) 7%, transparent)' : undefined }}>
            <div>
              <div className="cur">{bt === code ? '▸ ' : ''}{label}</div>
              <div className="split">{storeTag(code)}</div>
            </div>
            <div className={`amt big ${primary < 0 ? 'neg' : ''}`}>{fmt(primary)}</div>
            <div className="amt">
              {fmt(readBalance(state, code, 'bonus'))}
              {bonus && (
                <div title={`wagered ${bonus.wagered} of ${bonus.wagerRequired}; expires at ${clockStr(bonus.expiresAt)}`}>
                  <div className="meter"><div style={{ width: `${Math.min(100, (bonus.wagered / bonus.wagerRequired) * 100)}%` }} /></div>
                  <div className="split">{fmt(bonus.wagered)} / {fmt(bonus.wagerRequired)} wagered</div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Toast({ state }) {
  const op = state.lastOp;
  if (!op) return null;
  return <div className={`toast ${op.ok === false ? 'err' : op.warning ? 'warn' : 'ok'}`}>{op.message}{op.warning ? `: ${op.warning}` : ''}</div>;
}

function Actions({ state, run, bt }) {
  const [amount, setAmount] = useState('40');
  const args = { balanceType: bt, amount: Number(amount) };
  return (
    <div className="panel">
      <h2>Actions <span className="right"><span className="tag muted">{BT[bt].label}</span></span></h2>
      <div className="field">
        <label>Amount (USD)</label>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      </div>
      <div className="group">
        <label>Payments: depositQueue credits, withdrawWorker deducts from primary only</label>
        <div className="btns">
          <button className="btn main" onClick={() => run(deposit, args)}>Deposit</button>
          <button className="btn" onClick={() => run(withdraw, args)}>Withdraw</button>
          <button className="btn danger" title="A deduction with allowNegative: true" onClick={() => run(chargeback, args)}>Chargeback</button>
        </div>
      </div>
      <div className="group">
        <label>Bets: primary first, overflow to bonus</label>
        <div className="btns">
          <button className="btn" onClick={() => run(playRound, { ...args, multiplier: 0 })}>Bet &amp; lose</button>
          <button className="btn" onClick={() => run(playRound, { ...args, multiplier: 2 })}>Bet &amp; win ×2</button>
          <button className="btn" title="Places the bet and leaves the round open, to settle or refund below" onClick={() => run(placeBet, args)}>Bet, leave open</button>
        </div>
      </div>
      <div className="group">
        <label>Bonus: wager 5× within {BONUS_DAYS} days to complete</label>
        <div className="btns">
          <button className="btn bonus" onClick={() => run(grantBonus, args)}>Grant bonus</button>
          <button className="btn" title="transferPortfolioBonusToPrimary" onClick={() => run(completeBonus, { balanceType: bt })}>Complete</button>
          <button className="btn" title="clearPortfolioBonus" onClick={() => run(expireBonus, { balanceType: bt })}>Clear</button>
        </div>
      </div>
      <Toast state={state} />
    </div>
  );
}

function OpenBets({ state, run }) {
  const open = state.bets.filter((b) => b.status === 'open');
  return (
    <div className="panel">
      <h2>Open bets <span className="right sub">{state.bets.length} placed</span></h2>
      {open.length === 0 ? <p className="sub">No open rounds. “Bet, leave open” places one you can win, lose or refund here.</p> : (
        <table>
          <tbody>
            {open.slice(0, 8).map((b) => (
              <tr key={b.betId}>
                <td className="mono">{b.betId}</td>
                <td className="num">{fmt(b.amount)} {BT[b.balanceType].label}</td>
                <td>
                  <div className="btns" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn small" onClick={() => run(settleBet, { betId: b.betId, multiplier: 2 })}>Win ×2</button>
                    <button className="btn small" onClick={() => run(settleBet, { betId: b.betId, multiplier: 0 })}>Lose</button>
                    <button className="btn small" onClick={() => run(refundBet, { betId: b.betId })}>Refund</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stress({ state, run, setState, bt }) {
  const [amount, setAmount] = useState('60');
  const args = { balanceType: bt, amount: Number(amount) };
  const armed = state.fault === 'rowWrite';
  const pending = pendingCount(state);
  const cb = state.lastCallback;
  return (
    <div className="panel">
      <h2>Concurrency &amp; faults <span className="right"><span className="tag muted">{BT[bt].label}</span></span></h2>
      <div className="field">
        <label>Amount (USD)</label>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      </div>
      <div className="group">
        <label>Two requests in flight together</label>
        <div className="btns">
          <button className="btn" onClick={() => run(concurrentBets, args)}>Two bets at once</button>
          <button className="btn" onClick={() => run(concurrentDeposit, args)}>Same deposit, twice at once</button>
        </div>
      </div>
      <div className="group">
        <label>Duplicate callback{cb ? `: last was ${cb.op} ${cb.args.betId || cb.args.externalIdentifier}` : ''}</label>
        <div className="btns">
          <button className="btn" disabled={!cb} onClick={() => run(replayLast)}>Replay last callback</button>
        </div>
      </div>
      <div className="group">
        <label>Transaction log{pending ? `: ${pending} pending entr${pending > 1 ? 'ies' : 'y'}` : ''}</label>
        <div className="btns">
          <button className={`btn ${armed ? 'on' : 'danger'}`} onClick={() => setState((s) => setFault(s, armed ? 'none' : 'rowWrite'))}>{armed ? 'Next insert will fail' : 'Fail the next transaction insert'}</button>
          <button className="btn" onClick={() => run(runReconciler)}>Run reconciler</button>
        </div>
      </div>
      <div className="group">
        <label>Time: bonuses last {BONUS_DAYS} days, rows {TX_TTL_DAYS} days</label>
        <div className="btns">
          <button className="btn" onClick={() => run(advanceDays, { days: BONUS_DAYS + 1 })}>+{BONUS_DAYS + 1} days</button>
          <button className="btn" onClick={() => run(advanceDays, { days: TX_TTL_DAYS + 1 })}>+{TX_TTL_DAYS + 1} days</button>
        </div>
      </div>
    </div>
  );
}

function Admin({ run, bt }) {
  const [value, setValue] = useState('1000');
  const [bucket, setBucket] = useState('primary');
  return (
    <div className="panel">
      <h2>Admin <span className="right"><span className="tag muted">{BT[bt].label}</span></span></h2>
      <div className="row">
        <div className="field">
          <label>Bucket</label>
          <select value={bucket} onChange={(e) => setBucket(e.target.value)}>
            <option value="primary">primary</option>
            <option value="bonus">bonus</option>
          </select>
        </div>
        <div className="field">
          <label>Set to (USD)</label>
          <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" />
        </div>
        <button className="btn" style={{ flex: 'none', alignSelf: 'flex-end' }} onClick={() => run(adminSetBalance, { balanceType: bt, bucket, value: Number(value) })}>Set balance</button>
      </div>
    </div>
  );
}

function ResponsibleGaming({ state, run }) {
  const { rg } = state;
  const [wager, setWager] = useState('');
  const [loss, setLoss] = useState('');
  const limit = (v) => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return (
    <div className="panel">
      <h2>Responsible gaming <span className="right sub">updated from ledger changes</span></h2>
      <div className="row">
        <div className="field"><label>Wager limit</label><input value={wager} placeholder="off" onChange={(e) => setWager(e.target.value)} inputMode="decimal" /></div>
        <div className="field"><label>Loss limit</label><input value={loss} placeholder="off" onChange={(e) => setLoss(e.target.value)} inputMode="decimal" /></div>
        <button className="btn" style={{ flex: 'none', alignSelf: 'flex-end' }} onClick={() => run(setLimits, { wagerLimit: limit(wager), lossLimit: limit(loss) })}>Save</button>
      </div>
      <table style={{ marginTop: 10 }}>
        <tbody>
          <tr><td>Wagered</td><td className="num">{fmt(rg.wagered)}{rg.wagerLimit !== null ? ` of ${fmt(rg.wagerLimit)}` : ''}</td></tr>
          <tr><td>Net loss</td><td className="num">{fmt(rg.netLoss)}{rg.lossLimit !== null ? ` of ${fmt(rg.lossLimit)}` : ''}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────────────── Sequence + log ───────────────────────── */

const KIND_LABEL = { call: 'call', return: 'return', error: 'error', note: 'note' };
const KIND_TAG = { call: 'main', return: 'muted', error: 'err', note: 'bonus' };
const payloadOf = (s) => (s.detail === undefined ? null : JSON.stringify(s.detail, null, 2));

/** What one step is: who talks to whom, what it means in plain words, and the data it carries. */
function StepInfo({ s, index, full }) {
  const payload = payloadOf(s);
  const lines = payload ? payload.split('\n') : [];
  const cut = !full && lines.length > 12;
  return (
    <>
      <div className="tip-head">
        <span className="faint mono">{index + 1}</span>
        <strong>{s.from === s.to ? s.from : `${s.from} → ${s.to}`}</strong>
        <span className={`tag ${KIND_TAG[s.kind]}`}>{KIND_LABEL[s.kind]}</span>
      </div>
      <div className="mono tip-label">{s.label}</div>
      {s.why && <p className="tip-why">{s.why}</p>}
      {payload && (
        <>
          <div className="tip-cap">payload</div>
          <pre className="mono tip-pre">{cut ? `${lines.slice(0, 12).join('\n')}\n…` : payload}</pre>
          {cut && <div className="tip-cap">click the step to pin it and see all {lines.length} lines</div>}
        </>
      )}
    </>
  );
}

function Sequence({ state }) {
  const steps = state.trace;
  // `hover` is { step } or { col } plus the pointer position; `pinned` is a step index kept open below the diagram.
  const [hover, setHover] = useState(null);
  const [pinned, setPinned] = useState(null);
  useEffect(() => { setPinned(null); setHover(null); }, [steps]);
  const cols = useMemo(() => {
    const used = new Set(steps.flatMap((s) => [s.from, s.to]));
    return PARTICIPANTS.filter((p) => used.has(p));
  }, [steps]);
  const x = (p) => ((cols.indexOf(p) + 0.5) / cols.length) * 100;
  const at = (e, what) => setHover({ ...what, x: e.clientX, y: e.clientY });
  // Keep the card inside the window: flip it above the pointer in the lower part of the screen.
  const tipStyle = hover && {
    left: Math.max(8, Math.min(hover.x + 16, window.innerWidth - 396)),
    ...(hover.y > window.innerHeight * 0.55 ? { bottom: window.innerHeight - hover.y + 14 } : { top: hover.y + 18 }),
  };

  return (
    <div className="panel">
      <h2>Sequence — last operation <span className="right sub">{state.lastOp?.name || 'run an action'}</span></h2>
      {steps.length === 0 ? (
        <p className="sub">Every action renders here as a sequence diagram: the calling module, the unified ledger API, the balance update and its guard, and the transaction rows written afterwards. Hover a step for what it does; click it to pin its full payload.</p>
      ) : (
        <>
          <div className="seq" onMouseLeave={() => setHover(null)}>
            <div className="seq-inner">
              <div className="seq-head" style={{ gridTemplateColumns: `repeat(${cols.length}, 1fr)` }}>
                {cols.map((c) => <div key={c}><span onMouseMove={(e) => at(e, { col: c })} onMouseLeave={() => setHover(null)}>{c}</span></div>)}
              </div>
              {steps.map((s, i) => (
                <div className={`seq-row ${pinned === i ? 'pinned' : ''}`} key={i} onMouseMove={(e) => at(e, { step: i })} onClick={() => setPinned(pinned === i ? null : i)}>
                  {cols.map((c) => <div key={c} className="seq-life" style={{ left: `${x(c)}%` }} />)}
                  {s.from === s.to ? (
                    <div className="seq-note" style={{ left: `${x(s.from)}%`, color: s.kind === 'error' ? 'var(--err)' : undefined }}>{s.label}</div>
                  ) : (
                    <Arrow s={s} a={x(s.from)} b={x(s.to)} />
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="seq-legend sub">
            <span><i className="lg call" /> call</span>
            <span><i className="lg return" /> return</span>
            <span><i className="lg error" /> error</span>
            <span><i className="lg note" /> note</span>
            <span className="faint">hover a step or a column name · click a step to pin it</span>
          </div>
          {pinned !== null && steps[pinned] && (
            <div className="seq-detail">
              <button className="btn small" style={{ float: 'right' }} onClick={() => setPinned(null)}>Close</button>
              <StepInfo s={steps[pinned]} index={pinned} full />
            </div>
          )}
          {hover && (
            <div className="seq-tip" style={tipStyle}>
              {hover.col ? (
                <>
                  <div className="tip-head"><strong>{hover.col}</strong><span className="tag muted">participant</span></div>
                  <p className="tip-why">{PARTICIPANT_INFO[hover.col]}</p>
                </>
              ) : steps[hover.step] && <StepInfo s={steps[hover.step]} index={hover.step} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Arrow({ s, a, b }) {
  const left = Math.min(a, b);
  const width = Math.abs(b - a);
  return (
    <>
      <div className={`seq-label ${s.kind}`} style={{ left: `${left}%`, width: `${width}%` }}>{s.label}</div>
      <div className={`seq-arrow ${s.kind} ${b > a ? 'r' : 'l'}`} style={{ left: `${left}%`, width: `${width}%` }} />
    </>
  );
}

function EventLog({ state }) {
  return (
    <div className="panel">
      <h2>Event log</h2>
      <div className="log">
        {state.events.length === 0 && <div className="info">No events yet.</div>}
        {state.events.map((e, i) => (
          <div key={state.events.length - i}><span className="t">{clockStr(e.t)}</span><span className={e.level}>{e.msg}</span></div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── Transactions + invariants ───────────────────────── */

const FILTERS = {
  all: ['All', () => true],
  primary: ['Primary rows', (t) => !t.balanceType.endsWith('Bonus')],
  bonus: ['Bonus rows', (t) => t.balanceType.endsWith('Bonus')],
  bets: ['Bets', (t) => ['bet', 'payout', 'refund'].includes(t.type)],
  payments: ['Payments', (t) => ['deposit', 'withdrawal', 'chargeback'].includes(t.type)],
};

function Transactions({ state }) {
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState(null);
  const seen = useRef(new Set());
  const rows = state.transactions.filter(FILTERS[filter][1]).slice(0, 150);
  useEffect(() => { rows.forEach((t) => seen.current.add(t._id)); });
  return (
    <div className="panel">
      <h2>transactions <span className="right sub">{state.transactions.length} docs · {TX_TTL_DAYS}-day TTL · click a row for the document</span></h2>
      <div className="seg" style={{ marginBottom: 8 }}>
        {Object.entries(FILTERS).map(([k, [l]]) => (
          <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      <div className="scroll">
        <table>
          <thead><tr><th>_id</th><th>type</th><th>balanceType</th><th style={{ textAlign: 'right' }}>amount</th><th style={{ textAlign: 'right' }}>currentBalance</th><th>meta</th><th>createdAt</th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <TransactionRow key={t._id} t={t} isNew={!seen.current.has(t._id)} open={open === t._id} toggle={() => setOpen(open === t._id ? null : t._id)} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TransactionRow({ t, isNew, open, toggle }) {
  const metaStr = t.meta ? Object.entries(t.meta).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(' ') : '';
  return (
    <>
      <tr className={isNew ? 'new' : ''} onClick={toggle} style={{ cursor: 'pointer' }}>
        <td className="mono faint">…{t._id.slice(-6)}</td>
        <td className="mono">{t.type}</td>
        <td><span className={`tag ${t.balanceType.endsWith('Bonus') ? 'bonus' : 'main'}`} style={{ textTransform: 'none' }}>{t.balanceType}</span></td>
        <td className={`num ${t.amount < 0 ? 'neg' : t.amount > 0 ? 'pos' : ''}`}>{t.amount > 0 ? '+' : ''}{fmt(t.amount)}</td>
        <td className="num">{fmt(t.currentBalance)}</td>
        <td className="sub mono" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{metaStr}</td>
        <td className="mono faint">{clockStr(t.createdAt)}</td>
      </tr>
      {open && (
        <tr><td colSpan={7}><pre className="mono" style={{ whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>{JSON.stringify(t, null, 2)}</pre></td></tr>
      )}
    </>
  );
}

function Invariants({ state }) {
  const list = invariants(state);
  const groups = [...new Set(list.map((i) => i.group))];
  const failing = list.filter((i) => !i.ok).length;
  return (
    <div className="panel">
      <h2>Invariants <span className="right">{failing ? <span className="tag err">{failing} violated</span> : <span className="tag ok">all hold</span>}</span></h2>
      <div className="inv">
        <div className="h" style={{ textAlign: 'left' }}>check</div>
        {BALANCE_TYPES.map((c) => <div key={c.code} className="h">{c.label}</div>)}
        {groups.map((g) => (
          <InvariantRow key={g} g={g} list={list} />
        ))}
      </div>
      <p className="sub" style={{ marginTop: 10 }}>Hover a cell for numbers. <strong>Conservation</strong> compares primary + bonus with what the balance should hold if every operation applied exactly once. <strong>Every change has a row</strong> adds up the rows of each bucket (plus rows the TTL removed) and compares the total with the stored amount.</p>
    </div>
  );
}

function InvariantRow({ g, list }) {
  return (
    <>
      <div>{g}</div>
      {BALANCE_TYPES.map((c) => {
        const i = list.find((x) => x.group === g && x.cur === c.label);
        return <div key={c.code} className="c" title={i.detail} style={{ color: i.ok ? 'var(--ok)' : 'var(--err)' }}>{i.ok ? '✓' : '✗'}</div>;
      })}
    </>
  );
}

/* ───────────────────────── Scenarios tab ───────────────────────── */

function Scenarios({ load }) {
  const results = useMemo(() => SCENARIOS.map((sc) => ({
    sc,
    byPreset: Object.fromEntries(Object.keys(PRESETS).map((k) => [k, runScenario(sc, PRESETS[k].config)])),
  })), []);
  const [sel, setSel] = useState(null);
  const passed = (k) => results.filter((r) => r.byPreset[k].pass).length;
  return (
    <div className="panel">
      <h2>Scenario matrix <span className="right sub">each scenario runs on a fresh user against every preset · click a cell for details and to load it into the simulator</span></h2>
      <table className="matrix">
        <thead>
          <tr><th>Scenario</th><th>Area</th>{Object.entries(PRESETS).map(([k, p]) => <th key={k} style={{ textAlign: 'center' }}>{p.label}<div className="faint" style={{ fontWeight: 400 }}>{passed(k)}/{results.length}</div></th>)}</tr>
        </thead>
        <tbody>
          {results.map(({ sc, byPreset }) => (
            <ScenarioRow key={sc.id} sc={sc} byPreset={byPreset} sel={sel} setSel={setSel} load={load} />
          ))}
        </tbody>
      </table>
      <p className="sub" style={{ marginTop: 10 }}><span className="tag muted">§7.3</span> marks the study’s own ten test scenarios. <span className="pill gap">DEBT</span> marks a failure of the ledger as studied that follows from the study’s own description. Click the cell for the reason.</p>
    </div>
  );
}

function ScenarioRow({ sc, byPreset, sel, setSel, load }) {
  const open = sel?.id === sc.id;
  const isDebt = (k, r) => !r.pass && k === 'deployed' && sc.debt;
  return (
    <>
      <tr>
        <td>{sc.study && <span className="tag muted" style={{ marginRight: 8 }}>§7.3 #{sc.study}</span>}{sc.title}</td>
        <td className="mono faint">{sc.suite}</td>
        {Object.entries(byPreset).map(([k, r]) => (
          <td key={k} className="res" onClick={() => setSel(open && sel.preset === k ? null : { id: sc.id, preset: k })} style={{ cursor: 'pointer' }}>
            <span className={`pill ${r.pass ? 'pass' : isDebt(k, r) ? 'gap' : 'fail'}`}>{r.pass ? 'PASS' : isDebt(k, r) ? 'DEBT' : 'FAIL'}</span>
          </td>
        ))}
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ background: 'var(--panel-2)' }}>
            <strong>{PRESETS[sel.preset].label}:</strong>
            <ul style={{ paddingLeft: 18, margin: '4px 0 8px' }}>{byPreset[sel.preset].notes.map((n, i) => <li key={i} className="mono">{n}</li>)}</ul>
            {isDebt(sel.preset, byPreset[sel.preset]) && <p className="sub" style={{ marginBottom: 8 }}><strong>Why:</strong> {sc.debt}</p>}
            {byPreset[sel.preset].state && (
              <button className="btn small" onClick={() => load(byPreset[sel.preset].state, sel.preset)} title="Opens the Simulator tab on this scenario's end state: balances, rows, invariants and the last operation's sequence">
                Load into simulator
              </button>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
