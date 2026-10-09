/*
 * The callers of the ledger: bets and providers, payments, bonus, sportsbook, the two admin APIs,
 * and maintenance jobs. Every public operation is (state, args) => new state.
 */
import {
  USER_ID, DAY, TX_TTL_DAYS, BONUS_DAYS, BONUS_WAGER_MULTIPLIER, EPS, ALL_BALANCE_TYPES, BT, tx,
  dAdd, dSub, dMul, readBalance, bucketName, dbOf, fmtAmt, step, note, log, nextId,
} from './core.js';
import {
  begin, fail, succeed, warn, finishOp, deductBalance, creditBalance, deductArgs, startChange, finishChange,
  transformBonus, setBalance, seenBefore, readRows, mongoNode, hydrate, drainPending, pendingCount, truthAdd,
} from './ledger.js';
import { sweepStashForDebt, adminStashPolicy } from './stash.js';

const PROVIDER = 'sim-provider';
const duplicate = () => ({ ok: true, duplicate: true });
const nonZero = (n) => Number.isFinite(n) && n !== 0;
const positive = (n) => Number.isFinite(n) && n > 0;
const deleted = (s) => (s.rethink.user.deleted ? fail(s, 'User not found: the account was deleted by cleanupOldUsers', s.lastOp.caller) : null);

/* ─── bonus ─── */
/**
 * checkIfBonusActive(user, balanceType) is not a pure read (L-82): past the end date it expires the
 * bonus, which zeroes the bonus amount, writes a row and sends a socket event.
 */
export function checkIfBonusActive(s, bt, caller) {
  const b = s.bonuses[bt];
  step(s, caller, 'Bonus', `checkIfBonusActive(user, ${bt})`, { ev: 'L-82', why: 'Looks like a guard, but it can write: an overdue bonus is expired here, on read.' });
  if (!b || b.expiresAt > s.clock) {
    step(s, 'Bonus', caller, b ? 'active' : 'no bonus', { kind: 'return' });
    return Boolean(b);
  }
  note(s, 'Bonus', 'past its end date: expired on read', { detail: b, ev: 'L-82', why: 'A balance write hidden inside a check. Bets and tips both trigger it.' });
  transformBonus(s, { bt, kind: 'expire', type: tx('bonusExpired'), meta: { bonusId: b.id, reason: 'expired' }, caller: 'Bonus' });
  s.sideEffects.socket += 1;
  s.bonuses[bt] = null;
  warn(s, `checkIfBonusActive expired the ${BT[bt].label} bonus during a read`);
  step(s, 'Bonus', caller, 'not active', { kind: 'return' });
  return false;
}
function doCompleteBonus(s, bt) {
  const bonusId = s.bonuses[bt]?.id;
  s.bonuses[bt] = null;
  return transformBonus(s, { bt, kind: 'complete', type: tx('bonusCompleted'), meta: { bonusId }, caller: 'Bonus' });
}
function bonusProgress(s, bt, amount) {
  const b = s.bonuses[bt];
  if (!b) return;
  b.wagered = dAdd(b.wagered, amount);
  step(s, 'Bet', 'Bonus', `wagered ${b.wagered} of ${b.wagerRequired}`, { detail: b, ev: 'A-bonus', why: 'Each bet counts toward the wagering requirement. The 5x within 7 days rule is a placeholder.' });
  if (b.wagered >= b.wagerRequired) doCompleteBonus(s, bt);
}

export function grantBonus(state, { balanceType: bt, amount, wagerMultiplier = BONUS_WAGER_MULTIPLIER, days = BONUS_DAYS }) {
  const s = begin(state, 'Grant bonus', 'Bonus');
  if (deleted(s)) return s;
  if (!positive(amount)) return fail(s, 'Invalid amount', 'Bonus');
  if (s.bonuses[bt]) return fail(s, `${BT[bt].label} already has an active bonus`, 'Bonus');
  const id = nextId(s, 'bonus');
  const r = creditBalance(s, { bt, amount, bucket: 'bonus', type: tx('bonusGrant'), meta: { bonusId: id }, caller: 'Bonus', key: `bonus:${id}` });
  s.bonuses[bt] = { id, amount, wagerRequired: dMul(amount, wagerMultiplier), wagered: 0, expiresAt: s.clock + days * DAY };
  return finishOp(s, r, `Granted ${fmtAmt(bt, amount)} bonus: wager ${dMul(amount, wagerMultiplier)} within ${days} days`);
}
export function completeBonus(state, { balanceType: bt }) {
  const s = begin(state, 'Complete bonus', 'Bonus');
  const bonus = readBalance(s, bt, 'bonus');
  if (bonus <= 0) return fail(s, 'No bonus balance to move', 'Bonus');
  return finishOp(s, doCompleteBonus(s, bt), `Moved ${fmtAmt(bt, bonus)} from bonus to primary`);
}
export function expireBonus(state, { balanceType: bt }) {
  const s = begin(state, 'Expire bonus', 'Bonus');
  const bonus = readBalance(s, bt, 'bonus');
  if (bonus <= 0) return fail(s, 'No bonus balance to clear', 'Bonus');
  const bonusId = s.bonuses[bt]?.id;
  s.bonuses[bt] = null;
  return finishOp(s, transformBonus(s, { bt, kind: 'expire', type: tx('bonusExpired'), meta: { bonusId, reason: 'forfeited' }, caller: 'Bonus' }), `Cleared ${fmtAmt(bt, bonus)} of bonus`);
}
/** Calls the check on its own, as any reader of the bonus state would. */
export function readBonusState(state, { balanceType: bt }) {
  const s = begin(state, 'checkIfBonusActive', 'Player');
  const active = checkIfBonusActive(s, bt, 'Player');
  s.lastOp.result = { active };
  return succeed(s, active ? 'Bonus is active' : 'No active bonus', 'Player');
}

