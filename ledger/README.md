# Ledger Simulator

An interactive model of the ledger and balance system described in `LEDGER_STUDY.md`: the unified
credit/deduct API, the two balance stores, the atomic update pipeline, the transaction log, and the
bet, bonus, payment and responsible-gaming flows on top of it.

```bash
npm install
npm run dev     # http://localhost:3002
npm test        # headless scenario matrix (Pseudocode / As studied / Hardened)
```

## Presets
- **As studied**: the ledger as the study describes it. Atomic `findOneAndUpdate` pipeline, the caller
  checks for an existing row before calling the ledger, a failed row insert is logged and swallowed,
  amounts are doubles.
- **Pseudocode (§7.2)**: the study's pseudocode taken literally. It reads, checks in the app and then
  writes, so two requests can both pass the check.
- **Hardened**: the same ledger with the gaps closed: an idempotency key guarded inside the balance
  update, a pending entry written with the balance and retried by a reconciler, decimal arithmetic.
  These are proposals, not part of the study.

"Show design knobs" exposes each decision separately.

## Tabs
- **Simulator**: balances per type and bucket, payments, bets, bonuses, admin set, responsible-gaming
  limits, concurrency and fault injection, a sequence diagram of the last operation (hover a step or a
  column name for a plain-language explanation; click a step to pin its full payload), the `transactions` collection, and invariant checks.
- **Database**: where each amount lives, the schemas from section 2, the live documents, and the
  pipeline of the last balance update. `#db` opens it directly.
- **Test scenarios**: 29 scenarios against every preset, including the study's ten (§7.3). Click a
  cell, then **Load into simulator** to open that scenario's end state. `#scenarios` opens it directly.

- **How it works**: a guide to the simulator itself: what a click does, how to read the sequence
  diagram, the presets and knobs, the rules, and how concurrency and faults are simulated. `#guide` opens it.

`?preset=hardened` (or `pseudocode`, `deployed`) picks the starting preset.

## Things to try
1. **As studied → Bet & lose 600 on USDT.** Primary has 500 and bonus 50, so the guard restores both amounts.
   Bet 520: the sequence shows primary first, overflow to bonus, and two rows are written.
2. **Pseudocode → Two bets at once (amount 300).** Both read 500, both pass, primary ends at −100.
   Under As studied the second one is refused.
3. **As studied → Fail the next transaction insert → Bet & lose.** The balance moves and no row exists;
   "Every change has a row" turns red. Under Hardened the pending entry is written on the next request.
4. **As studied → Same deposit, twice at once.** Both deliveries look for the row before either writes
   it, and the deposit is credited twice. Hardened refuses the second inside the update.
5. **As studied → Fail the next transaction insert → Deposit → Replay last callback.** The duplicate
   check finds no row and the deposit is applied again.
6. **Deposit 0.7, deposit 0.1, bet 0.8 on ETH.** With doubles the balance is 0.7999999999999999 and the bet is refused.
7. **Bet & win ×2 for 125 on USDT, twice.** The demo's 50 bonus needs 250 wagered; the second bet meets it and the bonus moves to primary.
8. **+181 days.** The rows expire; the balances and the invariants are unaffected.

## What is modelled, and what is assumed
The study describes behaviour, not source. Where it is silent the simulator makes a choice:
- The pipeline stages are a reconstruction of `buildIncrementBalanceQuery` from its description.
- Legacy field names on the User document (`balance`, `btcBonusBalance`, `cashBalance`, `cashBonusBalance`) are assumed.
- Payouts credit primary. Withdrawals and chargebacks use primary only. A bonus needs 5× wagering within 7 days.
- Responsible gaming checks limits before the bet and updates its counters from each ledger change.
- Of the five scenarios marked DEBT, only `row-failure` is stated outright by the study (§6). The other
  four (`duplicate-concurrent`, `replay-after-row-failure`, `refund-lost-rows`, `float`) are consequences
  derived from its text, not behaviour observed in the backend.

## Files
- `src/engine.js`: the pure engine (pipeline evaluator, balance and transaction DALs, unified API, flows, invariants)
- `src/scenarios.js`: scenario definitions shared by the UI and `npm test`
- `src/App.jsx`, `src/Database.jsx`, `src/Guide.jsx`: the UI
- `LEDGER_STUDY.md`: the study this simulates
- `SIMULATION_EXPLAINED.md`: how the simulator maps to the current ledger, the errors it shows and their fixes, and what is still assumed
