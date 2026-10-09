import { EVIDENCE, LABELS, PRESETS, TX_TTL_DAYS } from './engine.js';
import { SCENARIOS, STASH_SCENARIOS, MIGRATION_SCENARIOS } from './scenarios.js';
import { Chip, Ev, STATUS_CLASS } from './ui.jsx';

const Box = ({ title, children }) => <div className="box"><b>{title}</b><span>{children}</span></div>;
const Arrow = () => <div className="arrow">→</div>;

const LABEL_MEANING = {
  Code: 'Read in the backend source at the studied commit.',
  Meeting: 'Said by the team in a walkthrough. Not checked in the source.',
  Study: 'Stated in LEDGER_STUDY.md.',
  Inferred: 'Follows from other facts. Nobody stated it.',
  Open: 'Not known. The simulator has a knob for it.',
  Assumed: 'A choice the simulator had to make to run. It may be wrong.',
  Proposed: 'Does not exist in the backend. It is a suggested change.',
};
const STATUS_MEANING = [
  ['PASS', 'The result is correct, and the documents say it should be.'],
  ['DEBT', 'A documented error reproduces under the Current ledger (or Current + Stash).'],
  ['OPEN', 'The result depends on an Open knob. The scenario runs once per option and each option gives its documented result.'],
  ['N/F', 'The error still reproduces under Hardened. It cannot be fixed without something that is blocked.'],
  ['fail', 'Pseudocode fails. That is the point of the preset.'],
  ['MISMATCH', 'The result differs from what the documents imply. This is a bug in the simulator, and npm test fails.'],
  ['RISK', 'Migration cases only: the documented migration risk reproduces.'],
];