/* ─── bets and providers ─── */
function doPlaceBet(s, { bt, amount, betId }) {
  step(s, 'Provider', 'Bet', `bet ${betId}`, { detail: { betId, balanceType: bt, amount }, why: 'The game provider reports a bet with its identifier.' });
  checkIfBonusActive(s, bt, 'Bet');
  note(s, 'Bet', `getBalanceFromUserAndType: ${readBalance(s, bt)} + ${readBalance(s, bt, 'bonus')}`, { ev: 'L-85', why: 'Every bet path reads one balance type and adds balance + bonusBalance by name.' });
  if (seenBefore(s, 'Bet', tx('bet'), 'betId', betId)) return duplicate();
  const r = deductBalance(s, { bt, amount, type: tx('bet'), meta: { betId, provider: PROVIDER }, caller: 'Bet', key: `bet:${betId}` });
  if (r.ok && !r.duplicate) {
    s.rethink.user.hasBet = true;
    const bonusBetAmount = -r.bonusChange;
    if (!s.mongo.bets.some((b) => b.betId === betId)) {
      const persisted = s.config.bonusBetAmountPersisted === 'yes';
      s.mongo.bets.unshift({ betId, balanceType: bt, amount: Math.abs(amount), status: 'open', payout: 0, createdAt: s.clock, ...(persisted ? { bonusBetAmount } : {}) });
      s.truth.betSplit[betId] = { primary: -r.primaryChange, bonus: bonusBetAmount };
      note(s, 'Bet', `bonusBetAmount ${bonusBetAmount} ${persisted ? 'stored on the bet record' : 'carried in the request only'}`, { ev: 'L-85', why: 'The bonus part of a bet is carried through the bet path as bonusBetAmount. Whether it is persisted and used by refunds is Open.' });
    }
    bonusProgress(s, bt, Math.abs(amount));
  }
  return r;
}

function doSettle(s, bet, multiplier) {
  const payout = dMul(bet.amount, multiplier);
  step(s, 'Provider', 'Bet', `${payout > 0 ? 'win' : 'lose'} ${bet.betId}`, { detail: { betId: bet.betId, payout } });
  if (payout === 0) {
    bet.status = 'lost';
    note(s, 'Bet', 'lost: no ledger call', { why: 'A lost bet moves no money: the stake was taken when the bet was placed.' });
    return { ok: true, lost: true };
  }
  if (seenBefore(s, 'Bet', tx('payout'), 'betId', bet.betId)) return duplicate();
  const r = creditBalance(s, { bt: bet.balanceType, amount: payout, type: tx('payout'), meta: { betId: bet.betId, provider: PROVIDER }, caller: 'Bet', key: `payout:${bet.betId}`, why: 'Payouts credit primary. What a bonus-funded payout does is Open.' });
  if (r.ok && !r.duplicate) Object.assign(bet, { status: 'won', payout });
  return r;
}

/** A refund has to know how the bet was split. Where it gets that from is a knob (L-56). */
function doRefund(s, bet) {
  const bt = bet.balanceType;
  const cfg = s.config;
  step(s, 'Provider', 'Bet', `refund ${bet.betId}`, { detail: { betId: bet.betId }, why: 'The provider cancels the round and asks for the stake back.' });
  if (seenBefore(s, 'Bet', tx('refund'), 'betId', bet.betId)) return duplicate();
  let primaryPart = bet.amount;
  let bonusPart = 0;
  let known = true;
  if (cfg.refundSplit === 'bonusBetAmount') {
    if (bet.bonusBetAmount === undefined) known = false;
    else {
      bonusPart = bet.bonusBetAmount;
      primaryPart = dSub(bet.amount, bonusPart);
    }
    note(s, 'Bet', known ? `bonusBetAmount on the bet record: ${bonusPart}` : 'bonusBetAmount is not on the bet record', { ev: 'L-85' });
  } else if (cfg.refundSplit === 'rows' || cfg.refundSplit === 'meta') {
    const node = mongoNode(cfg.refundRead);
    step(s, 'Bet', node, `transactions.find({ type: 'bet', meta.betId })`, { detail: { readPreference: cfg.refundRead }, ev: 'L-56', why: `The split is rebuilt from the rows written when the bet was placed. This read goes to the ${cfg.refundRead}.` });
    const rows = readRows(s, cfg.refundRead).filter((t) => t.type === tx('bet') && t.meta?.betId === bet.betId);
    step(s, node, 'Bet', `${rows.length} row${rows.length === 1 ? '' : 's'}`, { kind: 'return', detail: rows });
    const taken = (name) => rows.filter((t) => t.balanceType === name).reduce((sum, t) => dSub(sum, t.amount), 0);
    if (!rows.length) known = false;
    else if (cfg.refundSplit === 'meta' && rows[0].meta?.split) ({ primary: primaryPart, bonus: bonusPart } = rows[0].meta.split);
    else {
      primaryPart = taken(bt);
      bonusPart = taken(`${bt}Bonus`);
    }
  }
  if (!known) warn(s, 'the split of the bet is unknown, so the whole refund went to primary');
  // Ground truth: the stake goes back to the buckets it came from, once.
  const key = `refund:${bet.betId}`;
  const split = s.truth.betSplit[bet.betId] || { primary: bet.amount, bonus: 0 };
  if (!s.truth.applied[key] && !s.truth.applied[`${key}:bonus`]) {
    truthAdd(s, bt, split.primary);
    truthAdd(s, `${bt}Bonus`, split.bonus);
  }
  if (Math.abs(primaryPart - split.primary) > EPS || Math.abs(bonusPart - split.bonus) > EPS) {
    s.truth.refundMismatch.push({ betId: bet.betId, balanceType: bt, refunded: { primary: primaryPart, bonus: bonusPart }, taken: split });
  }
  let r;
  for (const [bucket, amount] of [['primary', primaryPart], ['bonus', bonusPart]]) {
    if (amount <= 0) continue;
    r = creditBalance(s, { bt, amount, bucket, type: tx('refund'), meta: { betId: bet.betId, provider: PROVIDER }, caller: 'Bet', key: bucket === 'bonus' ? `${key}:bonus` : key, truthSkip: true });
  }
  if (r.ok && !r.duplicate) bet.status = 'refunded';
  return r;
}

