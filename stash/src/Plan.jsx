const STORAGE = `// Mongo mongo0.user_altcoin_portfolios — 8 balance types (usdt, usdc, xrp, doge, trx, sol, bnb, sui)
balances: {
  usdt: {
    balance: 40,              // primary — the only amount that is wagered or withdrawn
    bonusBalance: 0,
    stashBalance: 60,         // NEW
    currency: "usd",          // every amount is USD, stored as a float Number
    originalBalance, originalBonusBalance,
    originalStashBalance      // NEW scratch field, same role as the two above
  }
}

// RethinkDB users row — the other 4 balance types (crypto = BTC, eth, ltc, cash)
balance, ethBalance, ltcBalance, cashBalance                           // existing
btcBonusBalance, ethBonusBalance, ltcBonusBalance, cashBonusBalance    // existing
btcStashBalance, ethStashBalance, ltcStashBalance, cashStashBalance    // NEW`;

const TRANSFER_QUERY = `// Portfolio types: one findOneAndUpdate, pipeline update, guard inside the update.
// No Mongo session: nothing in the backend uses one at runtime.
UserPortfolioModel.findOneAndUpdate({ userId }, [
  { $set: {
      "balances.usdt.originalBalance":      { $ifNull: ["$balances.usdt.balance", 0] },
      "balances.usdt.originalStashBalance": { $ifNull: ["$balances.usdt.stashBalance", 0] } } },
  { $set: { "balances.usdt.canMove": { $gte: ["$balances.usdt.originalBalance", amount] } } },
  { $set: {
      "balances.usdt.balance": { $cond: ["$balances.usdt.canMove",
          { $subtract: ["$balances.usdt.originalBalance", amount] }, "$balances.usdt.originalBalance"] },
      "balances.usdt.stashBalance": { $cond: ["$balances.usdt.canMove",
          { $add: ["$balances.usdt.originalStashBalance", amount] }, "$balances.usdt.originalStashBalance"] } } },
  { $unset: "balances.usdt.canMove" }
], { new: true })
// The app compares original* with the new values to detect a no-op (existing ledger pattern).

// User-object types: one RethinkDB .update() with
// r.branch(doc(field).ge(amount), { both fields }, {}) and returnChanges.`;

const TX_DOCS = `// mongo0.transactions — no new top-level fields, no new indexes (the collection is index-frozen)
{ userId, type, amount, currentBalance, balanceType, meta, createdAt }

// NEW type values:        "stashIn" | "stashOut"
// NEW balanceType values: "<BalanceType>Stash", e.g. "usdtStash" (copies "usdtBonus")

// one transfer of 60 into Stash on usdt = two rows
{ type: "stashIn", balanceType: "usdtStash", amount: +60, currentBalance: <stash after>,
  meta: { transferId, source: "user" } }
{ type: "stashIn", balanceType: "usdt",      amount: -60, currentBalance: <primary after>,
  meta: { transferId, source: "user" } }

meta: { transferId: "<uuid>",                    // links the two rows; not indexed
        source: "user" | "admin" | "reload",
        requestId?,                              // only if the retry check is added
        adminId?, reason? }                      // admin transfers only`;

const STORIES = [
  ['Ledger readers: <BalanceType>Stash in the balance-type validator; stashIn / stashOut in the four compile-time places, no-op stats. Deployed one release ahead of any writer', 2],
  ['Storage and atomic move: stashBalance in the portfolio schema, four user-row fields, guarded transfer in both DALs, two rows, alert on failed row write, Mongo integration test', 5],
  ['Read model: <type>Stash keys in UserBalances behind the flag, GraphQL fields, Connect API filter, account-cleanup filter, test that wagering excludes Stash', 3],
  ['Player transfer in: mutation, flag and allow-list, mutex, match-promo and bonus guards, error keys and locales', 3],
  ['Player transfer out: mutation, check2faIfEnabled, wrong-code limiter', 3],
  ['Side effects: FastTrack handling of Stash rows; transactionCreated and history labels agreed with the web client', 2],
  ['ACP backend: admin transfer mutations, RBAC actions, reason enum, audits record, user note, Slack log, audit query', 5],
  ['Data: BigQuery liability views and warehouse, with Data Engineering', 2],
  ['Player UI: Stash view, transfer dialogs, 2FA prompt and warning (client repo, not examined)', 5],
  ['ACP UI: Stash column, transfer controls, reason dropdown, audit view (client repo, not examined)', 3],
  ['Manual reload: settings per balance type, client prompt', 3],
  ['(later, flagged) Auto-reload in the bet path', 8],
];

