import { BALANCE_TYPES, EVIDENCE, TX_TYPES, TX_TTL_DAYS, pathsOf } from './engine.js';
import { Chip, Ev } from './ui.jsx';

// [field, type, description, evidence label, proposal?]. A proposal is a field that does not exist in the backend.
const USER_FIELDS = [
  ['id', 'String', 'The user id.', 'Assumed'],
  ['balance', 'Number', 'BTC primary. Balance type “crypto”.', 'Code'],
  ['btcBonusBalance', 'Number', 'BTC bonus.', 'Code'],
  ['ethBalance / ethBonusBalance', 'Number', 'ETH primary and bonus.', 'Code'],
  ['ltcBalance / ltcBonusBalance', 'Number', 'LTC primary and bonus.', 'Code'],
  ['cashBalance / cashBonusBalance', 'Number', 'Cash primary and bonus.', 'Code'],
  ['selectedBalanceType', 'String', 'Where a ledger call without balanceType lands (L-80).', 'Code'],
  ['hasDeposited, hasBet, deleted', 'Boolean', 'Simulator names for what cleanupOldUsers looks at and does (L-83).', 'Assumed'],
  ['appliedKeys', 'Array', 'Hardened only: idempotency keys already applied to this row.', 'Proposed', 'Hardened'],
  ['pendingEntries', 'Array', 'Hardened only: changes whose transaction rows are not written yet.', 'Proposed', 'Hardened'],
  ['btcStashBalance, ethStashBalance, ltcStashBalance, cashStashBalance', 'Number', 'Stash only. The field names are placeholders.', 'Proposed', 'Stash'],
  ['stashKeys', 'Array', 'Stash only: the last 20 stash idempotency keys.', 'Proposed', 'Stash'],
];
const PORTFOLIO_FIELDS = [
  ['userId', 'String', 'One document per user, created on first use (L-05).', 'Meeting'],
  ['balances.<type>.balance', 'Number', 'Primary amount, a USD float.', 'Code'],
  ['balances.<type>.bonusBalance', 'Number', 'Bonus amount.', 'Code'],
  ['balances.<type>.originalBalance', 'Number', 'Stored scratch field: primary before the last update. Written by the pipeline, then left stale (L-24, L-25).', 'Meeting'],
  ['balances.<type>.originalBonusBalance', 'Number', 'Stored scratch field: bonus before the last update. Left stale.', 'Meeting'],
  ['appliedKeys', 'Array', 'Hardened only: idempotency keys already applied to this document.', 'Proposed', 'Hardened'],
  ['pendingEntries', 'Array', 'Hardened only: changes whose transaction rows are not written yet. Also used by the Stash “pending entry” option.', 'Proposed', 'Hardened'],
  ['balances.<type>.stashBalance', 'Number', 'Stash only: the stashed amount.', 'Proposed', 'Stash'],
  ['stashKeys', 'Array', 'Stash only: the last 20 stash idempotency keys.', 'Proposed', 'Stash'],
];
const TRANSACTION_FIELDS = [
  ['userId', 'String', 'The user the row belongs to.', 'Study'],
  ['type', 'String', 'The action. See the type names below.', 'Study'],
  ['balanceType', 'String', 'The bucket: usdt, usdtBonus, cash, cashBonus, … One row per bucket changed (L-40).', 'Study'],
  ['amount', 'Number', 'Signed change of that bucket.', 'Study'],
  ['currentBalance', 'Number', 'Balance of that bucket after the change.', 'Study'],
  ['meta', 'Mixed', 'The only extension point: betId, provider, externalIdentifier, withdrawalId, bonusId, adminId, reason, api.', 'Meeting'],
  ['createdAt', 'Date', `TTL index: rows expire after ${TX_TTL_DAYS} days.`, 'Study'],
  ['meta.split', 'Object', 'Hardened only: the primary/bonus split of a bet, so a refund does not rebuild it from rows.', 'Proposed', 'Hardened'],
  ['meta.transferId, meta.idempotencyKey', 'String', 'Stash only: links the two rows of one transfer.', 'Proposed', 'Stash'],
  ['balanceType = <type>Stash', 'String', 'Stash only: a new stored value. The post(\'init\') validator must know it first.', 'Proposed', 'Stash'],
];
const FROZEN = [
  ['L-42', 'Schema and indexes are frozen. meta is the only extension point.'],
  ['L-89', 'The freeze is enforced: the migration job throws on any index diff.'],
  ['L-90', 'Compound index { userId, type, createdAt }.'],
  ['L-44', `TTL: rows expire after ${TX_TTL_DAYS} days.`],
  ['L-92', 'Warehouse copy in BigQuery keeps older rows. Completeness is unchecked.'],
  ['L-91', 'A Mongoose post(\'init\') hook throws on an unknown stored balanceType.'],
];