/** Places a bet and leaves the round open. A negative amount is accepted: deductBalance forces the sign (L-29). */
export function placeBet(state, { balanceType: bt, amount, betId, replay = false }) {
  const s = begin(state, replay ? 'Bet (replayed)' : 'Bet', 'Bet');
  if (deleted(s)) return s;
  if (!nonZero(amount)) return fail(s, 'Invalid amount', 'Bet');
  const id = betId || nextId(s, 'b');
  if (!replay) s.lastCallback = { op: 'placeBet', args: { balanceType: bt, amount, betId: id } };
  return finishOp(s, doPlaceBet(s, { bt, amount, betId: id }), `Bet ${fmtAmt(bt, Math.abs(amount))} (${id})`);
}
export function settleBet(state, { betId, multiplier = 2, replay = false }) {
  const s = begin(state, replay ? 'Settle (replayed)' : 'Settle bet', 'Bet');
  const bet = s.mongo.bets.find((b) => b.betId === betId);
  if (!bet) return fail(s, `Unknown bet ${betId}`, 'Bet');
  if (!replay && bet.status !== 'open') return fail(s, `Bet ${betId} is already ${bet.status}`, 'Bet');
  if (!replay) s.lastCallback = { op: 'settleBet', args: { betId, multiplier } };
  const r = doSettle(s, bet, multiplier);
  return finishOp(s, r, r.lost ? `Bet ${betId} lost` : `Paid out ${fmtAmt(bet.balanceType, dMul(bet.amount, multiplier))} on ${betId}`);
}
export function refundBet(state, { betId, replay = false }) {
  const s = begin(state, replay ? 'Refund (replayed)' : 'Refund bet', 'Bet');
  const bet = s.mongo.bets.find((b) => b.betId === betId);
  if (!bet) return fail(s, `Unknown bet ${betId}`, 'Bet');
  if (!replay && bet.status !== 'open') return fail(s, `Bet ${betId} is already ${bet.status}`, 'Bet');
  if (!replay) s.lastCallback = { op: 'refundBet', args: { betId } };
  return finishOp(s, doRefund(s, bet), `Refunded ${fmtAmt(bet.balanceType, bet.amount)} on ${betId}`);
}
/** A whole round in one go: the bet, then the win or loss. */
export function playRound(state, { balanceType: bt, amount, multiplier = 0 }) {
  const s = begin(state, multiplier > 0 ? `Bet and win ×${multiplier}` : 'Bet and lose', 'Bet');
  if (deleted(s)) return s;
  if (!positive(amount)) return fail(s, 'Invalid amount', 'Bet');
  const betId = nextId(s, 'b');
  s.lastCallback = { op: 'placeBet', args: { balanceType: bt, amount, betId } };
  const placed = doPlaceBet(s, { bt, amount, betId });
  if (!placed.ok || placed.duplicate) return finishOp(s, placed);
  if (multiplier > 0) s.lastCallback = { op: 'settleBet', args: { betId, multiplier } };
  const r = doSettle(s, s.mongo.bets.find((b) => b.betId === betId), multiplier);
  r.rowMissing ||= placed.rowMissing;
  return finishOp(s, r, r.lost ? `Lost ${fmtAmt(bt, amount)}` : `Bet ${fmtAmt(bt, amount)}, won ${fmtAmt(bt, dMul(amount, multiplier))}`);
}
/** Two different bets on the same balance, both in flight together. */
export function concurrentBets(state, { balanceType: bt, amount }) {
  const s = begin(state, 'Two bets at once', 'Bet');
  if (!positive(amount)) return fail(s, 'Invalid amount', 'Bet');
  const ids = [nextId(s, 'b'), nextId(s, 'b')];
  note(s, 'Bet', `${ids.join(' and ')} arrive together`, { why: 'Two different bets on the same balance are processed at the same moment.' });
  const phases = ids.map((betId) => startChange(s, deductArgs({ bt, amount, type: tx('bet'), meta: { betId, provider: PROVIDER }, caller: 'Bet', key: `bet:${betId}` })));
  const results = phases.map((ph) => finishChange(s, ph));
  results.forEach((r, i) => {
    if (!r.ok) return;
    s.mongo.bets.unshift({ betId: ids[i], balanceType: bt, amount, status: 'open', payout: 0, createdAt: s.clock });
    s.truth.betSplit[ids[i]] = { primary: -r.primaryChange, bonus: -r.bonusChange };
  });
  const accepted = results.filter((r) => r.ok).length;
  s.lastOp.result = { accepted };
  if (!accepted) return fail(s, 'Both refused: bet__not_enough_balance');
  if (readBalance(s, bt) < 0) warn(s, 'both passed the check and the balance went negative');
  return succeed(s, `${accepted} of 2 accepted; primary is now ${fmtAmt(bt, readBalance(s, bt))}`);
}

