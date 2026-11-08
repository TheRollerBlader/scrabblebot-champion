// strategy.ts - Production Strategy Implementation for ScrabbleBot
// Implements the ScrabbleBot Master Strategy & Architecture Dossier
// with Sub-Millisecond Bitmask/Histogram Lookup, Card-Counted Out-Distribution,
// Multi-Word DP Liquidation, and Cash-Recycling Vickrey Calibration.

import {
  LETTER_VALUES,
  LETTER_VALUES_ARRAY,
  getLengthMultiplier,
  calculateWordScore,
  FastDictionaryEngine,
  getGlobalDictionary,
  rackToHistogram,
} from "./dictionary.js";
import {
  CardCounterStateTracker,
  EMPIRICAL_MARKET_PRICES,
  STANDARD_BAG_DISTRIBUTION,
} from "./stateTracker.js";

export { LETTER_VALUES, getLengthMultiplier, calculateWordScore };

const BINGO_LEAVES = new Set(["S", "E", "R", "T", "I", "N", "A"]);
const VOWELS = new Set(["A", "E", "I", "O", "U"]);
const POWER_TILES = new Set(["J", "Q", "X", "Z"]);
const SEMI_POWER_TILES = new Set(["K", "F", "H", "V", "W", "Y"]);

let lastCustomDictRef: string[] | null = null;
let lastCustomEngine: FastDictionaryEngine | null = null;

function resolveEngine(dictionary?: string[]): FastDictionaryEngine {
  const globalDict = getGlobalDictionary();
  if (
    !dictionary ||
    dictionary.length === 0 ||
    Math.abs(dictionary.length - globalDict.wordCount) <= 100
  ) {
    return globalDict;
  }
  if (dictionary === lastCustomDictRef && lastCustomEngine) {
    return lastCustomEngine;
  }
  lastCustomDictRef = dictionary;
  lastCustomEngine = new FastDictionaryEngine(dictionary);
  return lastCustomEngine;
}

/**
 * Finds all playable words from `rack` using the pre-indexed 26-element byte array
 * histograms and 26-bit presence bitmasks (completes in < 0.5ms for 8-tile racks).
 */
export function findPlayableWords(rack: string[], dictionary?: string[]): string[] {
  const engine = resolveEngine(dictionary);
  return engine.findPlayableWords(rack);
}

/**
 * Dossier Section 4: Rack Quality Evaluator.
 * Rewards retaining premium bingo components (S, E, R, T, I, N, A)
 * and penalizes unplayable clunky high-point tiles.
 */
export function evaluateRackQuality(rack: string[]): number {
  let score = 0;
  for (const tile of rack) {
    const t = tile.toUpperCase();
    if (BINGO_LEAVES.has(t)) score += 3;
    if (t === "Q" || t === "Z" || t === "J" || t === "X") score -= 4;
  }
  return score;
}

/**
 * Enhanced leave quality evaluator used for Rack Retention Optimization (Rule 3)
 * and ExpectedRackValue calculation.
 */
export function evaluateAdvancedLeaveQuality(rackHist: Uint8Array, totalTiles: number): number {
  if (totalTiles === 0) return 0;
  let score = 0;
  let vowels = 0;
  let consonants = 0;

  for (let i = 0; i < 26; i++) {
    const count = rackHist[i]!;
    if (count === 0) continue;
    const ch = String.fromCharCode(65 + i);

    if (BINGO_LEAVES.has(ch)) {
      score += 3.5 + (count - 1) * 1.2;
    }
    if (VOWELS.has(ch)) {
      vowels += count;
    } else {
      consonants += count;
    }

    if (count >= 2 && ch !== "E" && ch !== "S") {
      score -= (count - 1) * (LETTER_VALUES_ARRAY[i]! >= 4 ? 5.0 : 2.5);
    }

    if (ch === "Q") {
      const hasU = rackHist[20]! > 0;
      score += hasU ? 6.5 : -4.0;
    } else if (ch === "J" || ch === "X" || ch === "Z") {
      score += vowels >= 1 && totalTiles <= 8 ? 4.5 : -3.0;
    } else if (SEMI_POWER_TILES.has(ch) && count === 1) {
      score += 2.5;
    }
  }

  if (totalTiles >= 3) {
    const vowelRatio = vowels / totalTiles;
    if (vowelRatio >= 0.3 && vowelRatio <= 0.55) {
      score += 3.5;
    } else if (vowels === 0 || consonants === 0) {
      score -= 5.0;
    }
  }

  return score;
}