export default function Plan() {
  return (
    <div className="panel plan">
      <div className="callout">
        <strong>Draft 2.</strong> Rewritten against <code>STASH_CODEBASE_FINDINGS.md</code>, a read-only investigation of the
        backend. The full text, with a reference to the findings for every claim, is in <code>TECHNICAL_PLAN.md</code>.
        The Simulator and Test scenarios tabs run this design; section 9 says how they map to it.
      </div>

      <h3>1 · What the codebase changed</h3>
      <table>
        <thead><tr><th>Draft 1 assumed</th><th>The code says</th></tr></thead>
        <tbody>
          <tr><td>One portfolio document holds all balances</td><td>Two stores: the Mongo portfolio holds 8 balance types; the RethinkDB user row holds BTC, ETH, LTC and cash</td></tr>
          <tr><td>Per-currency amounts, <code>Decimal128</code></td><td>Every balance is a USD amount stored as a float <code>Number</code>; the ledger does no rounding</td></tr>
          <tr><td>New indexes on <code>transactions</code>, including a unique idempotency key</td><td>The collection is index-frozen; the migration job throws on any index change</td></tr>
          <tr><td>The ledger row is the permanent audit record</td><td>Rows expire after 180 days</td></tr>
          <tr><td>Balance and rows commit in one Mongo session</td><td>No runtime code uses a session; rows are written after the balance and a failed write is swallowed</td></tr>
          <tr><td>A new bucket field and a back-fill</td><td><code>balanceType</code> is already the bucket (<code>usdt</code>, <code>usdtBonus</code>); nothing to back-fill</td></tr>
          <tr><td>The bonus check is user-wide and must be narrowed</td><td>It is already <code>checkIfBonusActive(user, balanceType)</code></td></tr>
          <tr><td>2FA codes can be replayed</td><td>Codes are already single-use for 120 s. Missing: any limit on wrong codes</td></tr>
        </tbody>
      </table>
      <p><strong>New risk: totals.</strong> Cashback and lossback P&amp;L is <code>deposits − withdrawals − totalBalance</code>, and <code>totalBalance</code> sums the keys of <code>UserBalances</code>. If Stash is not a key of that object, stashed funds count as losses.</p>

      <h3>2 · Decision: where the Stash balance lives</h3>
      <div className="callout">
        One new amount beside each existing balance, in whichever store holds that balance. This is exactly how the bonus
        balance is stored today. Stash is <strong>not</strong> a new <code>BalanceType</code>.
      </div>
      <pre>{STORAGE}</pre>
      <ul>
        <li><strong>Why beside the balance:</strong> both amounts of a transfer sit in one document in both stores, so the move is one atomic update, as the existing bonus-to-primary move is.</li>
        <li><strong>Why not a <code>BalanceType</code>:</strong> selector lists, GraphQL enums and Mongoose validators are generated from <code>BalanceTypes</code>. A new entry would make Stash selectable and wagerable.</li>
        <li><strong>No data migration:</strong> a missing field reads as 0, and the portfolio document is already created lazily.</li>
        <li><strong>Cost:</strong> four more fields on a RethinkDB type headed "Do not add fields to this type". The bonus feature did the same. The lead needs to accept this, or pick an alternative.</li>
        <li><strong>Alternatives:</strong> launch with the 8 portfolio types only; or keep all Stash in Mongo and accept a non-atomic, compensated transfer for the four legacy types.</li>
      </ul>

      <h3>3 · How a transfer runs</h3>
      <pre>{TRANSFER_QUERY}</pre>
      <ul>
        <li><strong>Transfer in:</strong> flag and allow-list → explicit <code>balanceType</code> → amount check → per-user mutex → match-promo and bonus guards → guarded update → two rows.</li>
        <li><strong>Transfer out:</strong> the same, with <code>check2faIfEnabled</code> in place of the bonus guards. It runs after the cheap checks, because a verified code is consumed for 120 s.</li>
        <li><strong>Rows are not atomic with the balance.</strong> This is how the whole ledger works. The plan keeps it and adds an alert, rather than introducing sessions for one feature.</li>
        <li><strong>Duplicate requests:</strong> a per-user Redis mutex, as on withdrawals. It stops a double-click, not a late retry. That is acceptable for a move between a player's own two amounts. A <code>requestId</code> lookup on the existing index is available if retries become a problem.</li>
      </ul>

      <h3>4 · Data model appended to <code>transactions</code></h3>
      <pre>{TX_DOCS}</pre>
      <ul>
        <li><strong>Two rows per transfer</strong> is the existing convention: <code>currentBalance</code> and <code>balanceType</code> describe one bucket, so one row cannot cover both sides.</li>
        <li><strong>Deploy order:</strong> a schema hook throws when a stored <code>balanceType</code> is unknown. The validator must accept <code>&lt;BalanceType&gt;Stash</code> before the first row is written, or the admin transactions table and CSV export break for that user.</li>
        <li><strong>A new type costs four compile-time places</strong> (<code>TransactionType</code>, <code>TransactionMeta</code>, <code>TransactionContext</code>, the stats map) plus the web client's history label map.</li>
      </ul>

      <h3>5 · Reading balances and integration points</h3>
      <table>
        <thead><tr><th>Where</th><th>Call</th><th>Rule</th></tr></thead>
        <tbody>
          <tr><td>Selector, wagering</td><td className="mono">getBalanceFromUserAndType</td><td>Nothing to change. Bets and provider wallets read <code>balance + bonusBalance</code> of one balance type by name. Add a test that pins it.</td></tr>
          <tr><td>Balance payload, totals</td><td className="mono">mapBalanceInformation</td><td>Add <code>&lt;type&gt;Stash</code> keys to <code>UserBalances</code> behind the flag, so that P&amp;L, reports and the ACP lookup count Stash. Filter them out of the public Connect API.</td></tr>
          <tr><td>Transfer in</td><td className="mono">checkIfBonusActive(user, balanceType)</td><td>Already scoped to the balance type. Not a pure read (it can expire the bonus), and it fails open on a cache error, as it does for tips.</td></tr>
          <tr><td>Transfer out</td><td className="mono">check2faIfEnabled(user, token)</td><td>Call it inline, not through the REST middleware. Add a per-user limit on wrong codes: none exists today on any route.</td></tr>
          <tr><td>Every row</td><td className="mono">createTransaction</td><td>Emits <code>transactionCreated</code>, writes stats (no-op for the new types) and publishes the row's balance to FastTrack as <code>real_money</code>. Skip the FastTrack publish for Stash rows.</td></tr>
          <tr><td>Account cleanup</td><td className="mono">cleanupOldUsers</td><td>Checks BTC, ETH and LTC primary balances only. Add the Stash fields.</td></tr>
          <tr><td>Liability reporting</td><td className="mono">BigQuery views</td><td>Fixed column lists, defined outside the backend. Stash would drop out of player liabilities. Raise with Data Engineering.</td></tr>
        </tbody>
      </table>

      <h3>6 · ACP</h3>
      <ul>
        <li><strong>Per-balance view:</strong> the admin user lookup already returns <code>UserBalances</code>, so the new keys appear there.</li>
        <li><strong>Transfer controls:</strong> admin GraphQL mutations <code>stashTransferIn</code> / <code>stashTransferOut</code>. Same move and rows as a player transfer, with <code>meta.source: "admin"</code>. Transfer in honours the bonus block; transfer out skips the player's 2FA.</li>
        <li><strong>Permissions:</strong> a new action under the existing <code>balances</code> resource. Roles holding <code>balances:*</code> get it automatically.</li>
        <li><strong>Reason dropdown:</strong> no balance action has a server-side reason list today; reasons are free text. For Stash, define the list as a GraphQL enum.</li>
        <li><strong>Automatic audit log:</strong> wrap each admin transfer in <code>createAuditRecord</code> (the existing <code>audits</code> collection). The transaction row alone expires after 180 days.</li>
        <li><strong>Not in phase 1:</strong> add, confiscate or reset directly on Stash. An admin can transfer out and use the existing controls.</li>
      </ul>

      <h3>7 · Open questions and decisions needed</h3>
      <table>
        <thead><tr><th>Question</th><th>Recommendation</th><th>Reason</th></tr></thead>
        <tbody>
          <tr><td>Fiat support</td><td><strong>Defer.</strong> "Fiat" here is the <code>cash</code> balance type.</td><td>Technically it is the same as BTC, ETH and LTC, so enabling it later is one allow-list entry. Cash withdrawals have no 2FA step and carry KYC level 2 rules; Compliance should confirm first.</td></tr>
          <tr><td>Optional 2FA on transfer out</td><td><strong>Keep optional</strong> (required when the player has 2FA).</td><td>Crypto withdrawals work this way today and they leave the platform. A stricter rule for a move to the primary balance would be inconsistent.</td></tr>
          <tr><td>Auto-reload in phase 1</td><td><strong>No.</strong> Manual reload first.</td><td>Auto-reload belongs in the bet path, which is where the bonus balance cost most. Manual reload needs only stored settings and a client prompt.</td></tr>
          <tr><td><em>Q1</em> Storage for BTC, ETH, LTC, cash</td><td>Four fields on the user row.</td><td>Keeps the move atomic. Alternatives in section 2.</td></tr>
          <tr><td><em>Q2</em> Connect API shows Stash?</td><td>No.</td><td>It publishes every numeric balance key under its raw name.</td></tr>
          <tr><td><em>Q3</em> Match-promo guard on transfer in?</td><td>Yes.</td><td>Tips, raffles and withdrawals apply it just before the bonus check.</td></tr>
          <tr><td><em>Q4</em> Direct admin add / confiscate / reset on Stash?</td><td>Not in phase 1.</td><td>The ticket lists transfer controls only. "Reset all balances" does not reach bonus balances today either.</td></tr>
          <tr><td><em>Q5</em> Audit retention</td><td><code>audits</code> record plus 180-day rows.</td><td>For the lead and PM to confirm.</td></tr>
          <tr><td><em>Q6</em> CRM <code>real_money</code></td><td>Primary only.</td><td>For the CRM owner.</td></tr>
          <tr><td><em>Q7</em> Owner of the wrong-code limit</td><td>Auth, for all TOTP routes.</td><td>Minimum: a limiter on the Stash mutation.</td></tr>
        </tbody>
      </table>

      <h3>8 · Complexity compared with Bonus Balance</h3>
      <ul>
        <li><strong>Bonus Balance:</strong> 112 to 129 commits over 14 months, 355 files, five reverts. Most of it was the bet path: stake split, winnings split and about 49 game-provider files.</li>
        <li><strong>Stash reuses the cheap part:</strong> a sibling amount in both stores, a <code>balanceType</code> suffix, extra balance keys, a flag, RBAC, admin mutations, locales.</li>
        <li><strong>Stash avoids the expensive part:</strong> nothing in the bet path, and no lifecycle (status, expiry, wager progress, cache).</li>
        <li><strong>New:</strong> a player-initiated move of an arbitrary amount, a 2FA step on a balance operation, a server-side reason list and an audit record.</li>
      </ul>

      <h3>9 · How the simulator maps to this plan</h3>
      <ul>
        <li><strong>Recommended</strong> is this plan. <strong>Spec as written</strong> is the Sept 2026 write-up taken literally and run against how the backend really works. <strong>Naive</strong> removes the safeguards.</li>
        <li>The model has two stores (USDT and SOL in the Mongo portfolio, BTC and cash on the RethinkDB user row), USD amounts, single-document guarded updates, rows written after the balance, a 180-day TTL on rows, and the per-row socket event and FastTrack message.</li>
        <li>Recommended passes 24 of 25 scenarios. The one it fails, a late retry of a finished request, is the accepted gap from section 3 and is shown as GAP.</li>
        <li>Not modelled: the feature flag, the match-promo guard, the user note and Slack log, the BigQuery liability views, and the client.</li>
      </ul>

      <h3>10 · Follow-up stories for RD-25</h3>
      <table>
        <thead><tr><th>#</th><th>Story</th><th style={{ textAlign: 'right' }}>Pts</th></tr></thead>
        <tbody>
          {STORIES.map(([s, p], i) => (
            <tr key={i}><td className="faint">{i + 1}</td><td>{s}</td><td className="num">{p}</td></tr>
          ))}
          <tr><td /><td><strong>Phase 1, stories 1–10</strong> (36 with manual reload; estimates unvalidated)</td><td className="num"><strong>33</strong></td></tr>
        </tbody>
      </table>
    </div>
  );
}
