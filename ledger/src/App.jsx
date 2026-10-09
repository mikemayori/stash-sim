import { useEffect, useState } from 'react';
import { PRESETS, PRESET_ALIASES, createState, createMigration, mSeed, deposit, grantBonus, stashIn, setConfig } from './engine.js';
import Simulator from './Simulator.jsx';
import Database from './Database.jsx';
import Scenarios from './Scenarios.jsx';
import Migration from './Migration.jsx';
import Guide from './Guide.jsx';
import { clockStr } from './ui.jsx';

const TABS = [['sim', 'Simulator'], ['db', 'Database'], ['scenarios', 'Test scenarios'], ['migration', 'Migration'], ['guide', 'How it works']];
const tabFromHash = () => {
  const h = window.location.hash.slice(1);
  return TABS.some(([k]) => k === h) ? h : 'sim';
};
/** `?preset=current|pseudocode|hardened|stash`; `deployed` is an alias for current. */
function presetFromUrl() {
  const p = new URLSearchParams(window.location.search).get('preset');
  const key = PRESET_ALIASES[p] || p;
  return PRESETS[key] ? key : 'current';
}

// Starting point for demos: funds in one portfolio type and one legacy type, and an active bonus on USDT.
function seeded(config) {
  let s = [
    [deposit, { balanceType: 'usdt', amount: 500 }],
    [deposit, { balanceType: 'cash', amount: 250 }],
    [grantBonus, { balanceType: 'usdt', amount: 50 }],
  ].reduce((acc, [fn, args]) => fn(acc, args), createState(config));
  if (s.config.stash === 'on') s = stashIn(s, { balanceType: 'usdt', amount: 100 });
  return s;
}
const freshMigration = () => mSeed(createMigration(), { primary: 100, bonus: 0 });

export default function App() {
  // `#db` / `#scenarios` / `#migration` / `#guide` open that tab directly.
  const [tab, setTabState] = useState(tabFromHash);
  const [preset, setPreset] = useState(presetFromUrl);
  const [state, setState] = useState(() => seeded(PRESETS[presetFromUrl()].config));
  const [migration, setMigration] = useState(freshMigration);
  const [crash, setCrash] = useState(null);

  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const setTab = (k) => {
    setTabState(k);
    window.history.replaceState(null, '', k === 'sim' ? window.location.pathname + window.location.search : `#${k}`);
  };

  // Runs one engine operation. An exception inside the engine is shown, not swallowed, and the state is kept.
  const run = (fn, args) => {
    try {
      setState(fn(state, args));
      setCrash(null);
    } catch (e) {
      setCrash(`${fn.name || 'operation'} threw: ${e.message}`);
    }
  };
  const applyPreset = (key) => {
    setPreset(key);
    setState((s) => setConfig(s, PRESETS[key].config));
  };
  const reset = () => { setCrash(null); setState((s) => seeded(s.config)); };
  const load = (loadedState, key, switchTab = true) => {
    if (PRESETS[key]) setPreset(key);
    setState(loadedState);
    setCrash(null);
    if (switchTab) setTab('sim');
  };
  const loadMigration = (m) => { setMigration(m); setTab('migration'); };

  return (
    <div className="app">
      <div className="topbar">
        <h1>Ledger <span>Simulator</span></h1>
        <div className="tabs">
          {TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        <span className="sub">the current ledger, per current-ledger-analysis.md</span>
        <div className="spacer" />
        {(tab === 'sim' || tab === 'db') && <span className="sub mono">{PRESETS[preset].label} · sim clock {clockStr(state.clock)}</span>}
      </div>
      {crash && <div className="toast err" style={{ marginBottom: 14 }}><strong>Engine error.</strong> {crash}</div>}

      {tab === 'sim' && <Simulator state={state} run={run} setState={setState} preset={preset} applyPreset={applyPreset} reset={reset} load={load} />}
      {tab === 'db' && <Database state={state} />}
      {tab === 'scenarios' && <Scenarios load={load} loadMigration={loadMigration} />}
      {tab === 'migration' && <Migration m={migration} setM={setMigration} />}
      {tab === 'guide' && <Guide />}
    </div>
  );
}
