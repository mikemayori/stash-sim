import { KNOBS, PRESETS } from './engine.js';
import { SCENARIOS } from './scenarios.js';

const Box = ({ title, children }) => <div className="box"><b>{title}</b><span>{children}</span></div>;
const Arrow = () => <div className="arrow">→</div>;

export default function Guide() {
  return (
    <div className="panel guide">
      <h3>What this is</h3>
      <p>A working model of the ledger described in <code>LEDGER_STUDY.md</code>. It runs entirely in the browser: there is no server and no database. The documents you see (<code>user_altcoin_portfolios</code>, <code>users</code>, <code>transactions</code>) are plain objects in memory, changed by the same steps the study describes.</p>
      <p>Use it to answer two kinds of question: <strong>what does the ledger do when X happens</strong>, and <strong>what breaks, and what would fix it</strong>.</p>

      <h3>What happens when you click a button</h3>
      <div className="flow">
        <Box title="1. Button">An action such as Deposit, Bet or Refund, with the selected balance type and amount.</Box>
        <Arrow />
        <Box title="2. Engine operation">A function in <code>engine.js</code> takes the current state and returns a new one. It never changes the old state.</Box>
        <Arrow />
        <Box title="3. Trace">While it runs, the operation records every call, return, error and note as a step.</Box>
        <Arrow />
        <Box title="4. Screen">Balances, sequence diagram, transaction rows and rule checks are all redrawn from the new state.</Box>
      </div>
      <p>Inside step 2, a balance change follows the study exactly: the calling module calls the ledger API, the ledger routes to the right store, one update pipeline changes the balance, and the transaction rows are written afterwards in a separate write.</p>
      <p>The update pipeline is real: the engine builds MongoDB-style stages (<code>$set</code>, <code>$cond</code>, <code>$min</code>…) and a small evaluator runs them against the document. The Database tab shows the pipeline of the last update.</p>

      <h3>The Simulator screen</h3>
      <div className="screen">
        <div className="wide"><b>Preset bar</b><span>Which version of the ledger is running, and the design knobs behind it.</span></div>
        <div><b>Balances, Actions, Open bets</b><span>Click a balance row to choose what the buttons act on. Payments, bets and bonuses are here.</span></div>
        <div><b>Sequence and Event log</b><span>The last operation, step by step, and a running history of results.</span></div>
        <div><b>Concurrency &amp; faults, Admin, Responsible gaming</b><span>Simultaneous requests, replays, a failed row insert, time jumps, admin set, limits.</span></div>
        <div className="two"><b>transactions</b><span>The history rows, newest first. Click a row for the whole document.</span></div>
        <div><b>Invariants</b><span>Six rules checked after every action. A red ✗ means the ledger is now wrong.</span></div>
      </div>

      <h3>Reading the sequence diagram</h3>
      <ul>
        <li>Each <strong>column</strong> is a module or the database. Hover a column name to see what it stands for in the backend.</li>
        <li>A <strong>solid arrow</strong> is a call, a <strong>dashed arrow</strong> is what comes back, a <strong>red arrow</strong> is a failure, and a <strong>box</strong> is a note about what happened inside one participant.</li>
        <li><strong>Hover a step</strong> for a plain-language explanation of what it does and why, plus the data it carries.</li>
        <li><strong>Click a step</strong> to pin it under the diagram with its full payload. This is the way to read a whole pipeline.</li>
        <li>Steps run top to bottom. When two requests are in flight together, their steps are interleaved in the order they would hit the database.</li>
      </ul>

      <h3>Presets and knobs</h3>
      <table>
        <thead><tr><th>Preset</th><th>What it is</th></tr></thead>
        <tbody>{Object.entries(PRESETS).map(([k, p]) => <tr key={k}><td><strong>{p.label}</strong></td><td>{p.blurb}</td></tr>)}</tbody>
      </table>
      <p>A preset is a set of five design decisions. “Show design knobs” lets you change one at a time and see which rule or scenario it affects.</p>
      <table>
        <thead><tr><th>Knob</th><th>Choices</th></tr></thead>
        <tbody>{Object.entries(KNOBS).map(([k, knob]) => <tr key={k}><td><strong>{knob.label}</strong></td><td>{Object.values(knob.options).join(' · ')}</td></tr>)}</tbody>
      </table>

      <h3>The rules (invariants)</h3>
      <p>The simulator keeps its own record of what each balance <em>should</em> be if every operation was applied exactly once. After every action it compares that with what the ledger stored and wrote.</p>
      <table>
        <thead><tr><th>Rule</th><th>Meaning</th><th>Turns red when</th></tr></thead>
        <tbody>
          <tr><td>Conservation</td><td>Primary + bonus equals the expected total</td><td>A callback is applied twice</td></tr>
          <tr><td>No negative balance</td><td>Nothing is below zero unless allowNegative was used</td><td>Two requests both pass a check done outside the database</td></tr>
          <tr><td>Latest row ↔ balance</td><td>The newest row of a bucket shows its real balance</td><td>A row is missing or was computed from a stale read</td></tr>
          <tr><td>Every change has a row</td><td>The rows of a bucket add up to its balance</td><td>A row insert fails after the balance changed</td></tr>
          <tr><td>Each callback applied once</td><td>No callback has two rows</td><td>A duplicate gets past the duplicate check</td></tr>
          <tr><td>No float residue</td><td>Amounts are exact decimals</td><td>Doubles produce a value like 0.7999999999999999</td></tr>
        </tbody>
      </table>

      <h3>How concurrency and faults are simulated</h3>
      <ul>
        <li><strong>Two requests at once</strong>: a balance change is split into a first half (the read, or the whole atomic update) and a second half (the write and the rows). The simulator runs both first halves, then both second halves. With the atomic update the second request already sees the first one’s result; with read-then-write both see the old balance.</li>
        <li><strong>Replay last callback</strong>: sends the last deposit, bet, win or refund again with the same identifier, as a provider retry would.</li>
        <li><strong>Fail the next transaction insert</strong>: the next row insert fails once, after its balance update has succeeded.</li>
        <li><strong>Time</strong>: each action advances the clock by one second. The +days buttons jump ahead, which expires bonuses (7 days) and transaction rows (180 days).</li>
      </ul>

      <h3>The other tabs</h3>
      <ul>
        <li><strong>Database</strong>: where each amount is stored, the schemas from the study, the live documents, and the pipeline of the last balance update.</li>
        <li><strong>Test scenarios</strong>: {SCENARIOS.length} scripted cases, each run on a fresh user against every preset. The first ten are the study’s own (§7.3). Click a result, then “Load into simulator” to open that case’s end state and inspect it.</li>
      </ul>

      <h3>What to keep in mind</h3>
      <p>The simulator was built from the study, not from the backend source. Where the study is silent it makes a choice, and those choices are listed in <code>README.md</code> and <code>SIMULATION_EXPLAINED.md</code>. The Hardened preset is a set of proposals, not something the study describes.</p>
    </div>
  );
}