/* ─── deposits: a collection with a status; credited on completion only (L-37) ─── */
const findDeposit = (s, id) => s.mongo.deposits.find((d) => d.id === id);
function newDeposit(s, bt, amount, depositId) {
  const dep = { id: depositId || nextId(s, 'dep'), balanceType: bt, amount, status: 'pending', createdAt: s.clock };
  s.mongo.deposits.unshift(dep);
  step(s, 'Payments', 'Mongo primary', `deposits.insert(${dep.id}, pending)`, { detail: dep, ev: 'L-37', why: 'A deposit is a record with a status. Nothing is credited yet.' });
  return dep;
}
/** The handler reads the deposit first. Returns 'go', 'done' or 'blocked'. */
function depositGate(s, dep) {
  step(s, 'Payments', 'Mongo primary', `deposits.findOne(${dep.id})`, { ev: 'L-37' });
  step(s, 'Mongo primary', 'Payments', `status: ${dep.status}`, { kind: 'return', ev: 'L-95', why: 'Only the current status is stored. How the record got there is in Datadog logs, which are sampled and expire.' });
  return dep.status === 'pending' ? 'go' : dep.status === 'blocked' ? 'blocked' : 'done';
}
/** The status update: plain, or a conditional pending → completed transition. Returns 'ok', 'failed' or 'lost'. */
function depositStatus(s, dep) {
  const conditional = s.config.depositTransition === 'conditional';
  step(s, 'Payments', 'Mongo primary', conditional ? `deposits.findOneAndUpdate({ _id, status: 'pending' } → completed)` : 'deposits.updateOne(status: completed)', { ev: 'L-37', why: conditional ? 'A conditional transition: only one delivery can move the deposit out of pending.' : 'A plain update: it succeeds however many deliveries run it.' });
  if (s.faults.failStatusUpdate > 0) {
    s.faults.failStatusUpdate -= 1;
    step(s, 'Mongo primary', 'Payments', 'status update failed', { kind: 'error' });
    log(s, 'error', `deposit ${dep.id}: status update failed`);
    return 'failed';
  }
  if (conditional && dep.status !== 'pending') {
    step(s, 'Mongo primary', 'Payments', 'null: no longer pending', { kind: 'return' });
    return 'lost';
  }
  dep.status = 'completed';
  return 'ok';
}
function depositCredit(s, dep) {
  const r = creditBalance(s, { bt: dep.balanceType, amount: dep.amount, type: tx('deposit'), meta: { externalIdentifier: dep.id }, caller: 'Payments', key: `deposit:${dep.id}` });
  if (r.ok && !r.duplicate) s.rethink.user.hasDeposited = true;
  return r;
}
/** Credit and status in the order the knob says (Open, L-37). */
function depositApply(s, dep) {
  if (s.config.depositOrder === 'statusFirst') {
    const st = depositStatus(s, dep);
    if (st === 'lost') return duplicate();
    if (st === 'failed') return { ok: false, error: 'Deposit status update failed; nothing credited', from: 'Payments' };
    return depositCredit(s, dep);
  }
  const r = depositCredit(s, dep);
  if (!r.ok) return r;
  if (depositStatus(s, dep) === 'failed') warn(s, 'the deposit was credited but is still pending');
  return r;
}
function depositDeliver(s, dep) {
  const gate = depositGate(s, dep);
  if (gate === 'blocked') return { ok: false, error: `Deposit ${dep.id} is blocked: no credit`, from: 'Payments' };
  if (gate === 'done') return duplicate();
  return depositApply(s, dep);
}

export function depositCreate(state, { balanceType: bt, amount, depositId }) {
  const s = begin(state, 'Deposit created', 'Payments');
  if (deleted(s)) return s;
  if (!nonZero(amount)) return fail(s, 'Invalid amount', 'Payments');
  const dep = newDeposit(s, bt, amount, depositId);
  s.lastOp.result = { depositId: dep.id };
  return succeed(s, `Deposit ${dep.id} is pending; nothing credited yet`, 'Payments');
}
/** Fraud or a block stops a deposit before the credit. */
export function depositBlock(state, { depositId }) {
  const s = begin(state, 'Block deposit', 'Payments');
  const dep = findDeposit(s, depositId);
  if (!dep) return fail(s, `Unknown deposit ${depositId}`, 'Payments');
  if (dep.status !== 'pending') return fail(s, `Deposit ${depositId} is already ${dep.status}`, 'Payments');
  dep.status = 'blocked';
  note(s, 'Payments', `${dep.id} blocked before the credit`, { ev: 'L-37' });
  return succeed(s, `Deposit ${dep.id} blocked`, 'Payments');
}
/** The completion callback for a deposit. */
export function depositComplete(state, { depositId, replay = false }) {
  const s = begin(state, replay ? 'Deposit callback (replayed)' : 'Deposit callback', 'Payments');
  const dep = findDeposit(s, depositId);
  if (!dep) return fail(s, `Unknown deposit ${depositId}`, 'Payments');
  if (!replay) s.lastCallback = { op: 'depositComplete', args: { depositId } };
  return finishOp(s, depositDeliver(s, dep), `Deposited ${fmtAmt(dep.balanceType, dep.amount)}`);
}
/** Create and complete in one action. */
export function deposit(state, { balanceType: bt, amount, depositId }) {
  const s = begin(state, 'Deposit', 'Payments');
  if (deleted(s)) return s;
  if (!nonZero(amount)) return fail(s, 'Invalid amount', 'Payments');
  const dep = newDeposit(s, bt, amount, depositId);
  s.lastCallback = { op: 'depositComplete', args: { depositId: dep.id } };
  return finishOp(s, depositDeliver(s, dep), `Deposited ${fmtAmt(bt, amount)}`);
}
/** The same completion callback delivered twice, both in flight together. */
export function concurrentDepositCallbacks(state, { balanceType: bt, amount }) {
  const s = begin(state, 'Same deposit callback, twice at once', 'Payments');
  if (!positive(amount)) return fail(s, 'Invalid amount', 'Payments');
  const dep = newDeposit(s, bt, amount);
  s.lastCallback = { op: 'depositComplete', args: { depositId: dep.id } };
  note(s, 'Payments', `${dep.id}: two deliveries in flight`, { why: 'Both deliveries read the deposit before either has finished.' });
  // Both read first, then each applies.
  const gates = [0, 1].map(() => depositGate(s, dep));
  const results = gates.map((g) => (g === 'go' ? depositApply(s, dep) : duplicate()));
  const applied = results.filter((r) => r.ok && !r.duplicate).length;
  s.lastOp.result = { applied };
  if (applied > 1) warn(s, `one deposit of ${fmtAmt(bt, amount)} was credited ${applied} times`);
  return succeed(s, `Credited ${applied} time${applied === 1 ? '' : 's'}; primary is now ${fmtAmt(bt, readBalance(s, bt))}`);
}