export default function Guide() {
  return (
    <div className="panel guide">
      <h3>What this is</h3>
      <p>A model of the balance ledger as it works today. It runs in the browser. There is no server and no database: the stores are plain objects, changed by the same steps the backend uses.</p>
      <p>It answers two questions. What does the ledger do when X happens? What goes wrong, and what would fix it?</p>

      <h3>The two stores and the routing</h3>
      <p>A balance type lives in one of two stores. <Ev id="L-01" /></p>
      <table>
        <thead><tr><th>Store</th><th>Holds</th><th>Updated with</th></tr></thead>
        <tbody>
          <tr><td><strong>RethinkDB</strong> <code>users</code> row</td><td>crypto (BTC), eth, ltc, cash. Plain fields such as <code>balance</code> and <code>cashBonusBalance</code>.</td><td>ReQL, through the userObject service.</td></tr>
          <tr><td><strong>Mongo</strong> <code>user_altcoin_portfolios</code></td><td>usdt, sol and six more. One document per user, created on first use.</td><td>An update pipeline, through the portfolio service.</td></tr>
          <tr><td><strong>Mongo</strong> <code>transactions</code></td><td>One row per bucket changed, for every balance type in both stores.</td><td>A separate insert, after the balance update.</td></tr>
        </tbody>
      </table>
      <div className="flow">
        <Box title="1. Caller">Bet, Payments, Bonus, Sportsbook, ACP or a job calls the ledger.</Box>
        <Arrow />
        <Box title="2. lib/index.ts">The entry point. It routes by <code>balanceType</code> to one of two services.</Box>
        <Arrow />
        <Box title="3. One atomic update">The guard and the primary/bonus split run inside one update on one document or row.</Box>
        <Arrow />
        <Box title="4. Row insert">A second write to <code>transactions</code>. Listeners run on each insert.</Box>
      </div>
      <p>Each balance type has a primary amount and a bonus amount. A deduction takes primary first, then bonus. If both together are not enough, nothing changes and the caller gets <code>bet__not_enough_balance</code>. Withdrawals and tips use primary only. The sportsbook passes <code>allowNegative</code>, which skips the guard.</p>
      <p>A call with no <code>balanceType</code> is not rejected. It falls back to the user’s selected balance, and an empty identifier resolves to BTC. <Ev id="L-80" /></p>

      <h3>The Mongo pipeline and the stored scratch fields</h3>
      <p>Mongo returns only the document after an update. The ledger needs the before values to know how much came from each bucket. So the first pipeline stage copies them into the document itself:</p>
      <ol>
        <li>Stage 1 writes <code>originalBalance</code> and <code>originalBonusBalance</code> from the current amounts.</li>
        <li>The next stage computes the split from those values. On a shortfall it writes the old values back, which is a no-op.</li>
        <li>After the update, <code>computeDebitAmountChanges</code> subtracts <code>original*</code> from the returned amounts. Zero change on a non-zero request means refused.</li>
      </ol>
      <p>The scratch fields are in the schema. They stay on every portfolio document and go stale. The Balances panel shows them dimmed. <Ev id="L-25" /></p>
      <p>The simulator builds real pipeline stages and runs them with a small evaluator. The Database tab shows the filter and pipeline of the last update. The stage layout is reconstructed, not copied. <Ev id="A-layout" /></p>

      <h3>The ReQL path</h3>
      <p>The legacy types use one ReQL update: <code>r.branch(guard, change, {'{}'})</code> with <code>returnChanges: true</code>. RethinkDB returns both images of the row, so it needs no scratch fields. An empty change list means refused.</p>
      <p>The split logic is written twice, once per store. The two differ slightly, not on purpose, and the exact difference is open. The simulator assumes they match. The knob “ReQL split vs Mongo” switches to one hypothesis so the difference can be seen. <Ev id="L-28" /></p>
      <p>The RethinkDB path is not in the integration test harness. <Ev id="L-97" /></p>

      <h3>The separate row write, and what happens when it fails</h3>
      <p>The balance update and the row insert are two writes. No session ties them together. <Ev id="L-51" /></p>
      <ul>
        <li>If the insert fails, the error is logged and swallowed. The caller gets <code>transactionId: undefined</code>. The balance stays changed. <Ev id="L-52" /></li>
        <li>No metric, alert or reconciliation job exists. <Ev id="L-53" /></li>
        <li>The listeners hang off the insert, so the socket event, stats and FastTrack publish are skipped too. <Chip label="Inferred" /></li>
        <li>Rows expire after {TX_TTL_DAYS} days, so balances cannot be rebuilt from rows.</li>
      </ul>
      <p>Use “Fail next insert” in Faults &amp; timing, run a bet, and watch the invariant “Latest row matches balance” turn red.</p>

      <h3>Duplicate protection sits outside the ledger</h3>
      <p>The ledger has no idempotency key. Each caller looks for a row it wrote before, then calls the ledger. <Ev id="L-55" /></p>
      <ul>
        <li>If the row insert failed, the retry finds no row and the change is applied twice.</li>
        <li>If two deliveries arrive together, both look before either has written.</li>
        <li>If the check reads a lagging secondary, the row may not be visible yet. Which node it reads is open.</li>
        <li>After {TX_TTL_DAYS} days the row is gone.</li>
      </ul>
      <p>Refunds have the same weakness: they rebuild the primary/bonus split from the bet’s rows.</p>

      <h3>The four presets</h3>
      <table>
        <thead><tr><th>Preset</th><th>What it is</th><th>Status</th></tr></thead>
        <tbody>
          {Object.entries(PRESETS).map(([k, p]) => (
            <tr key={k}><td><strong>{p.label}</strong><div className="mono faint">?preset={k}</div></td><td>{p.blurb}</td><td>{k === 'hardened' || k === 'stash' ? <Chip label="Proposed" /> : k === 'current' ? <span className="tag muted">as documented</span> : <span className="tag muted">teaching aid</span>}</td></tr>
          ))}
        </tbody>
      </table>
      <p><strong>Hardened and Current + Stash are proposals.</strong> Nothing in them exists in the backend. Hardened uses only changes that fit the real constraints: no unique index, no sessions, no new fields on <code>transactions</code>. Stash adds a dedicated transfer path and leaves the existing paths alone.</p>
      <p>“Show design knobs” lists every decision behind a preset. Change one and see which invariant or scenario moves.</p>

      <h3>What the labels mean</h3>
      <p>Every behaviour carries one label. It says how the simulator knows it.</p>
      <table>
        <thead><tr><th>Label</th><th>Meaning</th><th>Entries in the evidence register</th></tr></thead>
        <tbody>
          {LABELS.map((l) => (
            <tr key={l}><td><Chip label={l} /></td><td>{LABEL_MEANING[l]}</td><td className="mono faint">{Object.values(EVIDENCE).filter((e) => e.label === l).length}</td></tr>
          ))}
        </tbody>
      </table>
      <p>Labels appear on knobs, sequence steps, invariants, schema fields and transaction type names. The Evidence panel lists the entries the current state rests on.</p>

      <h3>Reading the sequence diagram</h3>
      <ul>
        <li>Only the participants of the last operation are shown. Hover a column name for what it is in the backend.</li>
        <li>A solid arrow is a call. A dashed arrow is a return. A red arrow is a failure. A box is a note inside one participant.</li>
        <li>Hover a step for why it happens and the evidence behind it. Click it to pin its full payload.</li>
        <li>When two requests are in flight together, their steps are interleaved in the order they reach the database.</li>
      </ul>

      <h3>The matrix statuses</h3>
      <p>The Test scenarios tab runs {SCENARIOS.length} scenarios under each preset, once per balance type (cash for RethinkDB, usdt for Mongo). Each scenario stores the result the documents imply before it runs.</p>
      <table>
        <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
        <tbody>
          {STATUS_MEANING.map(([s, text]) => <tr key={s}><td><span className={`pill ${STATUS_CLASS[s]}`}>{s}</span></td><td>{text}</td></tr>)}
        </tbody>
      </table>
      <p>Below the matrix are {STASH_SCENARIOS.length} Stash scenarios and {MIGRATION_SCENARIOS.length} migration cases. Click any result for its notes. “Load into simulator” opens that cell’s end state.</p>

      <h3>The other tabs</h3>
      <ul>
        <li><strong>Database</strong>: both stores’ schemas, the stored documents, the frozen <code>transactions</code> collection, the type names, and the last update.</li>
        <li><strong>Migration</strong>: a separate small model of moving one legacy type from RethinkDB to Mongo. The plan is in progress. The safeguards are proposals.</li>
      </ul>

      <h3>What to keep in mind</h3>
      <ul>
        <li>Invariants marked simulator-only compare with a ground truth that production does not have.</li>
        <li>Each action advances the clock by one second. “Next action arrives after N ms” changes that once.</li>
        <li>Transaction type names marked Assumed are not confirmed. They live in one table, <code>TX_TYPES</code>.</li>
        <li>The bonus rules (5× within 7 days) are placeholders.</li>
      </ul>
    </div>
  );
}
