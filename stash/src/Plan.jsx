const PORTFOLIO_DOC = `// db.userportfolios — one document per user (unchanged shape + one field)
{
  userId: "u_1001",
  balances: {                       // MAIN — the only bucket the balance selector reads
    usdt: { total: 40,  bonus: 0, original: 40 },
    eth:  { total: 1.5, bonus: 1, original: 0.5 },
    ...
  },
  stashBalances: {                  // NEW — same UserPortfolioBalances sub-schema
    usdt: { total: 60, bonus: 0, original: 60 },   // invariant: bonus is always 0
    ...
  }
}`;

const TX_DOCS = `// db.transactions — appended fields (all additive, back-fill balanceType: "MAIN")
{
  _id, userId, createdAt,
  type:        "STASH_IN" | "STASH_OUT" | "ADMIN_STASH_ADD"
             | "ADMIN_STASH_CONFISCATE" | "ADMIN_STASH_RESET" | ...existing,
  currency:    "usdt",
  balanceType: "MAIN" | "STASH",       // the bucket THIS row changes
  amount:      Decimal128("-60"),      // signed, from the bucket's point of view
  transferId:  ObjectId,               // NEW — links the two legs of one transfer
  leg:         "DEBIT" | "CREDIT",     // NEW
  idempotencyKey: "client-uuid",       // NEW — unique per user, kills double-submits
  meta: { source: "user" | "autoReload" | "admin",
          adminId?, reason?, previousTotal?, trigger? }
}

// one transferToStash(60 USDT) =
{ type: "STASH_IN", balanceType: "MAIN",  amount: -60, leg: "DEBIT",  transferId: T }
{ type: "STASH_IN", balanceType: "STASH", amount: +60, leg: "CREDIT", transferId: T }

// indexes
{ userId: 1, balanceType: 1, currency: 1, createdAt: -1 }
{ transferId: 1 }
{ userId: 1, idempotencyKey: 1 }  unique, partial (idempotencyKey exists)`;

const TRANSFER_QUERY = `// Both buckets live in ONE document, so the move itself is a single atomic op.
// The session is only needed to commit the ledger rows with it.
session.withTransaction(async () => {
  const doc = await UserPortfolio.findOneAndUpdate(
    { userId, "balances.usdt.original": { $gte: 60 } },     // overdraft guard IN the filter
    { $inc: { "balances.usdt.total": -60, "balances.usdt.original": -60,
              "stashBalances.usdt.total": 60, "stashBalances.usdt.original": 60 } },
    { session, new: true });
  if (!doc) throw new InsufficientBalance();
  await Transaction.insertMany([debitLeg, creditLeg], { session });
});`;