function Schema({ fields }) {
  return (
    <table>
      <thead><tr><th>Field</th><th>Type</th><th>Label</th><th>Description</th></tr></thead>
      <tbody>
        {fields.map(([name, type, text, label, proposal]) => (
          <tr key={name} className={proposal ? 'proposal' : ''}>
            <td className="mono">{name}</td>
            <td className="mono faint">{type}</td>
            <td><Chip label={label} />{proposal && <span className="tag muted" style={{ marginLeft: 4 }}>{proposal} only</span>}</td>
            <td className="sub">{text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const Doc = ({ value }) => <pre>{JSON.stringify(value, null, 2)}</pre>;
const Frozen = () => <Chip label="Meeting" text="frozen" title={EVIDENCE['L-42'].text} />;

function LastUpdate({ last }) {
  if (!last) return <p className="sub">Run an action in the Simulator tab.</p>;
  if (last.reql) {
    return (
      <>
        <h3>ReQL</h3>
        <pre>{last.reql}</pre>
        <p className="sub" style={{ marginTop: 6 }}>returnChanges gives both images of the row (old_val, new_val), so the RethinkDB path needs no scratch fields. <Ev id="L-27" /></p>
      </>
    );
  }
  const isPipeline = Array.isArray(last.update);
  return (
    <>
      <h3>Filter</h3>
      <Doc value={last.filter} />
      <h3 style={{ marginTop: 10 }}>{isPipeline ? `Update pipeline (${last.update.length} stages)` : 'Update'}</h3>
      <Doc value={last.update} />
      <h3 style={{ marginTop: 10 }}>Options</h3>
      <Doc value={last.options} />
      {isPipeline && <p className="sub" style={{ marginTop: 6 }}>The stage layout is reconstructed from the described behaviour, not copied from queryBuilder.ts. <Ev id="A-layout" /></p>}
    </>
  );
}

export default function Database({ state }) {
  const last = state.lastUpdate;
  const stashOn = state.config.stash === 'on';
  const { transactions, deposits, withdrawals, bets, audits, portfolio } = state.mongo;
  return (
    <div className="db">
      <div className="panel">
        <h2>Where each amount lives <Ev id="L-01" /></h2>
        <table>
          <thead><tr><th>Balance type</th><th>Store</th><th>Collection / table</th><th>Primary</th><th>Bonus</th><th>Stash <Chip label="Proposed" /></th><th>Scratch fields</th><th>Row balanceType values</th></tr></thead>
          <tbody>
            {BALANCE_TYPES.map(({ code, label, store }) => {
              const p = pathsOf(code);
              return (
                <tr key={code}>
                  <td><strong>{label}</strong> <span className="mono faint">{code}</span></td>
                  <td>{store === 'portfolio' ? 'Mongo' : 'RethinkDB'}</td>
                  <td className="mono faint">{p.collection}</td>
                  <td className="mono">{p.primary}</td>
                  <td className="mono">{p.bonus}</td>
                  <td className="mono proposal-text">{p.stash}</td>
                  <td className="mono faint">{p.origPrimary ? 'originalBalance, originalBonusBalance' : 'none (returnChanges)'}</td>
                  <td className="mono faint">{code}, {code}Bonus{stashOn ? `, ${code}Stash` : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="sub" style={{ marginTop: 8 }}>The simulator shows five of the twelve balance types. Purple rows and names are proposals: they exist only in the Hardened or Stash presets, not in the backend.</p>
      </div>

      <div className="dbgrid">
        <div className="panel">
          <h2>RethinkDB users row <Ev id="L-03" /><span className="right sub">crypto (BTC), eth, ltc, cash</span></h2>
          <p className="sub" style={{ marginBottom: 10 }}>The legacy path is written in ReQL and is not in the integration test harness. <Ev id="L-97" /></p>
          <Schema fields={USER_FIELDS} />
          <h3 style={{ marginTop: 14 }}>Stored row</h3>
          <Doc value={state.rethink.user} />
        </div>
        <div className="panel">
          <h2>Mongo user_altcoin_portfolios <Ev id="L-04" /><span className="right sub">usdt, sol and six more</span></h2>
          <p className="sub" style={{ marginBottom: 10 }}>The pipeline copies the starting values into originalBalance and originalBonusBalance on every update. They are in the schema and stay on the document, stale. <Ev id="L-25" /></p>
          <Schema fields={PORTFOLIO_FIELDS} />
          <h3 style={{ marginTop: 14 }}>Stored document</h3>
          {portfolio ? <Doc value={portfolio} /> : <p className="sub">No portfolio document yet. It is created on the first write to a portfolio type. <Ev id="L-05" /></p>}
        </div>

        <div className="panel">
          <h2>Mongo transactions <Frozen /><span className="right sub">{transactions.length} rows · warehouse {state.warehouse.length}</span></h2>
          <ul className="frozen">
            {FROZEN.map(([id, text]) => <li key={id}><Ev id={id} /> <span>{text}</span></li>)}
          </ul>
          <Schema fields={TRANSACTION_FIELDS} />
          <h3 style={{ marginTop: 14 }}>Newest rows</h3>
          <Doc value={transactions.slice(0, 6)} />
        </div>
        <div className="panel">
          <h2>Last balance update <span className="right sub">{last ? `${last.store}: ${last.collection}.${last.op}` : 'none yet'}</span></h2>
          <LastUpdate last={last} />
        </div>

        <div className="panel">
          <h2>Transaction type names <span className="right sub">TX_TYPES: the one place to replace an unconfirmed name</span></h2>
          <table>
            <thead><tr><th>Used for</th><th>Stored type</th><th>Label</th></tr></thead>
            <tbody>
              {Object.entries(TX_TYPES).map(([key, t]) => (
                <tr key={key} className={t.label === 'Assumed' ? 'assumed' : t.label === 'Proposed' ? 'proposal' : ''}>
                  <td>{key}</td>
                  <td className="mono">{t.name}</td>
                  <td><Chip label={t.label} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="sub" style={{ marginTop: 8 }}>Highlighted rows are Assumed: the real name is not confirmed.</p>
        </div>
        <div className="panel">
          <h2>Other Mongo collections <span className="right sub">newest first</span></h2>
          <h3>deposits ({deposits.length}) <Ev id="L-37" /></h3>
          <Doc value={deposits.slice(0, 4)} />
          <h3 style={{ marginTop: 10 }}>withdrawals ({withdrawals.length}) <Ev id="L-38" /></h3>
          <Doc value={withdrawals.slice(0, 4)} />
          <h3 style={{ marginTop: 10 }}>bets ({bets.length}) <Ev id="L-85" /></h3>
          <Doc value={bets.slice(0, 4)} />
          <h3 style={{ marginTop: 10 }}>audits ({audits.length}) <Ev id="L-96" /></h3>
          <Doc value={audits.slice(0, 4)} />
          <p className="sub" style={{ marginTop: 6 }}>Deposits and withdrawals keep only their current status. <Ev id="L-95" /></p>
        </div>
      </div>
    </div>
  );
}
