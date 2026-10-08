import { SCENARIOS, runScenario } from './scenarios.js';
import { PRESETS } from './engine.js';

// Prints the pass/fail matrix. Exits non-zero if Hardened fails anything, or if
// "As studied" fails a scenario that is not marked as known debt.
const names = Object.keys(PRESETS);
let failed = 0;
const tally = Object.fromEntries(names.map((n) => [n, 0]));
console.log(['scenario'.padEnd(30), ...names.map((n) => n.padEnd(12))].join(''));
for (const sc of SCENARIOS) {
  const row = names.map((n) => {
    const r = runScenario(sc, PRESETS[n].config);
    if (r.pass) tally[n]++;
    const debt = n === 'deployed' && !r.pass && sc.debt;
    if (!r.pass && !debt && n !== 'pseudocode') { failed++; console.error(`  ✗ ${sc.id} (${n}): ${r.notes.join(' | ')}`); }
    return (r.pass ? 'PASS' : debt ? 'debt' : 'fail').padEnd(12);
  });
  console.log([`${sc.study ? `#${sc.study} ` : ''}${sc.id}`.padEnd(30), ...row].join(''));
}
console.log(['passed'.padEnd(30), ...names.map((n) => `${tally[n]}/${SCENARIOS.length}`.padEnd(12))].join(''));
process.exit(failed ? 1 : 0);
