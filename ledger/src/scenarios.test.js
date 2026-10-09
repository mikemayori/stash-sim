import { SCENARIOS, STASH_SCENARIOS, MIGRATION_SCENARIOS, ERROR_REGISTER, runCell, runMigrationCase, typesOf } from './scenarios.js';

// Prints the matrix (scenario × preset × balance type) and a summary of which errors the current
// ledger produces. Exits non-zero only when a result differs from its documented expectation.
//   PASS  correct, as expected          DEBT  the documented error reproduces (Current, Stash)
//   OPEN  depends on an Open knob       N/F   not fixable under Hardened without something blocked
//   fail  Pseudocode fails by design    MISMATCH  differs from the expectation
const PRESET_KEYS = ['current', 'pseudocode', 'hardened', 'stash'];
const W = 22;
let mismatches = 0;
const debtCells = {};

function cellText(sc, key) {
  return typesOf(sc).map((bt) => {
    const r = runCell(sc, key, bt);
    if (!r.match) {
      mismatches += 1;
      console.error(`  ✗ ${sc.id} (${key}, ${bt}): expected ${r.expect}, got ${r.got}: ${r.notes.join(' | ')}`);
    }
    if (key === 'current' && r.status === 'DEBT') for (const n of sc.errors || []) (debtCells[n] ||= new Set()).add(sc.id);
    return r.status;
  }).join('/');
}

console.log('Ledger scenarios. Each cell: cash/usdt unless the scenario names its types.\n');
console.log(['scenario'.padEnd(12), 'types'.padEnd(11), ...PRESET_KEYS.map((k) => k.padEnd(W)), 'error'].join(''));
for (const sc of SCENARIOS) {
  const cells = PRESET_KEYS.map((k) => cellText(sc, k).padEnd(W));
  console.log([`${sc.id}${sc.study ? ` #${sc.study}` : ''}`.padEnd(12), typesOf(sc).join('/').padEnd(11), ...cells, (sc.errors || []).join(', ')].join(''));
}

console.log('\nStash scenarios (Current + Stash preset, proposed)\n');
for (const sc of STASH_SCENARIOS) console.log([sc.id.padEnd(12), typesOf(sc).join('/').padEnd(11), cellText(sc, 'stash').padEnd(W), sc.title].join(''));

console.log('\nMigration scenarios\n');
for (const sc of MIGRATION_SCENARIOS) {
  const cells = sc.cases.map((c) => {
    const r = runMigrationCase(sc, c);
    if (!r.match) {
      mismatches += 1;
      console.error(`  ✗ ${sc.id} (${c.label}): expected ${c.expect}, got ${r.got}: ${r.notes.join(' | ')}`);
    }
    return `${c.label}: ${r.status}`;
  });
  console.log([sc.id.padEnd(12), cells.join('   ').padEnd(58), sc.title].join(''));
}

console.log('\nErrors the Current ledger preset reproduces\n');
for (const e of ERROR_REGISTER) {
  const hit = [...(debtCells[e.n] || [])];
  console.log(`  ${String(e.n).padStart(2)}  ${hit.length ? 'reproduced' : 'NOT reproduced'}  ${e.title} [${e.status}] — ${hit.join(', ') || '-'} — ${e.needs}`);
}
console.log(`\n${mismatches ? `${mismatches} result(s) differ from the documented expectation` : 'Every result matches its documented expectation'}`);
process.exit(mismatches ? 1 : 0);
