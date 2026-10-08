import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BALANCE_TYPES, BT, ADMIN_REASONS, RELOAD_MODES, PARTICIPANTS, KNOBS, PRESETS, WRONG_CODE_LIMIT,
  createState, deposit, receiveTip, bet, withdraw, grantLockedBonus, transferToStash, transferFromStash,
  raceTransferToStash, adminStash, adminExport, cleanupOldUsers, advanceDays, updateAutoReload, reloadFromStash,
  reloadSuggestion, setConfig, setFault, setTwoFactor, tick, readBalance, stashPath, wagerableBalance,
  mapBalanceInformation, totalBalance, calculatePnl, connectApiBalances, invariants, isBonusLocked, isStashBucket, totp,
} from './engine.js';
import { SCENARIOS, runScenario } from './scenarios.js';
import Plan from './Plan.jsx';
import Database from './Database.jsx';

// Every amount is USD, whatever the balance type.
const fmt = (n) => Number(n).toFixed(2);
const pad = (n) => String(n).padStart(2, '0');
const clockStr = (ms) => {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return `${d ? `${d}d ` : ''}${d || h ? `${pad(h)}:` : ''}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
const parseKnob = (v) => (v === 'true' ? true : v === 'false' ? false : v);
// The client mints one id per submitted form; a retry or double-click re-sends the same one.
const newRequestId = () => `req-${Math.random().toString(36).slice(2, 10)}`;
const storeTag = (code) => (BT[code].store === 'portfolio' ? 'Mongo' : 'Rethink');

// Starting point for demos: funds in one Mongo type and one RethinkDB type, part of the USDT already stashed.
const seeded = (config) => [
  [deposit, { balanceType: 'usdt', amount: 500 }],
  [deposit, { balanceType: 'crypto', amount: 250 }],
  [transferToStash, { balanceType: 'usdt', amount: 300 }],
].reduce((s, [fn, args]) => fn(s, args), createState(config));

export default function App() {
  // `#db` / `#scenarios` / `#plan` open that tab directly; `?preset=recommended` picks the starting preset.
  const [tab, setTab] = useState(() => (['db', 'scenarios', 'plan'].includes(window.location.hash.slice(1)) ? window.location.hash.slice(1) : 'sim'));
  const [preset, setPreset] = useState(() => {
    const p = new URLSearchParams(window.location.search).get('preset');
    return PRESETS[p] ? p : 'spec';
  });
  const [state, setState] = useState(() => seeded(PRESETS[preset].config));

  // Sim clock drives the TOTP window; one real second = one sim second.
  useEffect(() => {
    const id = setInterval(() => setState((s) => tick(s)), 1000);
    return () => clearInterval(id);
  }, []);

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
        <h1>Stash Balance <span>Simulator</span></h1>
        <div className="tabs">
          {[['sim', 'Simulator'], ['db', 'Database'], ['scenarios', 'Test scenarios'], ['plan', 'Technical plan']].map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <div className="spacer" />
        {tab === 'sim' && <span className="sub mono">sim clock {clockStr(state.clock)}</span>}
      </div>

      {tab === 'sim' && <Simulator state={state} run={run} setState={setState} preset={preset} applyPreset={applyPreset} reset={reset} />}
      {tab === 'db' && <Database state={state} preset={preset} />}
      {tab === 'scenarios' && <Scenarios load={loadScenario} />}
      {tab === 'plan' && <Plan />}
    </div>
  );
}

/* ───────────────────────── Simulator ───────────────────────── */

function Simulator({ state, run, setState, preset, applyPreset, reset }) {
  const [showKnobs, setShowKnobs] = useState(false);
  return (
    <>
      <ConfigBar state={state} setState={setState} preset={preset} applyPreset={applyPreset} reset={reset} showKnobs={showKnobs} setShowKnobs={setShowKnobs} />
      <div className="grid">
        <div className="stack">
          <Wallet state={state} />
          <StashVault state={state} />
          <Authenticator state={state} run={run} />
          <PlayerActions state={state} run={run} />
          <AutoReload state={state} run={run} />
        </div>
        <div className="stack center">
          <Sequence state={state} />
          <EventLog state={state} />
        </div>
        <div className="stack">
          <Acp state={state} run={run} />
        </div>
      </div>
      <div className="bottom">
        <Transactions state={state} />
        <Invariants state={state} />
      </div>
    </>
  );
}