/* ─── withdrawals: debit at request, possibly credited back later (L-31, L-38) ─── */
const MUTEX = `withdraw:${USER_ID}`;
function withdrawDebit(s, bt, amount) {
  const id = nextId(s, 'wd');
  const r = deductBalance(s, { bt, amount, balancesToUse: ['primary'], type: tx('withdrawal'), meta: { withdrawalId: id }, caller: 'Payments', key: `withdrawal:${id}`, why: 'Withdrawals take from primary only, at request time.' });
  if (r.ok) s.mongo.withdrawals.unshift({ id, balanceType: bt, amount, status: 'pending', createdAt: s.clock });
  else if (readBalance(s, bt, 'bonus') > 0) r.error = 'bet__not_enough_balance (bonus is not withdrawable)';
  return { r, id };
}
export function withdrawRequest(state, { balanceType: bt, amount }) {
  const s = begin(state, 'Withdrawal request', 'Payments');
  if (deleted(s)) return s;
  if (!positive(amount)) return fail(s, 'Invalid amount', 'Payments');
  note(s, 'Payments', `Redis mutex ${MUTEX}: acquired`, { ev: 'L-86', why: 'A per-user, non-blocking mutex guards the request: a second request while it is held is refused, not queued.' });
  const { r, id } = withdrawDebit(s, bt, amount);
  note(s, 'Payments', 'mutex released', { ev: 'L-86' });
  if (r.ok) r.withdrawalId = id;
  return finishOp(s, r, `Withdrawal ${id} requested: ${fmtAmt(bt, amount)} debited from primary`);
}
/** Two withdrawal requests at the same moment: the non-blocking mutex refuses the second. */
export function concurrentWithdrawRequests(state, { balanceType: bt, amount }) {
  const s = begin(state, 'Two withdrawal requests at once', 'Payments');
  if (!positive(amount)) return fail(s, 'Invalid amount', 'Payments');
  note(s, 'Payments', `request A: mutex ${MUTEX} acquired`, { ev: 'L-86' });
  step(s, 'Payments', 'Payments', 'request B: mutex held → refused', { kind: 'error', ev: 'L-86', why: 'Non-blocking: the second request fails at once instead of waiting.' });
  const { r, id } = withdrawDebit(s, bt, amount);
  note(s, 'Payments', 'request A: mutex released', { ev: 'L-86' });
  s.lastOp.result = { accepted: r.ok ? 1 : 0, withdrawalId: id };
  return r.ok ? succeed(s, `1 of 2 accepted (${id}); the other was refused by the mutex`) : fail(s, r.error);
}
/**
 * The later outcome of a withdrawal. Reversal, decline and cancel each credit primary back.
 * Nothing known guards these handlers (L-39): the guard is a knob.
 */
export function withdrawOutcome(state, { withdrawalId, outcome }) {
  const s = begin(state, `Withdrawal ${outcome}`, 'Payments');
  const wd = s.mongo.withdrawals.find((w) => w.id === withdrawalId);
  if (!wd) return fail(s, `Unknown withdrawal ${withdrawalId}`, 'Payments');
  const guarded = s.config.reversalGuard === 'transition';
  if (guarded) {
    step(s, 'Payments', 'Mongo primary', `withdrawals.findOneAndUpdate({ _id, status: 'pending' } → ${outcome})`, { ev: 'P-hard', why: 'A conditional transition out of pending: only the first handler gets through.' });
    if (wd.status !== 'pending') {
      step(s, 'Mongo primary', 'Payments', `null: already ${wd.status}`, { kind: 'return' });
      return finishOp(s, duplicate());
    }
  } else {
    note(s, 'Payments', `no guard: handler runs whatever the status (${wd.status})`, { ev: 'L-39', why: 'Nothing known stops a second reversal, decline or cancel from crediting again. Open, owner: Payments.' });
  }
  const was = wd.status;
  wd.status = outcome;
  if (outcome === 'completed') return succeed(s, `Withdrawal ${wd.id} completed; no ledger call`, 'Payments');
  const type = tx({ reversal: 'withdrawalReversal', decline: 'withdrawalDecline', cancel: 'withdrawalCancel' }[outcome]);
  const r = creditBalance(s, { bt: wd.balanceType, amount: wd.amount, type, meta: { withdrawalId: wd.id }, caller: 'Payments', key: `withdrawalBack:${wd.id}`, why: 'The money debited at request time is credited back to primary.' });
  if (r.ok && !r.duplicate) {
    s.truth.creditBacks[wd.id] = (s.truth.creditBacks[wd.id] || 0) + 1;
    if (s.truth.creditBacks[wd.id] > 1 || was === 'completed') warn(s, `withdrawal ${wd.id} was credited back ${was === 'completed' ? 'after it completed' : `${s.truth.creditBacks[wd.id]} times`}`);
  }
  return finishOp(s, r, `Withdrawal ${wd.id} ${outcome}: ${fmtAmt(wd.balanceType, wd.amount)} credited back`);
}

