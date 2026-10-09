import { useState } from 'react';
import {
  BALANCE_TYPES, BT, KNOBS, PRESETS, EVIDENCE, BONUS_DAYS, TX_TTL_DAYS,
  readBalance, totalBalance, pendingCount, setConfig, setFault, setGap, selectBalance,
  placeBet, playRound, settleBet, refundBet, replayLast, concurrentBets, deductWithoutBalanceType,
  deposit, depositCreate, depositBlock, depositComplete, concurrentDepositCallbacks,
  withdrawRequest, withdrawOutcome, concurrentWithdrawRequests, tip,
  grantBonus, completeBonus, expireBonus, readBonusState, sportsbookWin, sportsbookRollback,
  acpAction, acpResetDuringBet, acpExportCsv, stashIn, stashOut, concurrentStashIn, setStashFlag,
  cleanupOldUsers, measurementJob, advanceDays, runReconciler,
} from './engine.js';
import Sequence from './Sequence.jsx';
import { EventLog, Transactions, Invariants, SideEffects, Evidence, ErrorRegister } from './Panels.jsx';
import { Chip, Ev, fmt, clockStr, num } from './ui.jsx';

export default function Simulator({ state, run, setState, preset, applyPreset, reset, load }) {
  const [bt, setBt] = useState('usdt');
  const [amount, setAmount] = useState('40');
  const a = { state, run, bt, amount: num(amount), args: { balanceType: bt, amount: num(amount) } };
  const stashOn = state.config.stash === 'on';
  return (
    <>
      <ConfigBar state={state} setState={setState} preset={preset} applyPreset={applyPreset} reset={reset} />
      <div className="grid">
        <div className="stack">
          <Balances state={state} run={run} bt={bt} setBt={setBt} amount={amount} setAmount={setAmount} />
          <Bets {...a} />
          <Payments {...a} />
        </div>
        <div className="stack center">
          <Sequence state={state} />
          <EventLog state={state} />
          <SideEffects state={state} />
          <Transactions state={state} />
        </div>
        <div className="stack">
          <Faults state={state} setState={setState} />
          <BonusAndSportsbook {...a} />
          <Acp {...a} />
          {stashOn && <Stash {...a} />}
          <Maintenance {...a} />
        </div>
      </div>
      <div className="bottom">
        <ErrorRegister presetKey={preset} load={load} />
        <Invariants state={state} />
      </div>
      <div style={{ marginTop: 14 }}>
        <Evidence state={state} />
      </div>
    </>
  );
}

/* ───────────────────────── presets and knobs ───────────────────────── */