export interface RackValuationBreakdown {
  bestImmediateScore: number;
  bestQualifyingScore: number;
  bestMultiWordScore: number;
  oneTileCompletionEV: number;
  twoTileBingoEV: number;
  outTileCount: number;
  leaveQuality: number;
  totalExpectedValue: number;
}

/**
 * Computes the Expected Rack Value of a rack using exact multi-word packing
 * and Card-Counted 1-tile ("Out-Count") and 2-tile stem completion probabilities.
 */
export function evaluateExpectedRackValue(
  rack: string[],
  engine: FastDictionaryEngine,
  remainingBagCount: number,
  tracker?: CardCounterStateTracker
): RackValuationBreakdown {
  const { hist, mask, total } = rackToHistogram(rack);
  const emergencyEndgame = remainingBagCount <= 10;
  const playableGroups = engine.findPlayableGroups(hist, mask, total);

  let bestImmediateScore = 0;
  let bestQualifyingScore = 0;
  let bestMultiWordScore = 0;

  const residualHist = new Uint8Array(26);

  for (let i = 0; i < playableGroups.length; i++) {
    const g = playableGroups[i]!;
    if (g.score > bestImmediateScore) {
      bestImmediateScore = g.score;
    }
    // Dossier Rule 2: Target >= 2.5x (6L) or 3.0x (7+L), or high-value >= 28pt 5L word
    if (emergencyEndgame || g.length >= 6 || (g.length === 5 && g.score >= 28)) {
      if (g.score > bestQualifyingScore) {
        bestQualifyingScore = g.score;
      }
    }

    if (total - g.length >= 2 && i < 20) {
      let remMask = 0;
      const remTotal = total - g.length;
      for (let c = 0; c < 26; c++) {
        const rem = hist[c]! - g.histogram[c]!;
        residualHist[c] = rem;
        if (rem > 0) remMask |= 1 << c;
      }
      const tailGroups = engine.findPlayableGroups(residualHist, remMask, remTotal);
      let tailScore = 0;
      for (let t = 0; t < tailGroups.length; t++) {
        const tg = tailGroups[t]!;
        if (emergencyEndgame || tg.length >= 5 || remainingBagCount <= 14) {
          tailScore = tg.score;
          break;
        }
      }
      const packed = g.score + tailScore;
      if (packed > bestMultiWordScore) {
        bestMultiWordScore = packed;
      }
    } else if (g.score > bestMultiWordScore) {
      bestMultiWordScore = g.score;
    }
  }

  let oneTileCompletionEV = 0;
  let twoTileBingoEV = 0;
  let outTileCount = 0;

  if (remainingBagCount > 0 && total >= 2 && total <= 11) {
    const stems = engine.bingoAndHighYieldStems;
    const maxStemsToScan = Math.min(stems.length, 3200);
    const unseenTotal = tracker ? Math.max(1, tracker.totalUnseenTiles()) : 85;

    const best1ByLetter = new Int32Array(26);
    const best2ByLetter = new Int32Array(26);
    const count2ByLetter = new Int32Array(26);

    for (let s = 0; s < maxStemsToScan; s++) {
      const stem = stems[s]!;
      if (stem.length < 6 && stem.score < 28) continue;
      if (stem.score <= bestQualifyingScore + 2) break;

      const sHist = stem.histogram;
      let missing = 0;
      let m1 = -1;
      let m2 = -1;

      for (let c = 0; c < 26; c++) {
        const diff = sHist[c]! - hist[c]!;
        if (diff > 0) {
          missing += diff;
          if (missing > 2) break;
          if (m1 === -1) {
            m1 = c;
            if (diff === 2) m2 = c;
          } else {
            m2 = c;
          }
        }
      }

      if (missing === 1 && m1 >= 0) {
        const u1 = tracker
          ? tracker.unseenCounts[m1]!
          : STANDARD_BAG_DISTRIBUTION[String.fromCharCode(65 + m1)] ?? 1;
        if (u1 > 0 && stem.score > best1ByLetter[m1]!) {
          best1ByLetter[m1] = stem.score;
        }
      } else if (missing === 2 && m1 >= 0 && m2 >= 0 && remainingBagCount >= 6) {
        const u1 = tracker
          ? tracker.unseenCounts[m1]!
          : STANDARD_BAG_DISTRIBUTION[String.fromCharCode(65 + m1)] ?? 1;
        const u2 = tracker
          ? m1 === m2
            ? Math.max(0, tracker.unseenCounts[m1]! - 1)
            : tracker.unseenCounts[m2]!
          : STANDARD_BAG_DISTRIBUTION[String.fromCharCode(65 + m2)] ?? 1;
        if (u1 > 0 && u2 > 0) {
          if (stem.score > best2ByLetter[m1]!) best2ByLetter[m1] = stem.score;
          if (stem.score > best2ByLetter[m2]!) best2ByLetter[m2] = stem.score;
          count2ByLetter[m1]!++;
          if (m2 !== m1) count2ByLetter[m2]!++;
        }
      }
    }

    let weightedGain1Sum = 0;
    for (let c = 0; c < 26; c++) {
      const s1 = best1ByLetter[c]!;
      const gain = s1 - bestQualifyingScore;
      if (gain > 4) {
        const copies = tracker
          ? tracker.unseenCounts[c]!
          : STANDARD_BAG_DISTRIBUTION[String.fromCharCode(65 + c)] ?? 1;
        outTileCount += copies;
        weightedGain1Sum += copies * gain;
      }
    }

    if (outTileCount > 0) {
      const avgGain1 = weightedGain1Sum / outTileCount;
      const horizon = Math.min(remainingBagCount, 18);
      const hitProb = 1 - Math.pow(Math.max(0, 1 - outTileCount / unseenTotal), horizon * 0.45);
      oneTileCompletionEV = avgGain1 * hitProb;
    }

    let weightedGain2Sum = 0;
    let twoStepOuts = 0;
    for (let c = 0; c < 26; c++) {
      const s2 = best2ByLetter[c]!;
      const gain2 = s2 - Math.max(bestQualifyingScore, best1ByLetter[c]!);
      if (gain2 > 6) {
        const copies = tracker
          ? tracker.unseenCounts[c]!
          : STANDARD_BAG_DISTRIBUTION[String.fromCharCode(65 + c)] ?? 1;
        const richness = Math.min(3, 1 + count2ByLetter[c]! * 0.12);
        twoStepOuts += copies;
        weightedGain2Sum += copies * gain2 * richness;
      }
    }

    if (twoStepOuts > 0 && remainingBagCount >= 8) {
      const avgGain2 = weightedGain2Sum / twoStepOuts;
      const horizon2 = Math.min(remainingBagCount, 28);
      const hitProb2 = Math.min(0.55, (twoStepOuts / unseenTotal) * (horizon2 / 24) * 0.42);
      twoTileBingoEV = avgGain2 * hitProb2;
    }
  }

  const leaveQuality = evaluateAdvancedLeaveQuality(hist, total);
  const baseAnchor = Math.max(
    bestQualifyingScore,
    bestMultiWordScore * (emergencyEndgame ? 1.0 : 0.88),
    bestImmediateScore * (emergencyEndgame ? 1.0 : 0.45)
  );
  const totalExpectedValue =
    baseAnchor + oneTileCompletionEV + twoTileBingoEV + leaveQuality * 0.7;

  return {
    bestImmediateScore,
    bestQualifyingScore,
    bestMultiWordScore,
    oneTileCompletionEV,
    twoTileBingoEV,
    outTileCount,
    leaveQuality,
    totalExpectedValue,
  };
}