/** Tips read primary only, and trigger checkIfBonusActive (L-82, L-86). */
export function tip(state, { balanceType: bt, amount }) {
  const s = begin(state, 'Tip', 'Player');
  if (deleted(s)) return s;
  if (!positive(amount)) return fail(s, 'Invalid amount', 'Player');
  checkIfBonusActive(s, bt, 'Player');
  const r = deductBalance(s, { bt, amount, balancesToUse: ['primary'], type: tx('tip'), meta: { tipId: nextId(s, 'tip') }, caller: 'Player', why: 'Tips read primary only.' });
  return finishOp(s, r, `Tipped ${fmtAmt(bt, amount)}`);
}

/* ─── sportsbook: the caller that passes allowNegative (L-36, L-88) ─── */
export function sportsbookWin(state, { balanceType: bt, amount }) {
  const s = begin(state, 'Sportsbook settle (win)', 'Sportsbook');
  if (deleted(s)) return s;
  if (!positive(amount)) return fail(s, 'Invalid amount', 'Sportsbook');
  const id = nextId(s, 'sb');
  const r = creditBalance(s, { bt, amount, type: tx('payout'), meta: { betId: id, provider: 'sportsbook' }, caller: 'Sportsbook', key: `payout:${id}` });
  return finishOp(s, r, `Sportsbook paid ${fmtAmt(bt, amount)}`);
}
/** A rollback takes a settled win back with allowNegative, so primary can go below zero. */
export function sportsbookRollback(state, { balanceType: bt, amount }) {
  const s = begin(state, 'Sportsbook rollback', 'Sportsbook');
  if (deleted(s)) return s;
  if (!positive(amount)) return fail(s, 'Invalid amount', 'Sportsbook');
  const id = nextId(s, 'sbr');
  const r = deductBalance(s, { bt, amount, allowNegative: true, type: tx('sportsbookRollback'), meta: { rollbackId: id, provider: 'sportsbook' }, caller: 'Sportsbook', key: `rollback:${id}`, why: 'allowNegative: the guard is skipped, so the balance can go below zero. The player keeps playing until a deposit covers it.' });
  if (r.ok && readBalance(s, bt) < 0) sweepStashForDebt(s, bt);
  return finishOp(s, r, `Rolled back ${fmtAmt(bt, amount)}; primary is now ${fmtAmt(bt, readBalance(s, bt))}`);
}

/* ─── admin: two APIs with different side effects (L-81) ─── */
const ACP_TYPE = { reset: 'acpReset', confiscate: 'acpConfiscate', replace: 'acpReplace', adjust: 'acpAdjust' };
/** `between` runs after the admin's read and before the write, to interleave another operation. */
function doAcp(s, { api = 'rest', action, balanceType: bt, value = 0, amount = 0, reason = 'Operational correction', adminId = 'admin_7' }, between) {
  const caller = api === 'rest' ? 'ACP REST' : 'ACP GraphQL';
  const type = tx(ACP_TYPE[action]);
  const meta = { adminId, reason, api };
  const beforeAll = readBalance(s, bt);
  let r;
  if (action === 'adjust') {
    between?.();
    if (amount < 0 || s.config.positiveAdjust === 'forcedNegative') {
      if (amount > 0) warn(s, `a positive adjust of ${amount} went through deductBalance and was applied as −${amount}`);
      r = deductBalance(s, { bt, amount, balancesToUse: ['primary'], type, meta, caller });
    } else {
      r = creditBalance(s, { bt, amount, type, meta, caller, why: 'ACP adjust goes through deductBalance. How a positive adjustment is made is Open; here it uses the credit path.' });
    }
  } else {
    let priorRead;
    if (s.config.setDiff === 'priorRead') {
      step(s, caller, dbOf(bt), `read ${bt} balance`, { ev: 'L-35', why: 'The old value is read first, in its own request, to compute the difference the row will record.' });
      priorRead = readBalance(s, bt);
      step(s, dbOf(bt), caller, `${priorRead}`, { kind: 'return' });
    }
    between?.();
    r = setBalance(s, { bt, bucket: 'primary', value: action === 'replace' ? value : 0, type, meta, caller, fn: 'adminReplaceUserBalance', priorRead });
    if (action !== 'replace') note(s, caller, 'primary only: bonus untouched', { ev: 'L-87', why: 'ACP reset and confiscate act on the primary amount only.' });
    adminStashPolicy(s, { bt, action, type, meta, caller });
  }
  if (!r.ok) return r;
  note(s, caller, 'reason is free text and visible to the player in meta', { detail: meta, ev: 'L-96' });
  if (api === 'rest' && action === 'adjust') {
    s.sideEffects.userNotes.push({ t: s.clock, adminId, text: `adjusted ${bt} by ${amount}: ${reason}` });
    s.sideEffects.slack.push({ t: s.clock, text: `[admin-log] ${adminId} adjusted ${USER_ID} ${bt} by ${amount}` });
    note(s, caller, 'overviewAdjustBalance: user note + Slack admin-log line', { ev: 'L-81', why: 'Only the REST adjust path writes these. The GraphQL path changes the balance without them.' });
  }
  if (s.config.adminAudit === 'write') {
    s.mongo.audits.unshift({ action: 'balanceChange', adminId, userId: USER_ID, balanceType: bt, before: beforeAll, after: readBalance(s, bt), reason, api, createdAt: s.clock });
    step(s, caller, 'Mongo primary', 'audits.insert(balanceChange)', { ev: 'P-hard', why: 'Hardened: the existing audits.balanceChange action is written, so the admin action outlives the 180-day row.' });
  } else {
    note(s, caller, 'no audit record: audits.balanceChange is never written', { ev: 'L-96', why: 'The transaction row, which expires after 180 days, is the only record of this admin action.' });
  }
  return r;
}
const acpMessage = (s, a) => (a.action === 'adjust' ? `Adjusted ${a.balanceType} by ${a.amount}` : `${a.action}: ${a.balanceType} primary is now ${readBalance(s, a.balanceType)}`);

