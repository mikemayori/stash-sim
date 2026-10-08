import { BALANCE_TYPES, pathsOf, storedDocuments } from './engine.js';

// Section 2 of LEDGER_STUDY.md.
const PORTFOLIO_FIELDS = [
  ['userId', 'String', 'Unique user identifier (indexed).'],
  ['balances', 'Map<string, Balance>', 'Currency code → balance object.'],
  ['balances.K.balance', 'Number', 'Primary (withdrawable) balance.'],
  ['balances.K.bonusBalance', 'Number', 'Restricted bonus balance.'],
  ['balances.K.currency', 'String', 'Currency code, usually usd.'],
  ['balances.K.originalBalance', 'Number', 'Primary balance before the last update, written by the pipeline.'],
  ['balances.K.originalBonusBalance', 'Number', 'Bonus balance before the last update, written by the pipeline.'],
  ['pendingEntries', 'Array', 'Hardened only: changes whose transaction rows are not written yet.', true],
  ['appliedKeys', 'Array', 'Hardened only: idempotency keys already applied to this document.', true],
];
const TRANSACTION_FIELDS = [
  ['userId', 'String', 'User the transaction belongs to.'],
  ['type', 'String', 'bet, payout, refund, deposit, withdrawal, chargeback, bonus, bonusCompleted, bonusExpired, adminSetBalance.'],
  ['amount', 'Number', 'Delta: positive for a credit, negative for a debit.'],
  ['currentBalance', 'Number', 'Balance of that bucket after this entry.'],
  ['balanceType', 'String', 'The bucket: usdt, usdtBonus, btc, …'],
  ['meta', 'Mixed', 'betId, externalIdentifier, provider, bonusId, adminId.'],
  ['createdAt', 'Date', 'TTL index: 180 days.'],
];

function Schema({ fields }) {
  return (
    <table>
      <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
      <tbody>
        {fields.map(([name, type, text, added]) => (
          <tr key={name}>
            <td className="mono" style={added ? { color: 'var(--bonus)' } : undefined}>{name}</td>
            <td className="mono faint">{type}</td>
            <td className="sub">{text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const Doc = ({ value }) => <pre>{JSON.stringify(value, null, 2)}</pre>;

export default function Database({ state }) {
  const docs = storedDocuments(state);
  const last = state.lastPipeline;
  return (
    <div className="db">
      <div className="panel">
        <h2>Where each amount lives</h2>
        <table>
          <thead><tr><th>Balance type</th><th>Store</th><th>Primary</th><th>Bonus</th><th>Rows use</th></tr></thead>
          <tbody>
            {BALANCE_TYPES.map(({ code, label }) => {
              const p = pathsOf(code);
              return (
                <tr key={code}>
                  <td>{label}</td>
                  <td className="mono faint">{p.collection}</td>
                  <td className="mono">{p.primary}</td>
                  <td className="mono">{p.bonus}</td>
                  <td className="mono faint">{code}, {code}Bonus</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="dbgrid">
        <div className="panel">
          <h2>user_altcoin_portfolios <span className="right sub">token balances</span></h2>
          <Schema fields={PORTFOLIO_FIELDS} />
          <h3 style={{ marginTop: 14 }}>Live document</h3>
          <Doc value={docs.portfolio} />
        </div>
        <div className="panel">
          <h2>users <span className="right sub">legacy BTC and cash balances</span></h2>
          <p className="sub" style={{ marginBottom: 10 }}>The legacy amounts are plain fields on the User document, with their own DAL. The field names here are the simulator’s; the study does not list them.</p>
          <h3>Live document</h3>
          <Doc value={docs.user} />
        </div>
        <div className="panel">
          <h2>transactions <span className="right sub">{state.transactions.length} docs</span></h2>
          <Schema fields={TRANSACTION_FIELDS} />
          <h3 style={{ marginTop: 14 }}>Newest documents</h3>
          <Doc value={docs.transactions} />
        </div>
        <div className="panel">
          <h2>Last balance update <span className="right sub">{last ? `${last.collection}.findOneAndUpdate` : 'none yet'}</span></h2>
          <p className="sub" style={{ marginBottom: 10 }}>The pipeline is reconstructed from the study’s description of <code>buildIncrementBalanceQuery</code>: snapshot the original amounts, work out the split, apply it or restore both amounts. <code>_calc</code> is scratch space and is removed in the last stage.</p>
          {last ? <Doc value={last} /> : <p className="sub">Run an action in the Simulator tab.</p>}
        </div>
      </div>
    </div>
  );
}
