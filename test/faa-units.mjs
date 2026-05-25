// Regression guard for the FAA "mL vs L" parsing bug.
// Pre-fix, `"4600 ml".includes("l")` returned true (matching the L in "mL"),
// causing the parser to treat 4600 mL as 4600 L on Dashboard, Cashflow and
// Advisor — a 1000× overstatement of FAA needs.
//
// This is a *contract* test: the helper below mirrors the inline logic now
// living in public/index.html. If you change the parser there, mirror it
// here so the test keeps protecting the invariant.

const failed = [];
function check(label, cond) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label);
  if (!cond) failed.push(label);
}

// Mirror of the FIXED parser shape in public/index.html (3 call sites).
function parseFaaAmountToLiters(rawAmt) {
  const num = parseFloat(rawAmt) || 0;
  const amt = (rawAmt || '').toLowerCase();
  // Check "ml" BEFORE "l" — "ml".includes("l") is true.
  return amt.includes('ml') ? num / 1000 : num;
}

check('"4600 mL" parses to 4.6 L',     parseFaaAmountToLiters('4600 mL')      === 4.6);
check('"3400 mL" parses to 3.4 L',     parseFaaAmountToLiters('3400 mL')      === 3.4);
check('"4.6 L"   parses to 4.6 L',     parseFaaAmountToLiters('4.6 L')        === 4.6);
check('"4.6 l"   parses to 4.6 L',     parseFaaAmountToLiters('4.6 l')        === 4.6);
check('"500 ml"  parses to 0.5 L',     parseFaaAmountToLiters('500 ml')       === 0.5);
check('"2 L"     parses to 2 L',       parseFaaAmountToLiters('2 L')          === 2);
check('"5"       parses to 5 (unit-less defaults to L)',
  parseFaaAmountToLiters('5')          === 5);
check('case-insensitive: "1000 ML" → 1 L', parseFaaAmountToLiters('1000 ML')  === 1);

// The bug we caught: pre-fix this returned 4600 because amt.includes("l")
// was true via the "l" in "ml", skipping the mL→L conversion.
check('REGRESSION: "4600 mL" must NOT parse to 4600',
  parseFaaAmountToLiters('4600 mL')    !== 4600);

if (failed.length) {
  console.log('\n' + failed.length + ' check(s) failed.');
  process.exit(1);
} else {
  console.log('\nAll FAA-unit checks passed.');
}
