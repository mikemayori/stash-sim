/*
 * Stash: the dedicated ledger path from stash-ledger-path.md. PROPOSED, not implemented in the backend.
 *
 *  stashIn / stashOut move a fixed amount X between primary and stash in one guarded update.
 *  All or nothing: X is fixed, so no previous state and no scratch fields are needed, and original*
 *  is never read or written here. Mongo guards in the FILTER; RethinkDB guards in r.branch.
 *  Each transfer writes two rows in one insertMany whose amounts add to zero, linked by transferId.
 *  Bets, withdrawals, bonus and admin paths never read the stash amount.
 */
import { USER_ID, STASH_KEYS_KEPT, TWO_FA_WINDOW_MS, BT, tx, round, getPath, setPath, pathsOf, readBalance, dbOf, fmtAmt, step, note, nextId, oid } from './core.js';
import { begin, fail, succeed, warn, finishOp, createTransactions, setBalance, truthAdd } from './ledger.js';

const EV = 'P-stash';

/**
 * The guarded update. Returns { ok, primary, stash } after the change, { duplicate } when the key was
 * already applied, or { insufficient }. A missing portfolio document counts as insufficient funds.
 */
function guardedTransfer(s, { bt, amount: X, key, dir, pendingEntry }) {
  const p = pathsOf(bt);
  const db = dbOf(bt);
  const guardField = dir === 'in' ? p.primary : p.stash;
  const R = (x) => (s.config.math === 'round' ? round(x) : x);
  const dPrimary = dir === 'in' ? -X : X;
  if (p.store === 'portfolio') {
    const filter = { userId: USER_ID, [guardField]: { $gte: X }, stashKeys: { $ne: key } };
    const update = { $inc: { [p.primary]: dPrimary, [p.stash]: -dPrimary }, $push: { stashKeys: { $each: [key], $slice: -STASH_KEYS_KEPT }, ...(pendingEntry ? { pendingEntries: '<pending entry>' } : {}) } };
    s.lastUpdate = { store: 'Mongo', collection: p.collection, op: 'findOneAndUpdate', filter, update, options: { returnDocument: 'after' } };
    step(s, 'Ledger', db, 'user_altcoin_portfolios.findOneAndUpdate(filter guard, $inc)', { detail: s.lastUpdate, ev: EV, why: 'One guarded update. The guard and the idempotency key are in the filter, so a document that does not qualify simply does not match. No pipeline, no original* fields.' });
  } else {
    const reql = `r.table('users').get(userId).update(\n  (row) => r.branch(\n    row('${guardField}').default(0).ge(${X}).and(row('stashKeys').default([]).contains('${key}').not()),\n    { ${p.primary}: row('${p.primary}').${dir === 'in' ? 'sub' : 'add'}(${X}),\n      ${p.stash}: row('${p.stash}').default(0).${dir === 'in' ? 'add' : 'sub'}(${X}),\n      stashKeys: row('stashKeys').default([]).append('${key}').slice(-${STASH_KEYS_KEPT}) },\n    {}),\n  { returnChanges: true })`;
    s.lastUpdate = { store: 'RethinkDB', collection: 'users', op: 'update', reql, options: { returnChanges: true } };
    step(s, 'Ledger', db, 'users.get(id).update(r.branch(guard and key, change, {}))', { detail: s.lastUpdate, ev: EV, why: 'The same guarded update in ReQL. The stash field names on the users row are placeholders.' });
  }
  const doc = p.store === 'portfolio' ? s.mongo.portfolio : s.rethink.user;
  const keys = doc?.stashKeys || [];
  const available = doc ? getPath(doc, guardField) ?? 0 : 0;
  if (!doc || available < X || keys.includes(key)) {
    step(s, db, 'Ledger', p.store === 'portfolio' ? 'null: nothing changed' : 'changes: []', { kind: 'return', ev: EV });
    step(s, 'Ledger', db, 'read once to tell the two causes apart', { ev: EV, why: 'A null result means either insufficient funds or a key already applied. This read only decides what to report; it decides nothing about the balance.' });
    return keys.includes(key) ? { duplicate: true } : { insufficient: true, missingDocument: !doc };
  }
  setPath(doc, p.primary, R(readBalance(s, bt) + dPrimary));
  setPath(doc, p.stash, R(readBalance(s, bt, 'stash') - dPrimary));
  doc.stashKeys = [...keys, key].slice(-STASH_KEYS_KEPT);
  if (pendingEntry) (doc.pendingEntries ||= []).push(pendingEntry(readBalance(s, bt), readBalance(s, bt, 'stash')));
  const res = { ok: true, primary: readBalance(s, bt), stash: readBalance(s, bt, 'stash') };
  step(s, db, 'Ledger', `primary ${res.primary}, stash ${res.stash}`, { kind: 'return', detail: res, ev: EV, why: 'The document after the update gives both currentBalance values. No separate read is used for them.' });
  return res;
}