/**
 * Dossier Section 3A & 4: When to Play Words (chooseWord)
 *
 * - Rule 1 (Length Threshold): Refuse to play words <= 4 letters under normal conditions.
 *   Exceptions are triggered only when capital falls below 10 coins (emergency liquidity)
 *   or during the endgame state (bag size <= 10 tiles).
 * - Rule 2 (Target Multiplier Thresholds): Prioritize banking words that achieve >= 2.5x
 *   (6 letters) or 3.0x (7+ letters) multipliers. Avoid burning 5 tiles on low-scoring
 *   5-letter words when we have capital to extend them to 6-7 letter bingos!
 * - Rule 3 (Rack Retention Optimization): Maximize the quality of remaining tiles after a
 *   word is played by retaining premium bingo components (S, E, R, T, I, N, A).
 */
export function chooseWord(
  rack: string[],
  dictionary?: string[],
  balance = 100,
  remainingBagCount = 50,
  tracker?: CardCounterStateTracker
): string | null {
  const engine = resolveEngine(dictionary);
  const { hist, mask, total } = rackToHistogram(rack);
  if (total < 2) return null;

  const playableGroups = engine.findPlayableGroups(hist, mask, total);
  if (playableGroups.length === 0) return null;

  const emergencyMode = balance < 10 || remainingBagCount <= 10;

  let bestWord: string | null = null;
  let bestSelectionMetric = -Infinity;
  let bestRawScore = -1;
  let bestLen = 0;

  const residualHist = new Uint8Array(26);

  for (let i = 0; i < playableGroups.length; i++) {
    const group = playableGroups[i]!;
    const len = group.length;

    // Rule 1: Refuse to play words <= 4 letters under normal conditions
    if (!emergencyMode && len <= 4) continue;

    // Rule 2: Prioritize >= 2.5x (6L) or 3.0x (7+L) multipliers when flush with cash & outs,
    // but recycle 5-letter (2.0x) words immediately whenever we need liquidity (balance < 30)
    // or have a 7+ tile rack so the cash-recycling flywheel never stalls!
    if (
      !emergencyMode &&
      remainingBagCount > 16 &&
      balance >= 32 &&
      total <= 6 &&
      len === 5 &&
      group.score < 22
    ) {
      const ev = evaluateExpectedRackValue(rack, engine, remainingBagCount, tracker);
      if (ev.outTileCount >= 5) {
        continue;
      }
    }

    // Never waste a power tile (J/Q/X/Z) on a low-scoring 5-letter word (< 30 pts) when flush
    if (
      !emergencyMode &&
      remainingBagCount > 14 &&
      balance >= 24 &&
      len <= 5 &&
      group.score < 30 &&
      /[JQXZ]/.test(group.bestWord)
    ) {
      continue;
    }

    // Compute residual rack after playing this word (Rule 3: Rack Retention Optimization)
    let remMask = 0;
    const remTotal = total - len;
    for (let c = 0; c < 26; c++) {
      const rem = hist[c]! - group.histogram[c]!;
      residualHist[c] = rem;
      if (rem > 0) remMask |= 1 << c;
    }

    const leaveQuality = evaluateAdvancedLeaveQuality(residualHist, remTotal);

    let residualWordBonus = 0;
    if (remTotal >= 2) {
      const tailGroups = engine.findPlayableGroups(residualHist, remMask, remTotal);
      for (let t = 0; t < tailGroups.length; t++) {
        const tg = tailGroups[t]!;
        if (emergencyMode || tg.length >= 6 || tg.score >= 28) {
          residualWordBonus = tg.score * (remainingBagCount <= 8 ? 1.0 : 0.8);
          break;
        }
      }
    }

    const multiplierTierBonus = len >= 7 ? 9 : len === 6 ? 4 : 0;
    const leaveWeight = remainingBagCount <= 4 ? 0.1 : 0.75;
    const metric =
      group.score + multiplierTierBonus + residualWordBonus + leaveQuality * leaveWeight;

    if (
      metric > bestSelectionMetric ||
      (metric === bestSelectionMetric && group.score > bestRawScore)
    ) {
      bestSelectionMetric = metric;
      bestRawScore = group.score;
      bestWord = group.bestWord;
      bestLen = len;
    }
  }

  if (!bestWord) return null;

  // If we have a 6-letter word of 1-pt tiles (score <= 20) in early/midgame and strong 1-tile outs
  // to a 7-letter 3.0x bingo, hold while we have cash (>= 28) to grab the 7th tile!
  if (
    !emergencyMode &&
    remainingBagCount > 16 &&
    balance >= 28 &&
    total <= 7 &&
    bestLen === 6 &&
    bestRawScore <= 20
  ) {
    const ev = evaluateExpectedRackValue(rack, engine, remainingBagCount, tracker);
    if (ev.outTileCount >= 6) {
      return null;
    }
  }

  return bestWord;
}

