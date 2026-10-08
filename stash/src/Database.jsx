import { BALANCE_TYPES, PRESETS, pathOf, storedDocuments } from './engine.js';

/* The schemas below are the Recommended design (TECHNICAL_PLAN.md, sections 3, 5 and 9).
 * The live documents come from the simulator state, under whichever preset is active. */

const PORTFOLIO = `// one document per user, created lazily on the first balance change
{
  userId: String,                       // unique
  balances: {
    <usdt|usdc|xrp|doge|trx|sol|bnb|sui>: {
      balance:              Number,     // primary, USD
      bonusBalance:         Number,
      stashBalance:         Number,     // NEW
      currency:             "usd",
      originalBalance:      Number,     // scratch, written by each deduction
      originalBonusBalance: Number,
      originalStashBalance: Number      // NEW scratch
    }
  }
}`;

const USERS = `// the legacy user row; holds BTC ("crypto"), ETH, LTC and cash
{
  id, name, twofactorEnabled, selectedBalanceField, ...
  balance, ethBalance, ltcBalance, cashBalance,                            // primary
  btcBonusBalance, ethBonusBalance, ltcBonusBalance, cashBonusBalance,
  btcStashBalance, ethStashBalance, ltcStashBalance, cashStashBalance      // NEW
}`;

const TRANSACTIONS = `// no new fields, no new indexes (the collection is index-frozen)
{
  userId:         String,
  type:           String,   // NEW values: "stashIn" | "stashOut"
  amount:         Number,   // signed
  currentBalance: Number,   // balance of the one bucket this row touched
  balanceType:    String,   // NEW values: "<BalanceType>Stash", e.g. "usdtStash"
  meta: {                   // for the two new types:
    transferId,             //   links the two rows of one transfer
    source,                 //   "user" | "admin" | "reload"
    requestId?,             //   only if the retry check is added
    adminId?, reason?       //   admin transfers
  },
  createdAt:      Date      // TTL 180 days
}
// indexes, unchanged: { createdAt } TTL · { userId, createdAt } · { userId, type, createdAt }`;

const AUDITS = `// existing collection; written through createAuditRecord
{
  editorId:       String,   // the admin, from the session
  subjectId:      String,   // the player
  actionType:     String,   // NEW value: "stashTransfer"
  databaseAction: "edit",
  success:        Boolean,  // written in finally, so failures are recorded too
  reason:         String,   // from the server-side list
  meta: { direction, balanceType, amount },   // NEW shape for this action
  createdAt, updatedAt      // no TTL
}`;

const SETTINGS = `// per-user settings; the exact shape this schema allows was not checked
{
  userId: String,
  stashReload: {            // NEW, keyed by balance type, amounts in USD
    <balanceType>: { mode: "off" | "manual" | "auto", threshold: Number, target: Number }
  }
}`;

const REDIS = `namedLock:<user>:stash:transfer     NEW   SET NX PX ~5000   one transfer at a time per user
totp-used:<hmac(user, code)>        existing   SET NX EX 120  a 2FA code is single-use
2fa-attempts:<user>                 NEW   15 points / 5 min   limit on wrong codes`;

const CHANGES = [
  ['Mongo mongo0', 'user_altcoin_portfolios', 'One field per balance type: stashBalance (plus a scratch field)', 'None: a missing field reads as 0'],
  ['RethinkDB', 'users', 'Four fields: btc / eth / ltc / cash StashBalance', 'None: .default(0)'],
  ['Mongo mongo0', 'transactions', 'New values only: two types, a <type>Stash balanceType suffix, a meta shape', 'None. The read hook must accept the new suffix before the first row is written'],
  ['Mongo mongo1', 'audits', 'New actionType value: stashTransfer', 'None'],
  ['Mongo mongo1', 'user_system_settings', 'Reload settings per balance type (manual reload story)', 'None'],
  ['Redis', 'keys', 'A transfer mutex and a wrong-code counter', 'None'],
];

// Lines that mention Stash are the additions; colour them so they stand out in both schema and live data.
function Code({ text }) {
  return (
    <pre>
      {text.split('\n').map((line, i) => (
        <div key={i} className={/stash/i.test(line) || /NEW/.test(line) ? 'hl' : ''}>{line || ' '}</div>
      ))}
    </pre>
  );
}