/** One transfer end to end: guarded update, ground truth, the row pair. */
function transfer(s, { bt, amount: X, key, dir }) {
  const type = tx(dir === 'in' ? 'stashIn' : 'stashOut');
  const transferId = nextId(s, 'tr');
  const meta = { transferId, idempotencyKey: key };
  const dPrimary = dir === 'in' ? -X : X;
  const rowsOf = (primary, stash) => [[bt, dPrimary, primary], [`${bt}Stash`, -dPrimary, stash]];
  const pendingId = s.config.stashRowFailure === 'pending' ? oid(s) : null;
  const pendingEntry = pendingId ? (primary, stash) => ({ id: pendingId, type, balanceType: bt, meta, createdAt: s.clock, rows: rowsOf(primary, stash) }) : null;
  step(s, s.lastOp.caller, 'Ledger', `${type}(${bt}, ${X}, '${key}')`, { detail: { balanceType: bt, amount: X, key }, ev: EV, why: 'A dedicated function in lib/index.ts. It calls none of the existing balance methods and never touches bonus.' });
  const r = guardedTransfer(s, { bt, amount: X, key, dir, pendingEntry });
  if (r.duplicate) return { ok: true, duplicate: true };
  if (r.insufficient) return { ok: false, error: r.missingDocument ? 'Insufficient funds (no portfolio document)' : 'Insufficient funds: nothing moved' };
  truthAdd(s, bt, dPrimary);
  truthAdd(s, `${bt}Stash`, -dPrimary);
  s.truth.stashPairs.push(transferId);
  const ids = createTransactions(s, { bt, type, meta, rows: rowsOf(r.primary, r.stash), pendingId, stash: true });
  if (s.config.stashValidator !== 'deployed') warn(s, `the row with balanceType ${bt}Stash is stored, but readers that hydrate rows will throw on it`);
  return { ok: true, ...r, transferId, transactionId: ids[0], transactionIds: ids, rowMissing: ids.length === 0 };
}

function gate(s) {
  if (s.config.stash !== 'on') return 'Stash is not part of this preset';
  if (s.rethink.user.deleted) return 'User not found';
  if (!s.stashFlag) return 'Stash transfers are disabled by the feature flag';
  return null;
}
const finish = (s, r, msg) => {
  if (r.ok && r.rowMissing) {
    s.lastOp.result = r;
    warn(s, s.config.stashRowFailure === 'pending' ? 'the row insert failed; the pending entry waits for the reconciler' : 'the row insert failed; an alert was raised with full detail');
    return succeed(s, msg);
  }
  return finishOp(s, r, msg);
};

export function stashIn(state, { balanceType: bt, amount, key }) {
  const s = begin(state, 'Stash in', 'Player');
  const blocked = gate(s);
  if (blocked) return fail(s, blocked, 'Player');
  if (!(Number.isFinite(amount) && amount > 0)) return fail(s, 'Invalid amount', 'Player');
  const r = transfer(s, { bt, amount, key: key || `stashIn:${nextId(s, 'req')}`, dir: 'in' });
  return finish(s, r, `Moved ${fmtAmt(bt, amount)} from primary to stash`);
}

/**
 * Stash-out runs its checks on the server before the update: 2FA (single-use per user for 120 s;
 * there is no wrong-code limiter today) and an active wagering requirement, read from the primary.
 */