/** action: 'reset' | 'confiscate' | 'replace' (value) | 'adjust' (amount, signed). api: 'rest' | 'graphql'. */
export function acpAction(state, args) {
  const s = begin(state, `ACP ${args.action} (${args.api === 'graphql' ? 'GraphQL' : 'REST'})`, args.api === 'graphql' ? 'ACP GraphQL' : 'ACP REST');
  if (deleted(s)) return s;
  if (args.action === 'adjust' && !nonZero(args.amount)) return fail(s, 'Invalid amount', s.lastOp.caller);
  if (args.action === 'replace' && !(Number.isFinite(args.value) && args.value >= 0)) return fail(s, 'Invalid amount', s.lastOp.caller);
  return finishOp(s, doAcp(s, args), acpMessage(s, args));
}
/** An ACP reset while a bet is being applied: the bet lands between the admin's read and the set. */
export function acpResetDuringBet(state, { balanceType: bt, betAmount, api = 'rest' }) {
  const s = begin(state, 'ACP reset while a bet is applied', api === 'graphql' ? 'ACP GraphQL' : 'ACP REST');
  if (!positive(betAmount)) return fail(s, 'Invalid amount', s.lastOp.caller);
  const betId = nextId(s, 'b');
  const r = doAcp(s, { api, action: 'reset', balanceType: bt }, () => {
    note(s, 'Bet', `bet ${betId} lands before the set`, { why: 'Another request changes the balance between the admin’s read and the overwrite.' });
    doPlaceBet(s, { bt, amount: betAmount, betId });
  });
  return finishOp(s, r, `Reset ${bt}: row records ${r.amount}, real change ${r.real}`);
}

/* ─── missing balanceType (L-80) ─── */
/** A ledger deduction whose caller omitted balanceType (identifier undefined) or sent an empty one (''). */
export function deductWithoutBalanceType(state, { intended, amount, identifier }) {
  const s = begin(state, 'Ledger call without balanceType', 'Bet');
  if (!positive(amount)) return fail(s, 'Invalid amount', 'Bet');
  step(s, 'Bet', 'Ledger', `deductBalance(${identifier === '' ? "''" : 'undefined'}, ${amount})`, { detail: { balanceType: identifier, intended }, ev: 'L-80', why: 'A caller bug: the balance type is missing.' });
  if (s.config.missingBalanceType === 'reject') return fail(s, 'balanceType is required');
  const bt = identifier === '' ? 'crypto' : s.rethink.user.selectedBalanceType;
  note(s, 'Ledger', identifier === '' ? 'empty identifier resolves to BTC (crypto)' : `falls back to the selected balance: ${bt}`, { ev: 'L-80', why: 'No error is raised. The change is applied to a balance the caller did not mean.' });
  // Ground truth: the deduction was meant for `intended`.
  const r = deductBalance(s, { bt, amount, type: tx('bet'), meta: { betId: nextId(s, 'b'), provider: PROVIDER }, caller: 'Bet', truthSkip: true });
  if (r.ok) {
    truthAdd(s, intended, -amount);
    if (bt !== intended) warn(s, `meant for ${intended}, applied to ${bt}`);
  }
  s.lastOp.resolved = bt;
  return finishOp(s, r, `Deducted ${amount} from ${bt}`);
}
export function selectBalance(state, { balanceType }) {
  const s = structuredClone(state);
  s.rethink.user.selectedBalanceType = balanceType;
  return s;
}

/* ─── replay ─── */
/** Re-delivers the last provider or payment callback with the same identifier. */
export function replayLast(state) {
  const cb = state.lastCallback;
  if (!cb) return fail(begin(state, 'Replay', 'Provider'), 'Nothing to replay yet', 'Provider');
  return { depositComplete, placeBet, settleBet, refundBet }[cb.op](state, { ...cb.args, replay: true });
}

/* ─── maintenance ─── */
export function runReconciler(state) {
  const pending = pendingCount(state);
  const s = begin(state, 'Run reconciler', 'Reconciler');
  if (s.config.rowFailure !== 'pending' && !(s.config.stash === 'on' && s.config.stashRowFailure === 'pending')) return fail(s, 'Nothing to reconcile from: a failed insert leaves no record behind (L-53)', 'Reconciler');
  drainPending(s);
  return succeed(s, pending ? `Wrote the rows of ${pending} pending entr${pending > 1 ? 'ies' : 'y'}` : 'No pending entries', 'Reconciler');
}

