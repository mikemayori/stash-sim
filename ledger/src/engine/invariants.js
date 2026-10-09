/*
 * Invariants, checked after every step. Each one carries an evidence label and a scope:
 * 'production' rules could be checked against the real stores; 'simulator' rules rely on
 * bookkeeping only the simulator has (ground truth, rows the TTL removed).
 */
import { BALANCE_TYPES, dAdd, dSub, near, readBalance } from './core.js';
import { mongoResult, legacyResult } from './ledger.js';

/** The golden cases from the migration approach §4.3, plus one with a negative primary. */
export const GOLDEN_CASES = [
  { name: 'Primary only: 50/0, deduct 20', p: 50, b: 0, a: { amount: -20 } },
  { name: 'Bonus only: 0/50, deduct 20', p: 0, b: 50, a: { amount: -20 } },
  { name: 'Split: 10/50, deduct 30', p: 10, b: 50, a: { amount: -30 } },
  { name: 'Exactly zero: 10/20, deduct 30', p: 10, b: 20, a: { amount: -30 } },
  { name: 'More than available: 10/20, deduct 40', p: 10, b: 20, a: { amount: -40 } },
  { name: 'Withdrawal, primary only: 10/50, withdraw 30', p: 10, b: 50, a: { amount: -30, balancesToUse: ['primary'] } },
  { name: 'Credit primary: 10/0, +5', p: 10, b: 0, a: { amount: 5 } },
  { name: 'Credit bonus: 10/0, +5 bonus', p: 10, b: 0, a: { amount: 5, bucket: 'bonus' } },
  { name: 'allowNegative: 10/0, deduct 30', p: 10, b: 0, a: { amount: -30, allowNegative: true } },
  { name: 'Float residue: 0.7 + 0.1, deduct 0.8', p: 0.7 + 0.1, b: 0, a: { amount: -0.8 } },
  { name: 'Negative primary: −5/50, deduct 10', p: -5, b: 50, a: { amount: -10 } },
];
/** Runs each golden case through the Mongo pipeline and the ReQL split and reports every difference. */
export function parityReport(cfg) {
  return GOLDEN_CASES.map((c) => {
    const mongo = mongoResult(c.p, c.b, c.a, cfg);
    const legacy = legacyResult(c.p, c.b, c.a, cfg);
    return { name: c.name, mongo, legacy, same: mongo.primary === legacy.primary && mongo.bonus === legacy.bonus };
  });
}

const pendingOf = (s) => [...(s.mongo.portfolio?.pendingEntries || []), ...(s.rethink.user.pendingEntries || [])];
function pendingDelta(e, code, bucket) {
  if (e.rows) return e.rows.filter(([name]) => name === bucket).reduce((sum, [, amount]) => dAdd(sum, amount), 0);
  return bucket === code ? dSub(e.primaryAfter, e.primaryBefore) : bucket === `${code}Bonus` ? dSub(e.bonusAfter, e.bonusBefore) : 0;
}