function ConfigBar({ state, setState, preset, applyPreset, reset }) {
  // `?knobs` opens the knob list from the start (used for screenshots and links).
  const [showKnobs, setShowKnobs] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('knobs'));
  const current = PRESETS.current.config;
  const custom = !Object.entries(PRESETS[preset].config).every(([k, v]) => state.config[k] === v);
  const stashOn = state.config.stash === 'on';
  const visible = Object.entries(KNOBS).filter(([, k]) => k.only !== 'stash' || stashOn);
  const groups = [...new Set(visible.map(([, k]) => k.group))];
  // Option keys are strings in the DOM; a knob whose stored value is a number (lagMs) stays a number.
  const change = (key, v) => setState((s) => setConfig(s, { ...s.config, [key]: typeof current[key] === 'number' ? Number(v) : v }));
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div style={{ flex: 'none' }} className="seg">
          {Object.entries(PRESETS).map(([k, p]) => (
            <button key={k} className={preset === k && !custom ? 'on' : ''} onClick={() => applyPreset(k)}>{p.label}</button>
          ))}
        </div>
        {(preset === 'hardened' || preset === 'stash') && <Chip label="Proposed" title="This preset is a proposal. It is not in the backend." />}
        <span className="sub" style={{ flex: 1, minWidth: 260 }}>{custom ? `Custom configuration, based on ${PRESETS[preset].label}.` : PRESETS[preset].blurb}</span>
        <button className="btn" style={{ flex: 'none' }} onClick={() => setShowKnobs(!showKnobs)}>{showKnobs ? 'Hide' : 'Show'} design knobs</button>
        <button className="btn danger" style={{ flex: 'none' }} onClick={reset}>Reset demo</button>
      </div>
      {showKnobs && (
        <div className="knobgroups">
          {groups.map((g) => (
            <div key={g} className="knobgroup">
              <h3>{g}</h3>
              <div className="knobs">
                {visible.filter(([, k]) => k.group === g).map(([key, k]) => (
                  <div key={key} className={`field knob ${state.config[key] !== current[key] ? 'diff' : ''}`} title={state.config[key] !== current[key] ? 'Differs from the Current ledger preset' : ''}>
                    <label>
                      <span>{k.label}</span>
                      <Chip label={k.evLabel} title={`Evidence label of the Current-ledger default (${key})`} />
                      <span className="ref mono" title={EVIDENCE[k.ref]?.text}>{k.ref}</span>
                    </label>
                    <select value={String(state.config[key])} onChange={(e) => change(key, e.target.value)}>
                      {Object.entries(k.options).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <p className="sub">The badge is the evidence label of the Current-ledger default. Hover a reference for its text. An orange border marks a value that differs from the Current ledger preset.</p>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── balances ───────────────────────── */

const STORES = [
  ['rethink', 'RethinkDB users row', 'L-03'],
  ['portfolio', 'Mongo user_altcoin_portfolios', 'L-04'],
];

function Balances({ state, run, bt, setBt, amount, setAmount }) {
  const stashOn = state.config.stash === 'on';
  const user = state.rethink.user;
  const cols = `minmax(0, 1fr) 82px 82px${stashOn ? ' 72px' : ''}`;
  return (
    <div className="panel">
      <h2>Balances <span className="right sub">click a row to act on it</span></h2>
      {user.deleted && <div className="toast err" style={{ margin: '0 0 10px' }}><strong>Account deleted</strong> by cleanupOldUsers. Operations now fail with “User not found”.</div>}
      <div className="balrow sub" style={{ gridTemplateColumns: cols }}>
        <div />
        <div className="amt"><span className="tag main">primary</span></div>
        <div className="amt"><span className="tag bonus">bonus</span></div>
        {stashOn && <div className="amt"><span className="tag stash">stash</span></div>}
      </div>
      {STORES.map(([store, title, ref]) => (
        <div key={store} className="store">
          <div className="store-head"><span>{title}</span><Ev id={ref} /></div>
          {store === 'portfolio' && !state.mongo.portfolio && <div className="sub store-empty">no portfolio document yet <Ev id="L-05" withId={false} /></div>}
          {BALANCE_TYPES.filter((b) => b.store === store).map(({ code, label }) => {
            const bonus = state.bonuses[code];
            const primary = readBalance(state, code);
            const scratch = store === 'portfolio' ? state.mongo.portfolio?.balances?.[code] : null;
            const sel = user.selectedBalanceType === code;
            return (
              <div key={code} className={`balrow ${bt === code ? 'on' : ''}`} style={{ gridTemplateColumns: cols }} onClick={() => setBt(code)}>
                <div>
                  <div className="cur">{bt === code ? '▸ ' : ''}{label}</div>
                  <div className="split">
                    {code}
                    {sel
                      ? <span className="tag ok" title="user.selectedBalanceType: where a call without balanceType lands (L-80)">selected</span>
                      : <button className="link" title="Sets user.selectedBalanceType" onClick={(e) => { e.stopPropagation(); run(selectBalance, { balanceType: code }); }}>select</button>}
                  </div>
                </div>
                <div className={`amt big ${primary < 0 ? 'neg' : ''}`}>{fmt(primary)}</div>
                <div className="amt">{fmt(readBalance(state, code, 'bonus'))}</div>
                {stashOn && <div className="amt stashamt">{fmt(readBalance(state, code, 'stash'))}</div>}
                {bonus && (
                  <div className="balextra" title={`wagered ${bonus.wagered} of ${bonus.wagerRequired}; ends at ${clockStr(bonus.expiresAt)}`}>
                    <div className="meter"><div style={{ width: `${Math.min(100, (bonus.wagered / bonus.wagerRequired) * 100)}%` }} /></div>
                    <div className="split">bonus: {fmt(bonus.wagered)} / {fmt(bonus.wagerRequired)} wagered{bonus.expiresAt <= state.clock ? ' · past its end date, not expired yet' : ''}</div>
                  </div>
                )}
                {scratch && (
                  <div className="balextra stale" title={EVIDENCE['L-25'].text}>
                    originalBalance {scratch.originalBalance ?? '—'} · originalBonusBalance {scratch.originalBonusBalance ?? '—'} <span className="tag muted">stale scratch</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      <div className="total">
        <span>totalBalance <Ev id="L-18" /></span>
        <b className="mono">{fmt(totalBalance(state))}</b>
      </div>
      {stashOn && <p className="sub">Stash transfers flag: <strong>{state.stashFlag ? 'on' : 'off'}</strong>. Stash amounts are a proposal. <Chip label="Proposed" /></p>}
      <div className="row target">
        <div className="field">
          <label>Balance type</label>
          <select value={bt} onChange={(e) => setBt(e.target.value)}>
            {BALANCE_TYPES.map((b) => <option key={b.code} value={b.code}>{b.label} ({b.store === 'portfolio' ? 'Mongo' : 'RethinkDB'})</option>)}
          </select>
        </div>
        <div className="field">
          <label>Amount (USD)</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── actions ───────────────────────── */

const Target = ({ bt, amount }) => <span className="right"><span className="tag muted">{BT[bt].label} · {Number.isFinite(amount) ? amount : '?'}</span></span>;
const Group = ({ label, ev, children }) => (
  <div className="group">
    <label>{label} {ev && <Ev id={ev} />}</label>
    <div className="btns">{children}</div>
  </div>
);

function Bets({ state, run, bt, amount, args }) {
  const [gap, setGapMs] = useState('');
  const open = state.mongo.bets.filter((b) => b.status === 'open');
  const cb = state.lastCallback;
  const cbId = cb && (cb.args.betId || cb.args.depositId);
  const replay = () => run((s) => replayLast(Number.isFinite(num(gap)) ? setGap(s, num(gap)) : s));
  return (
    <div className="panel">
      <h2>Bets &amp; providers <Target bt={bt} amount={amount} /></h2>
      <Group label="Bets: primary first, then bonus" ev="L-20">
        <button className="btn" onClick={() => run(playRound, { ...args, multiplier: 0 })}>Bet &amp; lose</button>
        <button className="btn" onClick={() => run(playRound, { ...args, multiplier: 2 })}>Bet &amp; win ×2</button>
        <button className="btn" title="Places the bet and leaves the round open, to settle or refund below" onClick={() => run(placeBet, args)}>Bet, leave open</button>
        <button className="btn" onClick={() => run(concurrentBets, args)}>Two bets at once</button>
      </Group>
      <div className="group">
        <label>Open bets: {open.length} of {state.mongo.bets.length} placed</label>
        {open.length === 0 ? <p className="sub">None. “Bet, leave open” places one to win, lose or refund.</p> : (
          <table>
            <tbody>
              {open.slice(0, 6).map((b) => (
                <tr key={b.betId}>
                  <td className="mono">{b.betId}</td>
                  <td className="num">{fmt(b.amount)} {BT[b.balanceType].label}</td>
                  <td>
                    <div className="btns end">
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
      <div className="group">
        <label>Duplicate callback{cb ? `: last was ${cb.op} ${cbId}` : ''} <Ev id="L-55" /></label>
        <div className="row">
          <div className="field" style={{ flex: '0 0 130px' }}>
            <input value={gap} placeholder="arrives after ms" title="Optional: how many ms after the previous action the replay arrives (default 1000)" onChange={(e) => setGapMs(e.target.value)} inputMode="numeric" />
          </div>
          <button className="btn" disabled={!cb} onClick={replay}>Replay last callback</button>
        </div>
      </div>
      <Group label={`Ledger call without balanceType, meant for ${BT[bt].label}`} ev="L-80">
        <button className="btn" onClick={() => run(deductWithoutBalanceType, { intended: bt, amount, identifier: undefined })}>identifier undefined</button>
        <button className="btn" onClick={() => run(deductWithoutBalanceType, { intended: bt, amount, identifier: '' })}>identifier ''</button>
      </Group>
    </div>
  );
}

const WD_OUTCOMES = ['completed', 'reversal', 'decline', 'cancel'];

function Payments({ state, run, bt, amount, args }) {
  const deposits = state.mongo.deposits.slice(0, 5);
  const withdrawals = state.mongo.withdrawals.slice(0, 5);
  return (
    <div className="panel">
      <h2>Payments <Target bt={bt} amount={amount} /></h2>
      <Group label="Deposits: a record with a status, credited on completion" ev="L-37">
        <button className="btn main" onClick={() => run(deposit, args)}>Deposit</button>
        <button className="btn" title="depositCreate: inserts a pending deposit, credits nothing" onClick={() => run(depositCreate, args)}>Create pending</button>
        <button className="btn" onClick={() => run(concurrentDepositCallbacks, args)}>Same callback, twice at once</button>
      </Group>
      {deposits.length > 0 && (
        <table className="mini">
          <tbody>
            {deposits.map((d) => (
              <tr key={d.id}>
                <td className="mono">{d.id}</td>
                <td className="num">{fmt(d.amount)} {BT[d.balanceType].label}</td>
                <td><span className={`tag ${d.status === 'completed' ? 'ok' : d.status === 'blocked' ? 'err' : 'lock'}`}>{d.status}</span></td>
                <td>
                  <div className="btns end nowrap">
                    <button className="btn small" disabled={d.status !== 'pending'} onClick={() => run(depositBlock, { depositId: d.id })}>Block</button>
                    <button className="btn small" title="Delivers the completion callback, whatever the status" onClick={() => run(depositComplete, { depositId: d.id })}>Complete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Group label="Withdrawals: primary only, debited at request" ev="L-38">
        <button className="btn" onClick={() => run(withdrawRequest, args)}>Request withdrawal</button>
        <button className="btn" onClick={() => run(concurrentWithdrawRequests, args)}>Two requests at once</button>
      </Group>
      {withdrawals.length > 0 && (
        <table className="mini">
          <tbody>
            {withdrawals.map((w) => (
              <tr key={w.id}>
                <td className="mono">{w.id}</td>
                <td className="num">{fmt(w.amount)} {BT[w.balanceType].label}<div><span className={`tag ${w.status === 'pending' ? 'lock' : 'muted'}`}>{w.status}</span></div></td>
                <td>
                  <div className="btns end">
                    {WD_OUTCOMES.map((o) => <button key={o} className="btn small" title={o === 'completed' ? 'No ledger call' : 'Credits primary back. Nothing known stops it from running twice (L-39)'} onClick={() => run(withdrawOutcome, { withdrawalId: w.id, outcome: o })}>{o}</button>)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Group label="Tip: reads primary only" ev="L-86">
        <button className="btn" onClick={() => run(tip, args)}>Tip</button>
      </Group>
    </div>
  );
}

function BonusAndSportsbook({ run, bt, amount, args }) {
  return (
    <div className="panel">
      <h2>Bonus &amp; sportsbook <Target bt={bt} amount={amount} /></h2>
      <Group label={`Bonus: wager 5× within ${BONUS_DAYS} days (placeholder rules)`} ev="A-bonus">
        <button className="btn bonus" onClick={() => run(grantBonus, args)}>Grant bonus</button>
        <button className="btn" title="Moves bonus to primary in one update" onClick={() => run(completeBonus, { balanceType: bt })}>Complete</button>
        <button className="btn" title="Zeroes bonus in one update" onClick={() => run(expireBonus, { balanceType: bt })}>Expire</button>
        <button className="btn" title="readBonusState: not a pure read. It expires an overdue bonus (L-82)" onClick={() => run(readBonusState, { balanceType: bt })}>checkIfBonusActive</button>
      </Group>
      <Group label="Sportsbook: the caller that passes allowNegative" ev="L-36">
        <button className="btn" onClick={() => run(sportsbookWin, args)}>Settle win</button>
        <button className="btn danger" title="Deducts with allowNegative: primary can go below zero" onClick={() => run(sportsbookRollback, args)}>Rollback</button>
      </Group>
    </div>
  );
}

function Acp({ run, bt, amount }) {
  const [value, setValue] = useState('1000');
  const act = (api, action, extra) => run(acpAction, { api, action, balanceType: bt, ...extra });
  const buttons = (api) => (
    <>
      <button className="btn" onClick={() => act(api, 'reset')}>Reset</button>
      <button className="btn danger" onClick={() => act(api, 'confiscate')}>Confiscate</button>
      <button className="btn" onClick={() => act(api, 'replace', { value: num(value) })}>Replace → {value || '?'}</button>
      <button className="btn" onClick={() => act(api, 'adjust', { amount })}>Adjust +{Number.isFinite(amount) ? amount : '?'}</button>
      <button className="btn" onClick={() => act(api, 'adjust', { amount: -amount })}>Adjust −{Number.isFinite(amount) ? amount : '?'}</button>
      <button className="btn" disabled={!(amount > 0)} title="A bet lands between the admin’s read and the overwrite" onClick={() => run(acpResetDuringBet, { balanceType: bt, betAmount: amount, api })}>Reset during a bet</button>
    </>
  );
  return (
    <div className="panel">
      <h2>ACP (admin) <Target bt={bt} amount={amount} /></h2>
      <div className="field">
        <label>Replace value (USD)</label>
        <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" />
      </div>
      <Group label="ACP REST: adjust also writes a user note and a Slack line" ev="L-81">
        {buttons('rest')}
        <button className="btn" title="Hydrates rows through Mongoose, so the post('init') hook runs (L-91)" onClick={() => run(acpExportCsv)}>CSV export</button>
      </Group>
      <Group label="ACP GraphQL: same balance change, no note, no Slack" ev="L-81">
        {buttons('graphql')}
      </Group>
    </div>
  );
}

function Stash({ state, run, bt, amount, args }) {
  const [token, setToken] = useState('123456');
  return (
    <div className="panel proposed">
      <h2>Stash <Chip label="Proposed" title={EVIDENCE['P-stash'].text} /><Target bt={bt} amount={amount} /></h2>
      <div className="field">
        <label>2FA code for stash-out <Ev id="P-2fa" /></label>
        <input value={token} onChange={(e) => setToken(e.target.value)} inputMode="numeric" />
      </div>
      <Group label="Transfers: one guarded update, two rows that add to zero" ev="P-stash">
        <button className="btn main" onClick={() => run(stashIn, args)}>Stash in</button>
        <button className="btn" onClick={() => run(stashOut, { ...args, token })}>Stash out</button>
        <button className="btn" disabled={!(amount > 0)} onClick={() => run(concurrentStashIn, args)}>Same stash-in, twice at once</button>
      </Group>
      <Group label={`Feature flag: transfers ${state.stashFlag ? 'enabled' : 'disabled'}`}>
        <button className={`btn ${state.stashFlag ? 'on' : ''}`} onClick={() => run(setStashFlag, { on: !state.stashFlag })}>{state.stashFlag ? 'Turn flag off' : 'Turn flag on'}</button>
      </Group>
    </div>
  );
}

function Maintenance({ state, run }) {
  const pending = pendingCount(state);
  return (
    <div className="panel">
      <h2>Maintenance</h2>
      <Group label={`Time: bonuses last ${BONUS_DAYS} days, rows ${TX_TTL_DAYS} days`} ev="L-44">
        <button className="btn" onClick={() => run(advanceDays, { days: 8 })}>+8 days</button>
        <button className="btn" onClick={() => run(advanceDays, { days: 181 })}>+181 days</button>
      </Group>
      <Group label="Jobs" ev="L-83">
        <button className="btn danger" title="Deletes accounts with BTC, ETH and LTC below 0.01 that never deposited or bet" onClick={() => run(cleanupOldUsers)}>cleanupOldUsers</button>
        <button className="btn" title="Compares each balance with the newest row’s currentBalance. No such job exists today (L-53)" onClick={() => run(measurementJob)}>Measurement job</button>
      </Group>
      <Group label={`Reconciler${pending ? `: ${pending} pending entr${pending > 1 ? 'ies' : 'y'}` : ''}`} ev="P-hard">
        <button className="btn" onClick={() => run(runReconciler)}>Run reconciler</button>
      </Group>
    </div>
  );
}

/* ───────────────────────── faults and timing ───────────────────────── */

function Faults({ state, setState }) {
  const [n, setN] = useState('3');
  const [gap, setGapMs] = useState('100');
  const f = state.faults;
  const arm = (faults) => setState((s) => setFault(s, faults));
  const armed = f.failInserts > 0 || f.failStatusUpdate > 0 || state.gapMs !== null;
  return (
    <div className="panel">
      <h2>Faults &amp; timing <span className="right">{armed ? <span className="tag lock">armed</span> : <span className="tag muted">nothing armed</span>}</span></h2>
      <div className="armed">
        <span className={f.failInserts ? 'hot' : ''}>row inserts to fail: <b>{f.failInserts}</b></span>
        <span className={f.failStatusUpdate ? 'hot' : ''}>deposit status updates to fail: <b>{f.failStatusUpdate}</b></span>
        <span className={state.gapMs !== null ? 'hot' : ''}>next action arrives after: <b>{state.gapMs ?? 1000} ms</b></span>
      </div>
      <Group label="Row insert: a separate write that can fail on its own" ev="L-51">
        <button className={`btn ${f.failInserts === 1 ? 'on' : 'danger'}`} onClick={() => arm({ failInserts: 1 })}>Fail next insert</button>
        <input className="narrow" value={n} onChange={(e) => setN(e.target.value)} inputMode="numeric" title="N" />
        <button className="btn danger" onClick={() => arm({ failInserts: Math.max(0, Math.floor(num(n)) || 0) })}>Fail next N inserts</button>
      </Group>
      <Group label="Deposit status update" ev="L-37">
        <button className={`btn ${f.failStatusUpdate ? 'on' : 'danger'}`} onClick={() => arm({ failStatusUpdate: 1 })}>Fail next status update</button>
        <button className="btn" disabled={!f.failInserts && !f.failStatusUpdate} onClick={() => arm({ failInserts: 0, failStatusUpdate: 0 })}>Clear faults</button>
      </Group>
      <div className="group">
        <label>Timing <Ev id="L-45" /></label>
        <div className="row">
          <div className="field">
            <label>Secondary lag (ms)</label>
            <select value={String(state.config.lagMs)} onChange={(e) => setState((s) => setConfig(s, { ...s.config, lagMs: Number(e.target.value) }))}>
              {Object.entries(KNOBS.lagMs.options).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Next action arrives after (ms)</label>
            <input value={gap} onChange={(e) => setGapMs(e.target.value)} inputMode="numeric" />
          </div>
          <button className="btn" style={{ flex: 'none', alignSelf: 'flex-end' }} disabled={!Number.isFinite(num(gap))} onClick={() => setState((s) => setGap(s, num(gap)))}>Set</button>
        </div>
        <p className="sub" style={{ marginTop: 6 }}>Duplicate check reads the <strong>{state.config.dupRead}</strong>; refund lookup reads the <strong>{state.config.refundRead}</strong>. Lag only matters for a secondary read (knobs dupRead, refundRead).</p>
      </div>
    </div>
  );
}