export default function Plan() {
  return (
    <div className="panel plan">
      <h3>1 · Decision: where the Stash balance lives</h3>
      <div className="callout">
        Store Stash as a <code>stashBalances</code> sub-document on the existing <code>UserPortfolio</code>, reusing the
        <code> UserPortfolioBalances</code> sub-schema. Record every movement in <code>transactions</code> with
        <code> currency</code> + <code>balanceType</code>, as <strong>paired debit/credit legs</strong>.
      </div>
      <ul>
        <li><strong>Why the same document:</strong> Main and Stash sit in one doc, so a transfer is one <code>findOneAndUpdate</code>. It's atomic even without a session, and the overdraft guard goes in the filter. This mirrors how Bonus sits beside Original today, so the complexity is about the same as Bonus Balance.</li>
        <li><strong>Rejected: separate <code>stashportfolios</code> collection.</strong> Every transfer becomes a multi-document transaction, and the ACP needs two reads per user.</li>
        <li><strong>Deferred: balance derived from the ledger.</strong> That belongs to the double-entry / Postgres epic. The paired legs below make the later migration a replay rather than a rewrite.</li>
        <li><strong>Money type:</strong> use <code>Decimal128</code>, not JS numbers. BTC at 8dp drifts under float <code>$inc</code>.</li>
      </ul>
      <pre>{PORTFOLIO_DOC}</pre>

      <h3>2 · Data model appended to <code>transactions</code></h3>
      <pre>{TX_DOCS}</pre>
      <p><strong>Change from the spec: two legs, not one row.</strong> The spec writes a single <code>STASH_IN</code> tagged <code>STASH</code>, and a single <code>STASH_OUT</code> tagged <code>MAIN</code>. Each row then covers only one side of the move. That breaks two things (see <em>Test scenarios → recon / stats</em>):</p>
      <ul>
        <li>Summing transactions per bucket no longer equals the portfolio, so reconciliation needs special-case logic per type.</li>
        <li><code>writeStatsForTransaction</code> filters out <code>STASH</code> rows, so the Main debit of a <code>STASH_IN</code> is never counted and the Main-balance snapshot drifts upward.</li>
      </ul>
      <p>With paired legs, <code>balanceType</code> alone is enough for the exclusion filter, reconciliation is a <code>$group</code>, and the rows map directly onto double-entry postings later.</p>
      <pre>{TRANSFER_QUERY}</pre>

      <h3>3 · ACP surface</h3>
      <ul>
        <li><strong>Per-balance view:</strong> one row per currency showing Main (real / bonus), Stash, and whether a locked bonus is active. Read from the single portfolio doc.</li>
        <li><strong>Transfer controls:</strong> <code>POST /admin/stash/{'{add|confiscate|reset}'}</code>. Confiscate uses the same <code>$gte</code> filter, and reset stores <code>previousTotal</code> in meta.</li>
        <li><strong>Reason dropdown:</strong> a server-side enum, rejected if the value isn't on the list (the simulator rejects free text). Take <code>adminId</code> from the ACP session, never from the request body.</li>
        <li><strong>Automatic audit log:</strong> this is just a query, <code>type ∈ ADMIN_STASH_* ∪ STASH_*</code>. No separate audit collection, because the ledger row is the audit record.</li>
        <li>Add a new permission, <code>stash:adjust</code>. Four-eyes approval for large confiscations is deferred as a follow-up.</li>
      </ul>

      <h3>4 · Integration points</h3>
      <table>
        <thead><tr><th>Where</th><th>Call</th><th>Rule</th></tr></thead>
        <tbody>
          <tr><td>transferToStash</td><td className="mono">BonusService.checkIfBonusActive(userId, currency)</td><td><strong>Scope it by currency.</strong> The spec passes only <code>userId</code>, so an ETH bonus would block USDT stashing. The PRD says "on that balance". Transfer-in only.</td></tr>
          <tr><td>transferFromStash</td><td className="mono">check2faIfEnabled(user, token)</td><td>If 2FA is enabled, the token must be valid and single-use (store the last accepted TOTP window). If 2FA is off, allow the transfer and return <code>warning</code>. Rate-limit failed attempts.</td></tr>
          <tr><td>Auto-reload settings</td><td className="mono">check2faIfEnabled on enable / raise</td><td><strong>New requirement.</strong> Auto-reload skips 2FA later, so the consent has to be 2FA-gated when it's given.</td></tr>
          <tr><td>Auto-reload trigger</td><td className="mono">checkAndTriggerAutoReload</td><td><strong>Trigger on bets only, never on withdrawals.</strong> Otherwise a stolen session can loop withdraw → reload → withdraw and drain Stash with no 2FA (scenario <em>drain</em>).</td></tr>
          <tr><td>Balance selector / wager</td><td className="mono">mapBalanceInformation, getUserPortfolioBalances</td><td>Keep the guard clause: destructure <code>balances</code> only. Add a lint rule or test against <code>Object.values(portfolio)</code>.</td></tr>
          <tr><td>Stats / websocket</td><td className="mono">writeStatsForTransaction</td><td>Exclude <code>balanceType: STASH</code>. This is only correct with paired legs (§2).</td></tr>
        </tbody>
      </table>

      <h3>5 · Open questions from the PRD</h3>
      <table>
        <thead><tr><th>Question</th><th>Recommendation</th><th>Reason</th></tr></thead>
        <tbody>
          <tr><td>Fiat support</td><td><strong>Defer.</strong> Ship for crypto only, behind a <code>stashEnabledCurrencies</code> allow-list.</td><td>Fiat balances carry payment-provider and safeguarding obligations that need Compliance sign-off. The schema is already currency-generic, so turning fiat on later is a config change, not a migration.</td></tr>
          <tr><td>Optional 2FA on transfer-out</td><td><strong>Keep optional</strong> (enforced if enabled, otherwise a warning). Revisit once adoption data is in.</td><td>Making it mandatory would lock out every player without 2FA from their own funds on day one. The real bypass risk is auto-reload, which §4 closes regardless of this policy.</td></tr>
          <tr><td><em>New:</em> auto-reload in phase 1?</td><td><strong>Ship behind a flag in a later phase.</strong></td><td>It works against the stated purpose of isolating funds from automated systems, and it's the only path that moves Stash funds without 2FA.</td></tr>
          <tr><td><em>New:</em> auto-reload settings scope</td><td>Make settings per currency.</td><td>A single threshold can't mean the same thing for USDT and BTC.</td></tr>
        </tbody>
      </table>

      <h3>6 · What the simulation found in the spec</h3>
      <ol>
        <li>A locked-bonus check scoped to the user over-blocks other currencies, which contradicts the PRD.</li>
        <li>Single-row transfer records break per-bucket reconciliation and skew the Main stats snapshot.</li>
        <li>Auto-reload plus withdrawal lets a stolen session drain Stash without 2FA.</li>
        <li>The overdraft check must sit in the Mongo filter. A read-then-write check lets a double-submit overdraw Main (the Naive preset shows this).</li>
        <li>Unspecified: a <code>Decimal128</code> money type, idempotency keys, per-currency auto-reload settings, and single-use TOTP.</li>
      </ol>

      <h3>7 · Follow-up stories for RD-25</h3>
      <table>
        <thead><tr><th>#</th><th>Story</th><th style={{ textAlign: 'right' }}>Pts</th></tr></thead>
        <tbody>
          {[
            ['Portfolio schema: stashBalances sub-doc, default migration, Decimal128', 2],
            ['Transaction schema: balanceType, currency, stash types, transferId/leg, idempotencyKey, indexes, back-fill MAIN', 3],
            ['Bucket-aware buildIncrementBalanceQuery + guard clause in balance retrieval (+ isolation test)', 3],
            ['transferToStash: per-currency bonus check, single atomic update, paired legs', 3],
            ['transferFromStash: 2FA single-use token, warning path, rate limit', 3],
            ['Stats + websocket payload enrichment, STASH exclusion', 2],
            ['ACP: per-balance view, add/confiscate/reset endpoints, reason enum, stash:adjust permission, audit view', 5],
            ['Reconciliation job: Σ legs per bucket = portfolio, alert on drift', 3],
            ['Player UI: Stash vault, transfer modals, 2FA prompt + warning', 5],
            ['(flagged, later phase) Auto-reload: per-currency settings, 2FA on enable, bets-only trigger', 5],
          ].map(([s, p], i) => (
            <tr key={i}><td className="faint">{i + 1}</td><td>{s}</td><td className="num">{p}</td></tr>
          ))}
          <tr><td /><td><strong>Total</strong> (29 pts before auto-reload)</td><td className="num"><strong>34</strong></td></tr>
        </tbody>
      </table>
    </div>
  );
}