/** Moves the clock. The TTL index removes rows older than 180 days; the warehouse copy keeps them. */
export function advanceDays(state, { days }) {
  const s = begin(state, `+${days} days`, 'Job');
  s.clock += days * DAY;
  const cutoff = s.clock - TX_TTL_DAYS * DAY;
  const expired = s.mongo.transactions.filter((t) => t.createdAt < cutoff);
  for (const t of expired) s.expiredSums[t.balanceType] = dAdd(s.expiredSums[t.balanceType] || 0, t.amount);
  s.mongo.transactions = s.mongo.transactions.filter((t) => t.createdAt >= cutoff);
  if (expired.length) note(s, 'Mongo primary', `TTL index removed ${expired.length} rows`, { ev: 'L-44', why: 'Rows older than 180 days are removed. Balances are not affected, and can no longer be explained by rows.' });
  const overdue = Object.entries(s.bonuses).filter(([, b]) => b && b.expiresAt <= s.clock).map(([bt]) => bt);
  if (overdue.length) note(s, 'Bonus', `${overdue.join(', ')} bonus past its end date, still on the balance`, { ev: 'L-82', why: 'Nothing has expired it yet. The next checkIfBonusActive will.' });
  s.lastOp.result = { expired: expired.length, warehouse: s.warehouse.length };
  return succeed(s, `${expired.length} rows expired; the warehouse holds ${s.warehouse.length}`, 'Job');
}

/** cleanupOldUsers (L-83): deletes accounts with BTC, ETH and LTC below 0.01 that never deposited or bet. */
export function cleanupOldUsers(state) {
  const s = begin(state, 'cleanupOldUsers', 'Job');
  const u = s.rethink.user;
  const checked = { crypto: readBalance(s, 'crypto'), eth: readBalance(s, 'eth'), ltc: readBalance(s, 'ltc'), hasDeposited: u.hasDeposited, hasBet: u.hasBet };
  step(s, 'Job', 'RethinkDB', 'users.filter(BTC, ETH, LTC < 0.01, never deposited, never bet)', { detail: checked, ev: 'L-83', why: 'It acts on balances without going through a balance change. Only the BTC, ETH and LTC amounts are checked.' });
  const eligible = checked.crypto < 0.01 && checked.eth < 0.01 && checked.ltc < 0.01 && !u.hasDeposited && !u.hasBet;
  if (!eligible) return succeed(s, 'Account kept', 'Job');
  const held = ALL_BALANCE_TYPES.flatMap(({ code }) => ['primary', 'bonus', 'stash'].map((b) => [bucketName(code, b), readBalance(s, code, b)])).filter(([, n]) => n !== 0);
  u.deleted = true;
  if (held.length) warn(s, `Inferred: the account still held ${held.map(([k, n]) => `${k} ${n}`).join(', ')}, which the rule does not look at`);
  s.lastOp.result = { deleted: true, held: Object.fromEntries(held) };
  return succeed(s, 'Account deleted', 'Job');
}

/**
 * The sampled check from analysis §7: for each bucket, compare the balance with the newest row's
 * currentBalance, reading rows from a secondary. A mismatch is a missing row or a wrong amount.
 */
export function measurementJob(state) {
  const s = begin(state, 'Measurement job', 'Job');
  step(s, 'Job', 'Mongo secondary', 'newest row per bucket (readPref secondary)', { ev: 'L-53', why: 'No such job exists today. This is the cheapest way to turn error 1 into a number, without code changes.' });
  const rows = readRows(s, 'secondary');
  const mismatches = [];
  let checked = 0;
  for (const { code } of ALL_BALANCE_TYPES) {
    for (const bucket of ['primary', 'bonus', 'stash']) {
      const name = bucketName(code, bucket);
      const last = rows.find((t) => t.balanceType === name);
      if (!last) continue; // no activity in the retention window: cannot be checked this way
      checked += 1;
      const value = readBalance(s, code, bucket);
      if (Math.abs(last.currentBalance - value) > EPS) mismatches.push({ bucket: name, value, rowBalance: last.currentBalance, lastRow: last._id });
    }
  }
  step(s, 'Mongo secondary', 'Job', `${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'} in ${checked} buckets`, { kind: 'return', detail: mismatches });
  s.lastOp.result = { checked, mismatches };
  if (mismatches.length) warn(s, mismatches.map((m) => `${m.bucket}: balance ${m.value}, newest row says ${m.rowBalance}`).join('; '));
  return succeed(s, `${checked} buckets checked, ${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'}`, 'Job');
}

/** The ACP transaction table and CSV export hydrate rows through Mongoose, so the post('init') hook runs (L-91). */
export function acpExportCsv(state) {
  const s = begin(state, 'ACP CSV export', 'ACP REST');
  step(s, 'ACP REST', 'Mongo primary', 'transactions.find({ userId }) → hydrate', { ev: 'L-91', why: 'Hydrating a row runs the post(\'init\') hook, which throws when a stored balanceType is not a known value.' });
  const res = hydrate(s, s.mongo.transactions);
  if (!res.ok) return fail(s, res.error, 'Mongo primary');
  s.lastOp.result = { rows: res.rows.length };
  return succeed(s, `Exported ${res.rows.length} rows`, 'Mongo primary');
}

/** What is left to explain an admin action: the row (180 days), the warehouse copy, the audits record. */
export function adminRecords(s) {
  const admin = new Set(Object.values(ACP_TYPE).map(tx));
  return {
    rows: s.mongo.transactions.filter((t) => admin.has(t.type)).length,
    warehouse: s.warehouse.filter((t) => admin.has(t.type)).length,
    audits: s.mongo.audits.length,
  };
}

/* ─── faults, timing, config ─── */
/** faults: { failInserts: n, failStatusUpdate: n }. Errors come in incidents, so inserts can fail in a batch. */
export const setFault = (state, faults) => ({ ...state, faults: { ...state.faults, ...faults } });
/** The next action arrives `ms` after the previous one (default 1000). */
export const setGap = (state, ms) => ({ ...state, gapMs: ms });
export const setConfig = (state, config) => ({ ...state, config: { ...config } });