/**
 * Dossier Section 3B & 4: Dynamic Marginal Tile Valuation (decideBid)
 */
export function decideBid(
  revealedTile: string,
  currentRack: string[],
  dictionary?: string[],
  balance = 100,
  remainingBagCount = 50,
  tracker?: CardCounterStateTracker,
  auctionType: "Vickrey" | "FirstPrice" = "Vickrey",
  myScore = 0
): number {
  const MIN_RESERVE = 12;
  const RESERVE = remainingBagCount <= 6 ? 0 : MIN_RESERVE;
  const availableCapital = Math.max(0, balance - RESERVE);

  if (balance <= 0) return 0;
  if (availableCapital <= 1 && remainingBagCount > 6) return Math.min(balance, 1);

  const cleanTile = revealedTile.trim().toUpperCase();
  if (!cleanTile) return 1;

  if (remainingBagCount === 0) {
    return Math.min(balance, 1);
  }

  const engine = resolveEngine(dictionary);
  const potentialRack = [...currentRack, cleanTile];

  // 1. Dossier base scores & rack quality delta
  const currentWords = engine.findPlayableWords(currentRack);
  const currentBestScore = currentWords.reduce(
    (max, w) => Math.max(max, calculateWordScore(w)),
    0
  );

  const potentialWords = engine.findPlayableWords(potentialRack);
  const potentialBestScore = potentialWords.reduce(
    (max, w) => Math.max(max, calculateWordScore(w)),
    0
  );

  const currentQuality = evaluateRackQuality(currentRack);
  const potentialQuality = evaluateRackQuality(potentialRack);

  const marginalScoreGain = potentialBestScore - currentBestScore;
  const qualityDelta = potentialQuality - currentQuality;

  // 2. Full ExpectedRackValue delta (multi-word packing + 1-tile Out-Count + 2-tile stems)
  const currentEV = evaluateExpectedRackValue(currentRack, engine, remainingBagCount, tracker);
  const potentialEV = evaluateExpectedRackValue(potentialRack, engine, remainingBagCount, tracker);

  const expectedValueDelta = Math.max(
    0,
    potentialEV.totalExpectedValue - currentEV.totalExpectedValue
  );
  const qualifyingGain = Math.max(
    0,
    potentialEV.bestQualifyingScore - currentEV.bestQualifyingScore
  );
  const multiWordGain = Math.max(
    0,
    potentialEV.bestMultiWordScore - currentEV.bestMultiWordScore
  );
  const outIncrease = Math.max(0, potentialEV.outTileCount - currentEV.outTileCount);

  // 3. Base Dossier formula
  let rawBid = 1;
  if (marginalScoreGain > 0 || qualifyingGain > 0) {
    const effectiveGain = Math.max(marginalScoreGain, qualifyingGain, multiWordGain);
    rawBid = Math.floor(effectiveGain * 0.65) + qualityDelta;
  } else {
    rawBid = Math.max(1, Math.floor(qualityDelta));
  }

  const { hist, total } = rackToHistogram(currentRack);
  const tileCode = cleanTile.charCodeAt(0) - 65;
  const existingCopies = tileCode >= 0 && tileCode < 26 ? hist[tileCode]! : 0;
  const marketPrice = tracker
    ? tracker.estimatedMarketPrice(cleanTile)
    : EMPIRICAL_MARKET_PRICES[cleanTile] ?? 11;

  let vowelCount = 0;
  for (const v of ["A", "E", "I", "O", "U"]) {
    vowelCount += hist[v.charCodeAt(0) - 65]!;
  }
  const isVowel = VOWELS.has(cleanTile);
  const needsVowel = isVowel && (vowelCount <= 1 || vowelCount / Math.max(1, total) < 0.36);
  const needsConsonant = !isVowel && total >= 3 && vowelCount / total > 0.55;

  const paceCap = Math.max(4, Math.floor(availableCapital / 4.2));

  // Case A: Tile immediately completes or upgrades a bankable >= 5L word
  if (qualifyingGain >= 14 || (potentialEV.bestQualifyingScore >= 24 && qualifyingGain >= 8)) {
    const immediateCompletionBid = Math.round(
      Math.max(
        marketPrice + Math.min(8, Math.floor(qualifyingGain * 0.35)),
        qualifyingGain * 0.78
      )
    );
    rawBid = Math.max(rawBid, Math.min(availableCapital, immediateCompletionBid));
  }

  // Case B: Tile creates strong 1-tile completion Outs (`missing: 2 -> 1`) or EV jump
  if (expectedValueDelta >= 3.5 || outIncrease >= 3) {
    const stemBridgeBid = Math.min(
      paceCap + 4,
      Math.round(
        Math.max(
          expectedValueDelta * 0.95,
          outIncrease >= 5 ? marketPrice + 2 : outIncrease >= 3 ? marketPrice : 0
        )
      )
    );
    rawBid = Math.max(rawBid, stemBridgeBid);
  }

  // Case C: Disciplined Rack Building & Vickrey Price Support (Dossier Section 3B & 3C)
  // Bid up to a bankroll-paced fraction of marketPrice so we win cheap tiles when rivals pass
  // and force aggressive rivals to pay 8-10 coins instead of 4 coins without draining our own reserve.
  if (remainingBagCount > 6 && existingCopies === 0 && total <= 8) {
    if (needsVowel && vowelCount === 0) {
      rawBid = Math.max(rawBid, Math.min(paceCap + 3, marketPrice + 2));
    } else if (needsVowel || BINGO_LEAVES.has(cleanTile)) {
      rawBid = Math.max(rawBid, Math.min(paceCap, Math.round(marketPrice * 0.85)));
    } else if (needsConsonant || (SEMI_POWER_TILES.has(cleanTile) && vowelCount >= 1)) {
      rawBid = Math.max(rawBid, Math.min(paceCap, Math.round(marketPrice * 0.75)));
    } else if (total <= 5) {
      rawBid = Math.max(rawBid, Math.min(paceCap, Math.round(marketPrice * 0.65)));
    }
  } else if (
    remainingBagCount > 8 &&
    existingCopies === 1 &&
    (BINGO_LEAVES.has(cleanTile) || isVowel) &&
    total <= 6
  ) {
    rawBid = Math.max(rawBid, Math.min(paceCap - 2, Math.floor(marketPrice * 0.55)));
  }

  // Cap redundant duplicates or high-cost power tiles that don't fit our current rack
  if (existingCopies >= 2 || (existingCopies === 1 && !BINGO_LEAVES.has(cleanTile) && !isVowel)) {
    if (qualifyingGain < 12 && marginalScoreGain < 14) {
      rawBid = Math.min(rawBid, 2);
    }
  }
  if (POWER_TILES.has(cleanTile) && qualifyingGain < 15 && outIncrease < 3) {
    // Dossier Section 3C: Do not engage in bidding wars for J/Q/X/Z unless they complete a big word
    rawBid = Math.min(rawBid, Math.min(paceCap, Math.round(marketPrice * 0.6)));
  }

  // First-Price auction shading
  if (auctionType === "FirstPrice" && rawBid > 2) {
    rawBid = Math.max(1, Math.min(rawBid, Math.round(marketPrice * 0.85), Math.round(rawBid * 0.78)));
  }

  // Endgame Depletion Phase (Dossier Section 3B & 4):
  // When bag count reaches <= 6 tiles, transition to an aggressive allocation strategy,
  // committing up to all remaining balance on final word completions.
  if (remainingBagCount <= 6 && (marginalScoreGain > 15 || qualifyingGain >= 6)) {
    return Math.min(balance, Math.max(1, rawBid * 2));
  }

  return Math.max(1, Math.min(availableCapital, rawBid));
}