export function invariants(s) {
  const out = [];
  const stashOn = s.config.stash === 'on';
  const pending = pendingOf(s);
  const add = (id, group, cur, ok, detail, evLabel, scope = 'production') => out.push({ id, group, cur, ok, detail, evLabel, scope });

  for (const { code, label } of BALANCE_TYPES) {
    const amounts = { [code]: readBalance(s, code), [`${code}Bonus`]: readBalance(s, code, 'bonus'), ...(stashOn ? { [`${code}Stash`]: readBalance(s, code, 'stash') } : {}) };
    const waiting = pending.filter((e) => e.balanceType === code);
    const check = (f) => {
      const results = Object.entries(amounts).map(([bucket, amount]) => f(bucket, amount));
      return [results.every((r) => r.ok), results.filter((r) => !r.ok).map((r) => r.detail).join('; ') || results[0].detail];
    };
    const conserve = check((bucket, amount) => ({ ok: near(amount, s.truth.expected[bucket] || 0), detail: `${bucket} ${amount} vs expected ${s.truth.expected[bucket] || 0}` }));
    add(`conserve-${code}`, 'Conservation', label, ...conserve, 'Assumed', 'simulator');

    const negAllowed = s.truth.negativeAllowed[code];
    const negative = Object.entries(amounts).filter(([bucket, n]) => n < 0 && !(bucket === code && negAllowed));
    add(`neg-${code}`, 'No negative balance', label, negative.length === 0, negative.map(([k, n]) => `${k} = ${n}`).join('; ') || (negAllowed ? 'primary is negative; allowNegative was used' : 'nothing below zero'), 'Study');

    // The production rule: currentBalance is the balance of the one bucket a row touched, so the newest row per bucket must match it.
    const latest = check((bucket, amount) => {
      const t = s.mongo.transactions.find((x) => x.balanceType === bucket);
      if (!t) return { ok: near(amount, 0) || bucket in s.expiredSums || waiting.length > 0, detail: `no ${bucket} row; stored ${amount}` };
      return { ok: near(t.currentBalance, amount) || waiting.length > 0, detail: `newest ${bucket} row says ${t.currentBalance}; stored ${amount}` };
    });
    add(`latest-${code}`, 'Latest row matches balance', label, ...latest, 'Meeting');

    // Simulator-only: it ignores the TTL by adding back what expired. It cannot hold in production (L-54).
    const covered = check((bucket, amount) => {
      const rows = s.mongo.transactions.filter((t) => t.balanceType === bucket).reduce((sum, t) => dAdd(sum, t.amount), 0);
      const total = dAdd(dAdd(rows, s.expiredSums[bucket] || 0), waiting.reduce((sum, e) => dAdd(sum, pendingDelta(e, code, bucket)), 0));
      return { ok: near(total, amount), detail: `${bucket}: rows add up to ${total}; stored ${amount}` };
    });
    add(`rows-${code}`, 'Rows add up to balance', label, ...covered, 'Assumed', 'simulator');

    const residue = Object.entries(amounts).filter(([, n]) => Number(n.toFixed(8)) !== n);
    add(`float-${code}`, 'No float residue', label, residue.length === 0, residue.map(([k, n]) => `${k} = ${n}`).join('; ') || 'amounts are exact', 'Code');
  }

  const repeated = Object.entries(s.truth.applied).filter(([, n]) => n > 1).map(([k, n]) => `${k} × ${n}`);
  add('once', 'Each callback applied once', 'All', repeated.length === 0, repeated.join('; ') || 'no identifier was applied twice', 'Study', 'simulator');

  const diffs = parityReport(s.config).filter((c) => !c.same);
  add('parity', 'Store parity', 'All', diffs.length === 0, diffs.map((c) => `${c.name}: Mongo ${c.mongo.primary}/${c.mongo.bonus}, ReQL ${c.legacy.primary}/${c.legacy.bonus}`).join('; ') || `${GOLDEN_CASES.length} golden cases give the same result in both stores (the ReQL split is Assumed)`, 'Assumed', 'simulator');

  const rm = s.truth.refundMismatch;
  add('refund-source', 'Refund returns to source buckets', 'All', rm.length === 0, rm.map((m) => `${m.betId}: took ${m.taken.primary}/${m.taken.bonus}, refunded ${m.refunded.primary}/${m.refunded.bonus}`).join('; ') || 'every refund went back where the bet came from', 'Study', 'simulator');

  const twice = Object.entries(s.truth.creditBacks).filter(([, n]) => n > 1);
  add('withdraw-once', 'Withdrawal credited back at most once', 'All', twice.length === 0, twice.map(([id, n]) => `${id} × ${n}`).join('; ') || 'no withdrawal was credited back twice', 'Open', 'simulator');

  const am = s.truth.adminMismatch;
  add('admin-row', 'Admin row matches real change', 'All', am.length === 0, am.map((m) => `${m.bucket}: row ${m.recorded}, real ${m.real}`).join('; ') || 'every admin row records the real change', 'Open', 'simulator');

  if (stashOn) {
    const bad = s.truth.stashPairs.map((id) => [id, s.mongo.transactions.filter((t) => t.meta?.transferId === id)]).filter(([, rows]) => rows.length && (rows.length !== 2 || !near(rows.reduce((sum, t) => dAdd(sum, t.amount), 0), 0)));
    add('stash-pairs', 'Stash pairs sum to zero', 'All', bad.length === 0, bad.map(([id, rows]) => `${id}: ${rows.length} rows`).join('; ') || 'the two rows of each transferId add up to 0', 'Proposed');
    const moved = BALANCE_TYPES.filter(({ code }) => !near(readBalance(s, code, 'stash'), s.truth.expected[`${code}Stash`] || 0));
    add('stash-untouched', 'Stash never wagered or withdrawn', 'All', moved.length === 0, moved.map(({ code }) => `${code}Stash ${readBalance(s, code, 'stash')} vs expected ${s.truth.expected[`${code}Stash`] || 0}`).join('; ') || 'only stash transfers and admin policy changed stash', 'Proposed', 'simulator');
  }
  return out;
}
