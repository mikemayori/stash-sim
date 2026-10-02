import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CURRENCIES, CUR, ADMIN_REASONS, PARTICIPANTS, KNOBS, PRESETS,
  createState, deposit, bet, withdraw, grantLockedBonus, transferToStash, transferFromStash,
  raceTransferToStash, adminStash, updateAutoReload, setConfig, setFault, setTwoFactor, tick,
  mapBalanceInformation, invariants, isBonusLocked, totp,
} from './engine.js';
import { SCENARIOS, runScenario } from './scenarios.js';
import Plan from './Plan.jsx';

const fmt = (cur, n) => Number(n).toFixed(CUR[cur].dp);
const clockStr = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const parseKnob = (v) => (v === 'true' ? true : v === 'false' ? false : v);

// Starting point for demos: some Main funds in two currencies, part of the USDT already stashed.
const seeded = (config) => [
  [deposit, { currency: 'usdt', amount: 500 }],
  [deposit, { currency: 'btc', amount: 0.25 }],
  [transferToStash, { currency: 'usdt', amount: 300 }],
].reduce((s, [fn, args]) => fn(s, args), createState(config));

export default function App() {
  const [tab, setTab] = useState('sim');
  const [state, setState] = useState(() => seeded(PRESETS.spec.config));
  const [preset, setPreset] = useState('spec');

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

  return (
    <div className="app">
      <div className="topbar">
        <h1>Stash Balance <span>Simulator</span></h1>
        <div className="tabs">
          {[['sim', 'Simulator'], ['scenarios', 'Test scenarios'], ['plan', 'Technical plan']].map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <div className="spacer" />
        {tab === 'sim' && <span className="sub mono">sim clock {clockStr(state.clock)}</span>}
      </div>

      {tab === 'sim' && <Simulator state={state} run={run} setState={setState} preset={preset} applyPreset={applyPreset} reset={reset} />}
      {tab === 'scenarios' && <Scenarios />}
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
  const wagerable = mapBalanceInformation(state.portfolio, state.config);
  return (
    <div className="panel">
      <h2><span className="tag main">MAIN</span> Balance selector <span className="right sub">what the game sees</span></h2>
      {CURRENCIES.map(({ code, label }) => {
        const b = state.portfolio.balances[code];
        const leak = Math.abs((wagerable[code] || 0) - b.total) > 1e-9;
        return (
          <div className="balrow" key={code}>
            <span className="cur">{label}</span>
            <div>
              <div className="split">real {fmt(code, b.original)} · bonus {fmt(code, b.bonus)}</div>
              {state.bonuses[code] && (
                <div className="split" style={{ color: 'var(--warn)' }}>
                  🔒 wagering {fmt(code, state.bonuses[code].wagered)} / {fmt(code, state.bonuses[code].wagerRequirement)}
                </div>
              )}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className={`amt big ${b.total < 0 ? 'neg' : ''}`}>{fmt(code, b.total)}</div>
              {leak && <div className="split" style={{ color: 'var(--err)' }}>wagerable {fmt(code, wagerable[code])} ⚠</div>}
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
      <h2><span className="tag stash">STASH</span> Vault <span className="right sub">not wagerable</span></h2>
      {CURRENCIES.map(({ code, label, kind }) => {
        const b = state.portfolio.stashBalances[code];
        const disabled = kind === 'fiat' && !state.config.fiatStash;
        return (
          <div className="balrow" key={code} style={{ opacity: disabled ? 0.45 : 1 }}>
            <span className="cur">{label}</span>
            <span>{disabled ? <span className="tag muted">fiat deferred</span> : isBonusLocked(state, code) ? <span className="tag lock">transfer-in blocked</span> : null}</span>
            <span className={`amt big ${b.total < 0 ? 'neg' : ''}`} style={{ color: b.total > 0 ? 'var(--stash)' : undefined }}>{fmt(code, b.total)}</span>
          </div>
        );
      })}
    </div>
  );
}

function Authenticator({ state, run }) {
  const code = totp(state.clock);
  const left = 30 - Math.floor((state.clock % 30000) / 1000);
  return (
    <div className="panel">
      <h2>Authenticator
        <span className="right">
          <button className={`btn small ${state.user.twoFactorEnabled ? 'on' : ''}`} onClick={() => run(setTwoFactor, !state.user.twoFactorEnabled)}>
            2FA {state.user.twoFactorEnabled ? 'enabled' : 'disabled'}
          </button>
        </span>
      </h2>
      {state.user.twoFactorEnabled ? (
        <div className="totp">
          <span className="code">{code}</span>
          <div style={{ flex: 1 }}>
            <div className="sub">{left}s left</div>
            <div className="bar"><div style={{ width: `${(left / 30) * 100}%` }} /></div>
          </div>
        </div>
      ) : (
        <div className="sub">The player has no 2FA. Moving funds out of Stash {state.config.twoFaPolicy === 'MANDATORY' ? 'is blocked (mandatory policy).' : 'goes through with a warning.'}</div>
      )}
    </div>
  );
}

function PlayerActions({ state, run }) {
  const [currency, setCurrency] = useState('usdt');
  const [amount, setAmount] = useState('50');
  const [token, setToken] = useState('');
  const [bot, setBot] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const amt = Number(amount);

  useEffect(() => {
    if (!bot) return;
    const id = setInterval(() => {
      const main = stateRef.current.portfolio.balances[currency].total;
      if (main <= 0) return;
      const stake = Number((main * (0.08 + Math.random() * 0.12)).toFixed(CUR[currency].dp)) || main;
      run(bet, { currency, amount: stake });
    }, 900);
    return () => clearInterval(id);
  }, [bot, currency]); // eslint-disable-line react-hooks/exhaustive-deps

  const op = state.lastOp;
  return (
    <div className="panel">
      <h2>Player actions</h2>
      <div className="row" style={{ marginBottom: 8 }}>
        <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
        </select>
        <input type="number" value={amount} min="0" onChange={(e) => setAmount(e.target.value)} />
      </div>
      <div className="btns" style={{ marginBottom: 8 }}>
        <button className="btn main" onClick={() => run(deposit, { currency, amount: amt })}>Deposit</button>
        <button className="btn main" onClick={() => run(bet, { currency, amount: amt })}>Bet</button>
        <button className="btn main" onClick={() => run(bet, { currency, amount: amt, outcome: false })}>Bet &amp; lose</button>
        <button className="btn main" onClick={() => run(withdraw, { currency, amount: amt })}>Withdraw</button>
        <button className={`btn ${bot ? 'on' : ''}`} onClick={() => setBot(!bot)}>{bot ? '■ Stop autoplay' : '▶ Autoplay'}</button>
      </div>
      <div className="btns" style={{ marginBottom: 8 }}>
        <button className="btn stash" onClick={() => run(transferToStash, { currency, amount: amt })}>Main → Stash</button>
        <button className="btn stash" onClick={() => run(raceTransferToStash, { currency, amount: amt })} title="Two identical requests land on two pods at the same time">Double-submit →</button>
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        <input placeholder="2FA token" value={token} onChange={(e) => setToken(e.target.value)} className="mono" />
        <button className="btn small" style={{ flex: 'none' }} onClick={() => setToken(totp(state.clock))} disabled={!state.user.twoFactorEnabled}>paste code</button>
        <button className="btn stash" style={{ flex: 'none' }} onClick={() => run(transferFromStash, { currency, amount: amt, token })}>Stash → Main</button>
      </div>
      <div className="row">
        <button className="btn" onClick={() => run(grantLockedBonus, { currency, amount: amt })} title="Adds a locked bonus with 5x wagering">Grant locked bonus</button>
        <select value={state.fault} onChange={(e) => run(setFault, e.target.value)} title="Inject a crash into the next transfer">
          <option value="none">No fault injection</option>
          <option value="afterDebit">Crash next transfer after debit</option>
          <option value="afterCredit">Crash next transfer after credit</option>
        </select>
      </div>
      {op && (
        <div className={`toast ${op.ok === false ? 'err' : op.warning ? 'warn' : 'ok'}`}>
          <strong>{op.name}</strong> — {op.message}
          {op.warning && <div className="sub" style={{ marginTop: 3 }}>⚠ {op.warning}</div>}
        </div>
      )}
    </div>
  );
}

function AutoReload({ state, run }) {
  const st = state.settings;
  const [form, setForm] = useState({ threshold: st.stashAutoReloadThreshold, target: st.stashAutoReloadTargetAmount, currency: st.stashAutoReloadCurrency });
  const save = (enabled) => run(updateAutoReload, {
    enabled, threshold: Number(form.threshold), target: Number(form.target), currency: form.currency,
    token: state.user.twoFactorEnabled ? totp(state.clock) : undefined,
  });
  const saveWithoutToken = () => run(updateAutoReload, { enabled: true, threshold: Number(form.threshold), target: Number(form.target), currency: form.currency });
  return (
    <div className="panel">
      <h2>Auto-reload <span className="right">{st.stashAutoReloadEnabled ? <span className="tag ok">on</span> : <span className="tag muted">off</span>}</span></h2>
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="field"><label>Currency</label>
          <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
            {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </div>
        <div className="field"><label>Threshold</label><input type="number" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} /></div>
        <div className="field"><label>Top up to</label><input type="number" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} /></div>
      </div>
      <div className="btns">
        <button className="btn on" onClick={() => save(true)}>Enable (with 2FA)</button>
        <button className="btn danger" onClick={saveWithoutToken} title="Simulates a stolen session: no authenticator">Enable as attacker</button>
        <button className="btn" onClick={() => save(false)}>Disable</button>
      </div>
      <p className="sub" style={{ marginTop: 8 }}>
        Triggers on {state.config.autoReloadOnWithdraw ? <strong style={{ color: 'var(--warn)' }}>bets and withdrawals</strong> : 'bets only'}.
        {' '}Enabling {state.config.autoReloadEnable2fa ? 'requires a 2FA token' : <strong style={{ color: 'var(--warn)' }}>needs no 2FA</strong>}.
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
        <p className="sub">Every action renders here as a sequence diagram: service calls, the exact Mongo filter/update, session boundaries and stats writes. Hover a step for the payload.</p>
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
  return (
    <div className="panel">
      <h2>Event log <span className="right sub">{state.ws.length} websocket events emitted</span></h2>
      <div className="log">
        {state.events.length === 0 && <div className="info">No events yet.</div>}
        {state.events.map((e, i) => (
          <div key={state.events.length - i}><span className="t">{clockStr(e.t)}</span><span className={e.level}>{e.msg}</span></div>
        ))}
      </div>
      {state.ws[0] && (
        <div className="sub mono" style={{ marginTop: 8, overflowWrap: 'anywhere' }}>
          last ws → {JSON.stringify(state.ws[0])}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── ACP ───────────────────────── */

function Acp({ state, run }) {
  const [form, setForm] = useState({ action: 'add', currency: 'usdt', amount: '25', reason: ADMIN_REASONS[0], adminId: 'adm_ops_jane' });
  const audit = state.transactions.filter((t) => t.type.startsWith('ADMIN_STASH_') || t.type.startsWith('STASH_'));
  return (
    <>
      <div className="panel">
        <h2>ACP · {state.user.username} <span className="right sub mono">{state.user.userId}</span></h2>
        <table>
          <thead>
            <tr><th>Balance</th><th style={{ textAlign: 'right' }}>Main</th><th style={{ textAlign: 'right' }}>Stash</th><th>Status</th></tr>
          </thead>
          <tbody>
            {CURRENCIES.map(({ code, label }) => (
              <tr key={code}>
                <td className="cur">{label}</td>
                <td className="num">{fmt(code, state.portfolio.balances[code].total)}</td>
                <td className="num" style={{ color: 'var(--stash)' }}>{fmt(code, state.portfolio.stashBalances[code].total)}</td>
                <td>{state.bonuses[code] ? <span className="tag lock">locked bonus</span> : <span className="faint">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h2>Stash adjustment</h2>
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="field"><label>Action</label>
            <select value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
              <option value="add">Add</option>
              <option value="confiscate">Confiscate</option>
              <option value="reset">Reset to zero</option>
            </select>
          </div>
          <div className="field"><label>Currency</label>
            <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </div>
          <div className="field"><label>Amount</label>
            <input type="number" value={form.action === 'reset' ? '' : form.amount} disabled={form.action === 'reset'} placeholder="all" onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
        </div>
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="field"><label>Reason</label>
            <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
              {ADMIN_REASONS.map((r) => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div className="field"><label>adminId (from session)</label>
            <input className="mono" value={form.adminId} onChange={(e) => setForm({ ...form, adminId: e.target.value })} />
          </div>
        </div>
        <button className={`btn ${form.action === 'add' ? 'stash' : 'danger'}`} onClick={() => run(adminStash, { ...form, amount: Number(form.amount) })}>
          POST /admin/stash/{form.action}
        </button>
      </div>
      <div className="panel">
        <h2>Audit log <span className="right sub">stash txs only</span></h2>
        <div className="scroll" style={{ maxHeight: 360 }}>
          <table>
            <thead><tr><th>Time</th><th>Type</th><th style={{ textAlign: 'right' }}>Amount</th><th>By / reason</th></tr></thead>
            <tbody>
              {audit.length === 0 && <tr><td colSpan={4} className="faint">Nothing yet.</td></tr>}
              {audit.map((t) => (
                <tr key={t._id}>
                  <td className="mono faint">{clockStr(t.createdAt)}</td>
                  <td><span className={`tag ${t.type.startsWith('ADMIN') ? 'lock' : 'stash'}`}>{t.type}</span>{t.leg && <span className="faint"> {t.leg.toLowerCase()}</span>}</td>
                  <td className={`num ${t.amount < 0 ? 'neg' : 'pos'}`}>{t.amount > 0 ? '+' : ''}{fmt(t.currency, t.amount)} <span className="faint">{CUR[t.currency].label}</span></td>
                  <td className="sub">{t.meta?.adminId ? `${t.meta.adminId} · ${t.meta.reason}` : t.meta?.source === 'autoReload' ? 'auto-reload' : 'player'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ───────────────────── collection + invariants ───────────────────── */

function Transactions({ state }) {
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState(null);
  const seen = useRef(new Set());
  const rows = state.transactions.filter((t) => filter === 'all' || (filter === 'stash' ? t.type.includes('STASH') : t.balanceType === filter)).slice(0, 150);
  useEffect(() => { rows.forEach((t) => seen.current.add(t._id)); });
  return (
    <div className="panel">
      <h2>db.transactions <span className="right sub">{state.transactions.length} docs</span></h2>
      <div className="seg" style={{ marginBottom: 8 }}>
        {[['all', 'All'], ['stash', 'Stash types'], ['MAIN', 'balanceType: MAIN'], ['STASH', 'balanceType: STASH']].map(([k, l]) => (
          <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      <div className="scroll">
        <table>
          <thead><tr><th>_id</th><th>type</th><th>currency</th><th>balanceType</th><th style={{ textAlign: 'right' }}>amount</th><th>transferId / meta</th><th>createdAt</th></tr></thead>
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
  const metaStr = [t.transferId && `tx:${t.transferId.slice(-6)} ${t.leg}`, t.meta && Object.entries(t.meta).map(([k, v]) => `${k}=${v}`).join(' ')].filter(Boolean).join(' · ');
  return (
    <>
      <tr className={isNew ? 'new' : ''} onClick={toggle} style={{ cursor: 'pointer' }}>
        <td className="mono faint">…{t._id.slice(-6)}</td>
        <td className="mono">{t.type}</td>
        <td className="mono">{t.currency}</td>
        <td><span className={`tag ${t.balanceType === 'STASH' ? 'stash' : 'main'}`}>{t.balanceType}</span></td>
        <td className={`num ${t.amount < 0 ? 'neg' : t.amount > 0 ? 'pos' : ''}`}>{t.amount > 0 ? '+' : ''}{fmt(t.currency, t.amount)}</td>
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
        {CURRENCIES.map((c) => <div key={c.code} className="h">{c.label}</div>)}
        {groups.map((g) => (
          <Row key={g} g={g} list={list} />
        ))}
      </div>
      <p className="sub" style={{ marginTop: 10 }}>Hover a cell for numbers. <strong>Conservation</strong> compares Main+Stash with net external flows (deposits, wins, bonuses and admin adds, minus bets, withdrawals and confiscations), so a transfer can never create or destroy money.</p>
    </div>
  );
}

function Row({ g, list }) {
  return (
    <>
      <div>{g}</div>
      {CURRENCIES.map((c) => {
        const i = list.find((x) => x.group === g && x.cur === c.label);
        return <div key={c.code} className="c" title={i.detail} style={{ color: i.ok ? 'var(--ok)' : 'var(--err)' }}>{i.ok ? '✓' : '✗'}</div>;
      })}
    </>
  );
}

/* ───────────────────────── Scenarios tab ───────────────────────── */

function Scenarios() {
  const results = useMemo(() => SCENARIOS.map((sc) => ({
    sc,
    byPreset: Object.fromEntries(Object.keys(PRESETS).map((k) => [k, runScenario(sc, PRESETS[k].config)])),
  })), []);
  const [sel, setSel] = useState(null);
  return (
    <div className="panel">
      <h2>Scenario matrix <span className="right sub">each scenario runs on a fresh portfolio against every preset · click a cell for details</span></h2>
      <table className="matrix">
        <thead>
          <tr><th>Scenario</th><th>Suite</th>{Object.values(PRESETS).map((p) => <th key={p.label} style={{ textAlign: 'center' }}>{p.label}</th>)}</tr>
        </thead>
        <tbody>
          {results.map(({ sc, byPreset }) => (
            <FragmentScenario key={sc.id} sc={sc} byPreset={byPreset} sel={sel} setSel={setSel} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FragmentScenario({ sc, byPreset, sel, setSel }) {
  const open = sel?.id === sc.id;
  return (
    <>
      <tr>
        <td>{sc.title}</td>
        <td className="mono faint">{sc.suite}</td>
        {Object.entries(byPreset).map(([k, r]) => (
          <td key={k} className="res" onClick={() => setSel(open && sel.preset === k ? null : { id: sc.id, preset: k })} style={{ cursor: 'pointer' }}>
            <span className={`pill ${r.pass ? 'pass' : 'fail'}`}>{r.pass ? 'PASS' : 'FAIL'}</span>
          </td>
        ))}
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ background: 'var(--panel-2)' }}>
            <strong>{PRESETS[sel.preset].label}:</strong>
            <ul style={{ paddingLeft: 18, marginTop: 4 }}>{byPreset[sel.preset].notes.map((n, i) => <li key={i} className="mono">{n}</li>)}</ul>
          </td>
        </tr>
      )}
    </>
  );
}