export function stashOut(state, { balanceType: bt, amount, key, token }) {
  const s = begin(state, 'Stash out', 'Player');
  const blocked = gate(s);
  if (blocked) return fail(s, blocked, 'Player');
  if (!(Number.isFinite(amount) && amount > 0)) return fail(s, 'Invalid amount', 'Player');
  note(s, 'Player', '2FA check', { ev: 'P-2fa', why: 'The token is single-use per user for 120 s. No limiter on wrong codes exists today.' });
  if (!/^\d{6}$/.test(token || '')) return fail(s, '2FA code missing or wrong', 'Player');
  if (s.twoFA.used[token] !== undefined && s.clock - s.twoFA.used[token] < TWO_FA_WINDOW_MS) return fail(s, '2FA code already used in this window', 'Player');
  s.twoFA.used[token] = s.clock;
  const b = s.bonuses[bt];
  note(s, 'Player', `wagering requirement read from the primary: ${b ? `${b.wagered} of ${b.wagerRequired}` : 'none'}`, { ev: 'P-2fa' });
  if (b && b.wagered < b.wagerRequired) return fail(s, 'Refused before the update: active wagering requirement', 'Player');
  const debt = -Math.min(readBalance(s, bt), 0);
  if (debt > 0) {
    note(s, 'Player', `primary is negative (${-debt}): policy = ${s.config.stashOutNegative}`, { ev: EV, why: 'Open policy: with a negative primary, must a stash-out cover the debt first, or may any amount be added?' });
    if (s.config.stashOutNegative === 'mustCoverDebt' && amount < debt) return fail(s, `Refused: a stash-out must cover the debt of ${debt} first`, 'Player');
  }
  const r = transfer(s, { bt, amount, key: key || `stashOut:${nextId(s, 'req')}`, dir: 'out' });
  return finish(s, r, `Moved ${fmtAmt(bt, amount)} from stash to primary`);
}

/** The same stash-in request delivered twice at the same moment, with the same key. */
export function concurrentStashIn(state, { balanceType: bt, amount }) {
  const s = begin(state, 'Same stash-in, twice at once', 'Player');
  const blocked = gate(s);
  if (blocked) return fail(s, blocked, 'Player');
  if (!(Number.isFinite(amount) && amount > 0)) return fail(s, 'Invalid amount', 'Player');
  const key = `stashIn:${nextId(s, 'req')}`;
  note(s, 'Player', `${key} delivered twice`, { ev: EV, why: 'The guard and the key are inside one atomic update, so the two deliveries cannot interleave.' });
  const results = [0, 1].map(() => transfer(s, { bt, amount, key, dir: 'in' }));
  const applied = results.filter((r) => r.ok && !r.duplicate).length;
  s.lastOp.result = { applied };
  return applied ? succeed(s, `Applied ${applied} time${applied === 1 ? '' : 's'}; stash is now ${fmtAmt(bt, readBalance(s, bt, 'stash'))}`) : fail(s, results[0].error);
}

/** The feature flag gates transfers only. Reads must not depend on it. */
export function setStashFlag(state, { on }) {
  const s = begin(state, `Stash flag ${on ? 'on' : 'off'}`, 'Job');
  s.stashFlag = on;
  return succeed(s, on ? 'Transfers enabled' : 'Transfers disabled; stashed funds stay where they are', 'Job');
}

/** Open policy: after a sportsbook rollback leaves primary negative, can stash cover the debt? */
export function sweepStashForDebt(s, bt) {
  if (s.config.stash !== 'on') return;
  const stash = readBalance(s, bt, 'stash');
  if (stash <= 0) return;
  if (s.config.stashCoversDebt !== 'autoSweep') {
    note(s, 'Sportsbook', `primary is negative while stash holds ${stash}`, { ev: EV, why: 'Open policy: stash does not cover sportsbook debt here, so the player owes money while holding stashed funds.' });
    return;
  }
  const amount = Math.min(stash, -readBalance(s, bt));
  note(s, 'Sportsbook', `sweep ${amount} from stash to cover the debt`, { ev: EV, why: 'Open policy: stash is swept automatically after a rollback.' });
  transfer(s, { bt, amount, key: `sweep:${nextId(s, 'req')}`, dir: 'out' });
}

/** Open policy: do ACP reset and confiscate include the stash amount? */
export function adminStashPolicy(s, { bt, action, type, meta, caller }) {
  if (s.config.stash !== 'on') return;
  const stash = readBalance(s, bt, 'stash');
  if (stash === 0) return;
  const include = action === 'reset' ? s.config.resetIncludesStash === 'yes' : action === 'confiscate' ? s.config.confiscateIncludesStash === 'yes' : false;
  if (!include) {
    note(s, caller, `stash untouched: ${stash} ${BT[bt].label} stays`, { ev: EV, why: action === 'confiscate' ? 'Open policy. Leaving stash out turns it into a shelter from confiscation.' : 'Open policy: whether a reset clears stash.' });
    return;
  }
  setBalance(s, { bt, bucket: 'stash', value: 0, type, meta, caller, fn: 'adminReplaceUserBalance' });
}
