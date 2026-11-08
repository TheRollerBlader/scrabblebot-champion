import assert from "node:assert/strict";
import {
  LETTER_VALUES,
  getLengthMultiplier,
  calculateWordScore,
  findPlayableWords,
  evaluateRackQuality,
  chooseWord,
  decideBid,
} from "../src/strategy.js";
import { getGlobalDictionary } from "../src/dictionary.js";
import { CardCounterStateTracker } from "../src/stateTracker.js";
import { runFullBenchmark } from "../src/benchmark.js";

console.log("[Test] Running ScrabbleBot Dossier Verification Suite...");

// 1. Wordlist preloading & size check
const dict = getGlobalDictionary();
assert.ok(dict.wordCount >= 170000, `Expected >=170k words, got ${dict.wordCount}`);

// 2. Scoring and multiplier rules (Dossier Section 1 & 4)
assert.equal(getLengthMultiplier(3), 1.0);
assert.equal(getLengthMultiplier(4), 1.5);
assert.equal(getLengthMultiplier(5), 2.0);
assert.equal(getLengthMultiplier(6), 2.5);
assert.equal(getLengthMultiplier(7), 3.0);
assert.equal(getLengthMultiplier(8), 3.0);
assert.equal(LETTER_VALUES["Q"], 10);
assert.equal(LETTER_VALUES["Z"], 10);
assert.equal(calculateWordScore("QUARTZ"), Math.floor((10 + 1 + 1 + 1 + 1 + 10) * 2.5)); // 24 * 2.5 = 60

// 3. Sub-millisecond findPlayableWords latency (< 25ms requirement)
const t0 = performance.now();
const playable = findPlayableWords(["S", "E", "R", "T", "I", "N", "A", "L"]);
const elapsed = performance.now() - t0;
assert.ok(playable.length > 100, "Expected >100 playable words from SERTINAL");
assert.ok(elapsed < 25, `Expected findPlayableWords < 25ms, took ${elapsed.toFixed(2)}ms`);

// 4. Dossier chooseWord rules: refuse <= 4L in normal conditions, allow in emergency
const shortOnlyRack = ["C", "A", "T", "S"];
assert.equal(
  chooseWord(shortOnlyRack, undefined, 80, 40),
  null,
  "Should refuse <= 4-letter word under normal conditions (balance >= 10, bag > 10)"
);
const emergencyWord = chooseWord(shortOnlyRack, undefined, 6, 40);
assert.ok(
  emergencyWord !== null && ["ACTS", "CAST", "CATS", "SCAT"].includes(emergencyWord),
  `Should play a valid 4-letter anagram during emergency liquidity (balance < 10), got ${emergencyWord}`
);
const endgameWord = chooseWord(shortOnlyRack, undefined, 80, 8);
assert.ok(
  endgameWord !== null && ["ACTS", "CAST", "CATS", "SCAT"].includes(endgameWord),
  `Should play a valid 4-letter anagram during endgame (bag <= 10), got ${endgameWord}`
);

// 5. Dossier decideBid liquidity safeguard: MIN_RESERVE = 12 when bag > 6
const tracker = new CardCounterStateTracker("test-match");
tracker.recordOwnInitialRack(["R", "E", "T", "I", "N", "A"]);
const bidAt20 = decideBid("S", ["R", "E", "T", "I", "N", "A"], undefined, 20, 30, tracker);
assert.ok(bidAt20 <= 8, `Expected bid <= 20 - 12 = 8, got ${bidAt20}`);

const bidEndgame = decideBid("S", ["R", "E", "T", "I", "N", "A"], undefined, 20, 4, tracker);
assert.ok(bidEndgame > 8, `Expected aggressive endgame bid (>8) when bag <= 6, got ${bidEndgame}`);

// 6. Full 6-player tournament benchmark verification (>= 40% win rate target)
const report = runFullBenchmark(60);
assert.ok(
  report.simulation.winRate >= 0.4,
  `Expected simulation win rate >= 40%, got ${(report.simulation.winRate * 100).toFixed(1)}%`
);
assert.ok(report.checklist.latencyBenchmark.passed, "Latency benchmark must pass (<25ms)");
assert.ok(report.checklist.liquiditySafeguards.passed, "Liquidity safeguard must pass");

console.log(
  `[Test] ALL TESTS PASSED! Win Rate=${(report.simulation.winRate * 100).toFixed(1)}% | Avg FindPlayable=${report.checklist.latencyBenchmark.avgFindPlayableMs}ms`
);