function Store({ db, name, note, schema, live, liveLabel = 'Live document' }) {
  return (
    <div className="panel">
      <h2><span className={`tag ${db === 'RethinkDB' ? 'lock' : db === 'Redis' ? 'muted' : 'main'}`}>{db}</span> <span style={{ textTransform: 'none', letterSpacing: 0 }} className="mono">{name}</span></h2>
      {note && <p className="sub" style={{ marginBottom: 8 }}>{note}</p>}
      <div className="sub" style={{ marginBottom: 4 }}>Schema (Recommended)</div>
      <Code text={schema} />
      {live !== undefined && (
        <>
          <div className="sub" style={{ margin: '10px 0 4px' }}>{liveLabel}</div>
          <Code text={typeof live === 'string' ? live : JSON.stringify(live, null, 2)} />
        </>
      )}
    </div>
  );
}

export default function Database({ state, preset }) {
  const docs = storedDocuments(state);
  const recommended = state.config.storage === 'sibling' && state.config.rowModel === 'paired';
  return (
    <div className="db">
      <div className="panel">
        <h2>Database design <span className="right sub">schemas are the Recommended design · live documents follow the active preset ({PRESETS[preset]?.label})</span></h2>
        {!recommended && (
          <div className="toast warn" style={{ marginTop: 0, marginBottom: 10 }}>
            The live documents below come from a preset that is not the Recommended design, so they differ from the schemas (for example <code>stashBalances</code> in the portfolio, or rows tagged <code>STASH</code>). Switch to Recommended on the Simulator tab to see the design as planned.
          </div>
        )}
        <table>
          <thead><tr><th>Store</th><th>Collection / table</th><th>What changes</th><th>Migration</th></tr></thead>
          <tbody>
            {CHANGES.map(([db, name, change, migration]) => (
              <tr key={name}><td>{db}</td><td className="mono">{name}</td><td>{change}</td><td className="sub">{migration}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="sub" style={{ marginTop: 10 }}>No new collection, no new index, no back-fill. Every amount is a USD float, like the existing balances.</p>
      </div>

      <div className="panel">
        <h2>Where each amount lives <span className="right sub">live, from the active preset</span></h2>
        <table>
          <thead><tr><th>Balance type</th><th>Primary</th><th>Bonus</th><th>Stash</th><th>Transfer is</th></tr></thead>
          <tbody>
            {BALANCE_TYPES.map(({ code, label }) => {
              const [p, b, st] = ['primary', 'bonus', 'stash'].map((bucket) => pathOf(state, code, bucket));
              const oneDoc = p.db === st.db;
              return (
                <tr key={code}>
                  <td className="cur">{label} <span className="faint mono">{code}</span></td>
                  <td className="mono">{p.db} · {p.path}</td>
                  <td className="mono">{b.db} · {b.path}</td>
                  <td className="mono" style={{ color: 'var(--stash)' }}>{st.db} · {st.path}</td>
                  <td>{oneDoc ? <span className="tag ok">one document</span> : <span className="tag err">two databases</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="sub" style={{ marginTop: 10 }}>The real backend has 12 balance types: 8 in the Mongo portfolio and 4 on the RethinkDB user row. The simulator carries two of each.</p>
      </div>

      <div className="dbgrid">
        <Store db="Mongo mongo0" name="user_altcoin_portfolios" note="Holds 8 of the 12 balance types. Stash sits beside the balance it belongs to, as the bonus balance does." schema={PORTFOLIO} live={docs.portfolio} />
        <Store db="RethinkDB" name="users" note='Holds BTC, ETH, LTC and cash. The type is headed "Do not add fields"; the bonus feature added four, Stash adds four more (decision Q1).' schema={USERS} live={docs.user} liveLabel="Live row (balance fields)" />
        <Store db="Mongo mongo0" name="transactions" note="One transfer writes two rows: the Stash row first, then the primary row." schema={TRANSACTIONS} live={docs.transactions.length ? docs.transactions : '(no rows)'} liveLabel={`Newest rows (${state.transactions.length} in total)`} />
        <Store db="Mongo mongo1" name="audits" note="The durable record of an admin transfer. The transaction rows expire after 180 days." schema={AUDITS} live={docs.audits.length ? docs.audits : '(no records — run an ACP transfer under Recommended)'} liveLabel={`Newest records (${state.audits.length} in total)`} />
        <Store db="Mongo mongo1" name="user_system_settings" note="Only needed for reload, which is after phase 1." schema={SETTINGS} live={docs.settings} />
        <Store db="Redis" name="keys" note="Nothing durable. Used for the duplicate-request mutex and for 2FA." schema={REDIS} live={docs.redis} liveLabel="Live state" />
      </div>
    </div>
  );
}