function ConfigBar({ state, setState, preset, applyPreset, reset, showKnobs, setShowKnobs }) {
  const rec = PRESETS.recommended.config;
  const custom = !Object.entries(PRESETS[preset]?.config || {}).every(([k, v]) => state.config[k] === v);
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
            <div key={key} className={`field knob ${state.config[key] !== rec[key] ? 'diff' : ''}`} title={state.config[key] !== rec[key] ? 'Differs from Recommended' : ''}>
              <label>{k.label}</label>
              <select value={String(state.config[key])} onChange={(e) => setState((s) => setConfig(s, { ...s.config, [key]: parseKnob(e.target.value) }))}>
                {Object.entries(k.options).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Wallet({ state }) {
  return (
    <div className="panel">
      <h2><span className="tag main">PRIMARY</span> Balance selector <span className="right sub">what the game sees</span></h2>
      {BALANCE_TYPES.map(({ code, label }) => {
        const primary = readBalance(state, code);
        const bonus = readBalance(state, code, 'bonus');
        const wagerable = wagerableBalance(state, code);
        const leak = Math.abs(wagerable - primary - (state.bonuses[code] ? bonus : 0)) > 1e-9;
        return (
          <div className="balrow" key={code}>
            <span className="cur">{label}</span>
            <div>
              <div className="split">{storeTag(code)} · bonus {fmt(bonus)}</div>
              {state.bonuses[code] && (
                <div className="split" style={{ color: 'var(--warn)' }}>
                  🔒 wagering {fmt(state.bonuses[code].wagered)} / {fmt(state.bonuses[code].wagerRequirement)}
                </div>
              )}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className={`amt big ${primary < 0 ? 'neg' : ''}`}>{fmt(primary)}</div>
              {leak && <div className="split" style={{ color: 'var(--err)' }}>wagerable {fmt(wagerable)} ⚠</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StashVault({ state }) {
  return (
    <div className="panel vault">
      <h2><span className="tag stash">STASH</span> Stash <span className="right sub">not wagerable, not withdrawable</span></h2>
      {BALANCE_TYPES.map(({ code, label, fiat }) => {
        const amount = readBalance(state, code, 'stash');
        const disabled = fiat && !state.config.cashStash;
        const crossStore = state.config.storage === 'mongoAll' && BT[code].store === 'user';
        return (
          <div className="balrow" key={code} style={{ opacity: disabled ? 0.45 : 1 }}>
            <span className="cur">{label}</span>
            <div>
              <div className="split" style={{ color: crossStore ? 'var(--warn)' : undefined }} title={crossStore ? 'The primary amount is in RethinkDB and the Stash amount in Mongo: a transfer is two writes in two databases' : 'Same document as the primary amount'}>
                {stashPath(state, code)}{crossStore && ' ⚠'}
              </div>
              {disabled ? <span className="tag muted">cash deferred</span> : isBonusLocked(state, code) ? <span className="tag lock">transfer-in blocked</span> : null}
            </div>
            <span className={`amt big ${amount < 0 ? 'neg' : ''}`} style={{ color: amount > 0 ? 'var(--stash)' : undefined }}>{fmt(amount)}</span>
          </div>
        );
      })}
    </div>
  );
}

function Authenticator({ state, run }) {
  const code = totp(state.clock);
  const left = 30 - Math.floor((state.clock % 30000) / 1000);
  const used = (state.redis.totpUsed[code] ?? 0) > state.clock;
  const fails = state.redis.twoFaFails;
  const failCount = state.clock < fails.resetAt ? fails.count : 0;
  const limited = state.config.wrongCodeLimit === 'limiter';
  return (
    <div className="panel">
      <h2>Authenticator
        <span className="right">
          <button className={`btn small ${state.user.twofactorEnabled ? 'on' : ''}`} onClick={() => run(setTwoFactor, !state.user.twofactorEnabled)}>
            2FA {state.user.twofactorEnabled ? 'enabled' : 'disabled'}
          </button>
        </span>
      </h2>
      {state.user.twofactorEnabled ? (
        <>
          <div className="totp">
            <span className="code">{code}</span>
            <div style={{ flex: 1 }}>
              <div className="sub">{left}s left{used && <span style={{ color: 'var(--warn)' }}> · used</span>}
                <button className="btn small" style={{ float: 'right' }} onClick={() => run(tick, left * 1000)} title="Fast-forward the sim clock to the next code">next code</button>
              </div>
              <div className="bar"><div style={{ width: `${(left / 30) * 100}%` }} /></div>
            </div>
          </div>
          <div className="sub" style={{ marginTop: 8 }}>
            Codes are single-use for 120 s. Wrong codes in the last 5 min:{' '}
            <strong style={{ color: failCount >= WRONG_CODE_LIMIT ? 'var(--err)' : undefined }}>{failCount}</strong>
            {limited ? ` / ${WRONG_CODE_LIMIT}${failCount >= WRONG_CODE_LIMIT ? ' — locked' : ''}` : <span style={{ color: 'var(--warn)' }}> (no limit)</span>}
          </div>
        </>
      ) : (
        <div className="sub">The player has no 2FA. Moving funds out of Stash {state.config.twoFaPolicy === 'MANDATORY' ? 'is blocked (mandatory policy).' : 'goes through with a warning.'}</div>
      )}
    </div>
  );
}

function PlayerActions({ state, run }) {
  const [balanceType, setBalanceType] = useState('usdt');
  const [amount, setAmount] = useState('50');
  const [token, setToken] = useState('');
  const [bot, setBot] = useState(false);
  const [last, setLast] = useState(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const amt = Number(amount);

  useEffect(() => {
    if (!bot) return;
    const id = setInterval(() => {
      const primary = readBalance(stateRef.current, balanceType);
      if (primary <= 0) return;
      const stake = Number((primary * (0.08 + Math.random() * 0.12)).toFixed(2)) || primary;
      run(bet, { balanceType, amount: stake });
    }, 900);
    return () => clearInterval(id);
  }, [bot, balanceType]); // eslint-disable-line react-hooks/exhaustive-deps

  // A transfer keeps its request so "Retry last" can re-send it with the same requestId.
  const transfer = (fn, args) => {
    const req = { ...args, requestId: newRequestId() };
    setLast({ fn, args: req });
    run(fn, req);
  };

  const op = state.lastOp;
  return (
    <div className="panel">
      <h2>Player actions</h2>
      <div className="row" style={{ marginBottom: 8 }}>
        <select value={balanceType} onChange={(e) => setBalanceType(e.target.value)}>
          {BALANCE_TYPES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
        </select>
        <input type="number" value={amount} min="0" onChange={(e) => setAmount(e.target.value)} />
      </div>
      <div className="btns" style={{ marginBottom: 8 }}>
        <button className="btn main" onClick={() => run(deposit, { balanceType, amount: amt })}>Deposit</button>
        <button className="btn main" onClick={() => run(receiveTip, { balanceType, amount: amt })} title="A credit that is not a deposit">Receive tip</button>
        <button className="btn main" onClick={() => run(bet, { balanceType, amount: amt })}>Bet</button>
        <button className="btn main" onClick={() => run(bet, { balanceType, amount: amt, outcome: false })}>Bet &amp; lose</button>
        <button className="btn main" onClick={() => run(withdraw, { balanceType, amount: amt })}>Withdraw</button>
        <button className={`btn ${bot ? 'on' : ''}`} onClick={() => setBot(!bot)}>{bot ? '■ Stop autoplay' : '▶ Autoplay'}</button>
      </div>
      <div className="btns" style={{ marginBottom: 8 }}>
        <button className="btn stash" onClick={() => transfer(transferToStash, { balanceType, amount: amt })}>Primary → Stash</button>
        <button className="btn stash" onClick={() => transfer(raceTransferToStash, { balanceType, amount: amt })} title="The same request lands twice at the same moment">Double-click →</button>
        <button className="btn" disabled={!last} onClick={() => run(last.fn === raceTransferToStash ? transferToStash : last.fn, { ...last.args, token })} title="Re-send the last transfer with the same requestId, after it finished">Retry last</button>
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        <input placeholder="2FA code" value={token} onChange={(e) => setToken(e.target.value)} className="mono" />
        <button className="btn small" style={{ flex: 'none' }} onClick={() => setToken(totp(state.clock))} disabled={!state.user.twofactorEnabled}>paste code</button>
        <button className="btn stash" style={{ flex: 'none' }} onClick={() => transfer(transferFromStash, { balanceType, amount: amt, token })}>Stash → Primary</button>
      </div>
      <div className="row">
        <button className="btn" onClick={() => run(grantLockedBonus, { balanceType, amount: amt })} title="Adds a cashable (locked) bonus with 5x wagering">Grant bonus</button>
        <select value={state.fault} onChange={(e) => run(setFault, e.target.value)} title="Inject a fault into the next transfer">
          <option value="none">No fault injection</option>
          <option value="betweenWrites">Crash between debit and credit</option>
          <option value="rowWrite">Fail the transaction-row write</option>
        </select>
      </div>
      {op && (
        <div className={`toast ${op.ok === false ? 'err' : op.warning || op.rowFailed ? 'warn' : 'ok'}`}>
          <strong>{op.name}</strong> — {op.message}
          {op.warning && <div className="sub" style={{ marginTop: 3 }}>⚠ {op.warning}</div>}
          {op.rowFailed && <div className="sub" style={{ marginTop: 3 }}>⚠ The balance moved but its transaction rows were not written.</div>}
        </div>
      )}
    </div>
  );
}

function AutoReload({ state, run }) {
  const all = state.settings.stashReload;
  const [balanceType, setBalanceType] = useState('usdt');
  const [form, setForm] = useState(all.usdt);
  const pick = (code) => { setBalanceType(code); setForm(all[code]); };
  const token = () => (state.user.twofactorEnabled ? totp(state.clock) : undefined);
  const save = (withToken) => run(updateAutoReload, { balanceType, mode: form.mode, threshold: Number(form.threshold), target: Number(form.target), token: withToken ? token() : undefined });
  const reload = (code) => run(reloadFromStash, { balanceType: code, token: token(), requestId: newRequestId() });
  return (
    <div className="panel">
      <h2>Stash reload <span className="right sub">{state.config.reloadScope === 'balanceType' ? 'per balance type · USD' : <span style={{ color: 'var(--warn)' }}>one setting per user</span>}</span></h2>
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="field"><label>Balance type</label>
          <select value={balanceType} onChange={(e) => pick(e.target.value)}>
            {BALANCE_TYPES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </div>
        <div className="field"><label>Mode</label>
          <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
            {Object.entries(RELOAD_MODES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="field"><label>When primary drops below</label><input type="number" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} /></div>
        <div className="field"><label>Top up to</label><input type="number" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} /></div>
      </div>
      <div className="btns" style={{ marginBottom: 10 }}>
        <button className="btn on" onClick={() => save(true)}>Save (with 2FA)</button>
        <button className="btn danger" onClick={() => save(false)} title="Simulates a stolen session: no authenticator">Save as attacker</button>
      </div>
      {BALANCE_TYPES.map(({ code, label }) => {
        const st = all[code];
        const due = reloadSuggestion(state, code);
        return (
          <div className="balrow" key={code} style={{ opacity: st.mode === 'off' ? 0.5 : 1 }}>
            <span className="cur">{label}</span>
            <div>
              <span className={`tag ${st.mode === 'auto' ? 'ok' : st.mode === 'manual' ? 'stash' : 'muted'}`}>{st.mode}</span>
              <span className="split"> below {st.threshold} → {st.target}</span>
              {due > 0 && <div className="split" style={{ color: 'var(--warn)' }}>Primary is low: reload {fmt(due)}?</div>}
            </div>
            {st.mode !== 'off' && <button className={`btn small ${due > 0 ? 'stash' : ''}`} onClick={() => reload(code)} title="Top the primary balance up to the target now (2FA applies)">Reload now</button>}
          </div>
        );
      })}
      <p className="sub" style={{ marginTop: 8 }}>
        Manual is phase 1: the client prompts, and the reload is a normal 2FA-gated transfer-out.
        {' '}Auto is a later phase, because it runs in the bet path. It triggers on {state.config.autoReloadOnWithdraw ? <strong style={{ color: 'var(--warn)' }}>bets and withdrawals</strong> : 'bets only'},
        {' '}and switching to it {state.config.autoReloadEnable2fa ? 'requires a 2FA code' : <strong style={{ color: 'var(--warn)' }}>needs no 2FA</strong>}.
      </p>
    </div>
  );
}

/* ───────────── sequence diagram of the last operation ───────────── */

function Sequence({ state }) {
  const steps = state.trace;
  const cols = useMemo(() => {
    const used = new Set(steps.flatMap((s) => [s.from, s.to]));
    return PARTICIPANTS.filter((p) => used.has(p));
  }, [steps]);
  const x = (p) => ((cols.indexOf(p) + 0.5) / cols.length) * 100;

  return (
    <div className="panel">
      <h2>Sequence — last operation <span className="right sub">{state.lastOp?.name || 'run an action'}</span></h2>
      {steps.length === 0 ? (
        <p className="sub">Every action renders here as a sequence diagram: service calls, which database each write goes to, the guard inside the update, transaction rows and the CRM message each row triggers. Hover a step for the payload.</p>
      ) : (
        <div className="seq">
          <div className="seq-inner">
            <div className="seq-head" style={{ gridTemplateColumns: `repeat(${cols.length}, 1fr)` }}>
              {cols.map((c) => <div key={c}><span>{c}</span></div>)}
            </div>
            {steps.map((s, i) => {
              const title = s.detail ? JSON.stringify(s.detail, null, 2) : s.label;
              return (
                <div className="seq-row" key={i} title={title}>
                  {cols.map((c) => <div key={c} className="seq-life" style={{ left: `${x(c)}%` }} />)}
                  {s.from === s.to ? (
                    <div className="seq-note" style={{ left: `${x(s.from)}%`, color: s.kind === 'error' ? 'var(--err)' : undefined }}>{s.label}</div>
                  ) : (
                    <Arrow s={s} a={x(s.from)} b={x(s.to)} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
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
  const crm = state.crm[0];
  return (
    <div className="panel">
      <h2>Event log <span className="right sub">{state.ws.length} socket events · {state.crm.length} CRM messages</span></h2>
      <div className="log">
        {state.events.length === 0 && <div className="info">No events yet.</div>}
        {state.events.map((e, i) => (
          <div key={state.events.length - i}><span className="t">{clockStr(e.t)}</span><span className={e.level}>{e.msg}</span></div>
        ))}
      </div>
      {state.ws[0] && (
        <div className="sub mono" style={{ marginTop: 8, overflowWrap: 'anywhere' }}>
          last socket → {JSON.stringify(state.ws[0])}
        </div>
      )}
      {crm && (
        <div className="sub mono" style={{ marginTop: 4, overflowWrap: 'anywhere', color: isStashBucket(crm.balanceType) ? 'var(--err)' : undefined }}>
          last FastTrack → real_money {fmt(crm.amount)} (from a {crm.balanceType} row)
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── ACP ───────────────────────── */

function Acp({ state, run }) {
  const [form, setForm] = useState({ action: 'transfer-in', balanceType: 'usdt', amount: '25', reason: ADMIN_REASONS[0], adminId: 'adm_ops_jane' });
  const balances = mapBalanceInformation(state);
  const pnl = calculatePnl(state);
  const adminRows = state.transactions.filter((t) => t.meta?.source === 'admin');
  const useAudits = state.config.audit === 'audits';
  return (
    <>
      <div className="panel">
        <h2>ACP · {state.user.name} {state.user.deleted && <span className="tag err">deleted</span>} <span className="right sub mono">{state.user.id}</span></h2>
        <table>
          <thead>
            <tr><th>Balance</th><th style={{ textAlign: 'right' }}>Primary</th><th style={{ textAlign: 'right' }}>Bonus</th><th style={{ textAlign: 'right' }}>Stash</th><th>Status</th></tr>
          </thead>
          <tbody>
            {BALANCE_TYPES.map(({ code, label }) => (
              <tr key={code}>
                <td className="cur">{label}</td>
                <td className="num">{fmt(readBalance(state, code))}</td>
                <td className="num">{fmt(readBalance(state, code, 'bonus'))}</td>
                <td className="num" style={{ color: 'var(--stash)' }}>{fmt(readBalance(state, code, 'stash'))}</td>
                <td>{state.bonuses[code] ? <span className="tag lock">bonus</span> : <span className="faint">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="sub" style={{ marginTop: 10 }}>
          totalBalance (sum of <code>UserBalances</code> keys): <strong className="mono">{fmt(totalBalance(balances))}</strong>
        </div>
        <div className="sub" style={{ marginTop: 3 }} title="deposits − withdrawals − totalBalance. A positive value is treated as a loss by cashback and lossback.">
          Cashback / lossback P&amp;L: <strong className="mono" style={{ color: pnl > 0 ? 'var(--warn)' : undefined }}>{fmt(pnl)}</strong>
          <span className="faint"> = {fmt(state.flows.deposited)} − {fmt(state.flows.withdrawn)} − {fmt(totalBalance(balances))}</span>
        </div>
        <div className="sub mono" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>Connect API → {JSON.stringify(connectApiBalances(state))}</div>
      </div>
      <div className="panel">
        <h2>Stash transfer <span className="right sub">admin GraphQL</span></h2>
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="field"><label>Action</label>
            <select value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
              <option value="transfer-in">Primary → Stash</option>
              <option value="transfer-out">Stash → Primary</option>
            </select>
          </div>
          <div className="field"><label>Balance type</label>
            <select value={form.balanceType} onChange={(e) => setForm({ ...form, balanceType: e.target.value })}>
              {BALANCE_TYPES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </div>
          <div className="field"><label>Amount</label>
            <input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
        </div>
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="field"><label>Reason (server-side list)</label>
            <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
              {ADMIN_REASONS.map((r) => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div className="field"><label>adminId (from session)</label>
            <input className="mono" value={form.adminId} onChange={(e) => setForm({ ...form, adminId: e.target.value })} />
          </div>
        </div>
        <button className="btn stash" onClick={() => run(adminStash, { ...form, amount: Number(form.amount) })}>
          mutation {form.action === 'transfer-in' ? 'stashTransferIn' : 'stashTransferOut'}
        </button>
      </div>
      <div className="panel">
        <h2>Operations <span className="right sub">things that read or expire data</span></h2>
        <div className="btns">
          <button className="btn" onClick={() => run(adminExport)} title="A hydrating read of every row: the schema hook validates each balanceType">Export transactions CSV</button>
          <button className="btn" onClick={() => run(cleanupOldUsers)} title="Deletes accounts with no BTC balance that never deposited or bet">Run account cleanup</button>
          <button className="btn" onClick={() => run(advanceDays, { days: 181 })} title="Transaction rows expire after 180 days">+181 days</button>
        </div>
        {state.alerts.length > 0 && (
          <div className="log" style={{ marginTop: 8 }}>
            {state.alerts.map((a, i) => <div key={i}><span className="t">{clockStr(a.t)}</span><span className="warn">ALERT {a.msg}</span></div>)}
          </div>
        )}
      </div>
      <div className="panel">
        <h2>Audit log <span className="right sub">{useAudits ? 'audits collection · no TTL' : <span style={{ color: 'var(--warn)' }}>transaction rows · 180-day TTL</span>}</span></h2>
        <div className="scroll" style={{ maxHeight: 300 }}>
          <table>
            <thead><tr><th>Time</th><th>Action</th><th style={{ textAlign: 'right' }}>Amount</th><th>By / reason</th></tr></thead>
            <tbody>
              {useAudits ? (
                <>
                  {state.audits.length === 0 && <tr><td colSpan={4} className="faint">Nothing yet.</td></tr>}
                  {state.audits.map((a) => (
                    <tr key={a._id}>
                      <td className="mono faint">{clockStr(a.createdAt)}</td>
                      <td><span className={`tag ${a.success ? 'stash' : 'err'}`}>{a.meta.direction === 'in' ? 'in' : 'out'}{a.success ? '' : ' failed'}</span> <span className="faint">{BT[a.meta.balanceType].label}</span></td>
                      <td className="num">{fmt(a.meta.amount)}</td>
                      <td className="sub">{a.editorId} · {a.reason}</td>
                    </tr>
                  ))}
                </>
              ) : (
                <>
                  {adminRows.length === 0 && <tr><td colSpan={4} className="faint">No admin rows{state.rowsExpired ? ' left: they expired.' : ' yet.'}</td></tr>}
                  {adminRows.map((t) => (
                    <tr key={t._id}>
                      <td className="mono faint">{clockStr(t.createdAt)}</td>
                      <td><span className="tag stash">{t.type}</span> <span className="faint">{t.balanceType}</span></td>
                      <td className={`num ${t.amount < 0 ? 'neg' : 'pos'}`}>{t.amount > 0 ? '+' : ''}{fmt(t.amount)}</td>
                      <td className="sub">{t.meta.adminId} · {t.meta.reason}</td>
                    </tr>
                  ))}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ───────────────────── collection + invariants ───────────────────── */

const bucketTag = (v) => (isStashBucket(v) ? 'stash' : v.endsWith('Bonus') ? 'lock' : 'main');

function Transactions({ state }) {
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState(null);
  const seen = useRef(new Set());
  const match = { all: () => true, stash: (t) => /^stash/i.test(t.type), primary: (t) => Boolean(BT[t.balanceType]), stashRows: (t) => isStashBucket(t.balanceType) }[filter];
  const rows = state.transactions.filter(match).slice(0, 150);
  useEffect(() => { rows.forEach((t) => seen.current.add(t._id)); });
  return (
    <div className="panel">
      <h2>mongo0.transactions <span className="right sub">{state.transactions.length} docs · 180-day TTL · no new fields or indexes</span></h2>
      <div className="seg" style={{ marginBottom: 8 }}>
        {[['all', 'All'], ['stash', 'Stash transfers'], ['primary', 'Primary rows'], ['stashRows', 'Stash rows']].map(([k, l]) => (
          <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      <div className="scroll">
        <table>
          <thead><tr><th>_id</th><th>type</th><th>balanceType</th><th style={{ textAlign: 'right' }}>amount</th><th style={{ textAlign: 'right' }}>currentBalance</th><th>meta</th><th>createdAt</th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <FragmentRow key={t._id} t={t} isNew={!seen.current.has(t._id)} open={open === t._id} toggle={() => setOpen(open === t._id ? null : t._id)} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FragmentRow({ t, isNew, open, toggle }) {
  const metaStr = t.meta ? Object.entries(t.meta).map(([k, v]) => `${k}=${k === 'transferId' ? `…${String(v).slice(-4)}` : v}`).join(' ') : '';
  return (
    <>
      <tr className={isNew ? 'new' : ''} onClick={toggle} style={{ cursor: 'pointer' }}>
        <td className="mono faint">…{t._id.slice(-6)}</td>
        <td className="mono">{t.type}</td>
        <td><span className={`tag ${bucketTag(t.balanceType)}`} style={{ textTransform: 'none' }}>{t.balanceType}</span></td>
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
          <Row key={g} g={g} list={list} />
        ))}
      </div>
      <p className="sub" style={{ marginTop: 10 }}>Hover a cell for numbers. <strong>Conservation</strong> compares primary + bonus + Stash with net external flows, so a transfer can never create or destroy money. <strong>Latest row</strong> checks that the newest row of each bucket carries that bucket&apos;s real balance in <code>currentBalance</code>.</p>
    </div>
  );
}

function Row({ g, list }) {
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
            <FragmentScenario key={sc.id} sc={sc} byPreset={byPreset} sel={sel} setSel={setSel} load={load} />
          ))}
        </tbody>
      </table>
      <p className="sub" style={{ marginTop: 10 }}><span className="pill gap">GAP</span> marks a failure the plan knowingly accepts. Click the cell for the reason.</p>
    </div>
  );
}

function FragmentScenario({ sc, byPreset, sel, setSel, load }) {
  const open = sel?.id === sc.id;
  const isGap = (k, r) => !r.pass && k === 'recommended' && sc.acceptedGap;
  return (
    <>
      <tr>
        <td>{sc.title}</td>
        <td className="mono faint">{sc.suite}</td>
        {Object.entries(byPreset).map(([k, r]) => (
          <td key={k} className="res" onClick={() => setSel(open && sel.preset === k ? null : { id: sc.id, preset: k })} style={{ cursor: 'pointer' }}>
            <span className={`pill ${r.pass ? 'pass' : isGap(k, r) ? 'gap' : 'fail'}`}>{r.pass ? 'PASS' : isGap(k, r) ? 'GAP' : 'FAIL'}</span>
          </td>
        ))}
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ background: 'var(--panel-2)' }}>
            <strong>{PRESETS[sel.preset].label}:</strong>
            <ul style={{ paddingLeft: 18, margin: '4px 0 8px' }}>{byPreset[sel.preset].notes.map((n, i) => <li key={i} className="mono">{n}</li>)}</ul>
            {isGap(sel.preset, byPreset[sel.preset]) && <p className="sub" style={{ marginBottom: 8 }}><strong>Accepted gap:</strong> {sc.acceptedGap}</p>}
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
