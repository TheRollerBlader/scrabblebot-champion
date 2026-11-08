import { LETTER_VALUES } from "./dictionary.js";

/**
 * Standard 98-tile Scrabble distribution (excluding blanks).
 */
export const STANDARD_BAG_DISTRIBUTION: Readonly<Record<string, number>> = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9,
  J: 1, K: 1, L: 4, M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6,
  S: 4, T: 6, U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1,
};

export const TOTAL_BAG_TILES = 98;

/**
 * Calibrated empirical market clearing prices (in coins) observed across
 * top-tier Vickrey matches on scrabblebot.spacetimedb.com.
 */
export const EMPIRICAL_MARKET_PRICES: Readonly<Record<string, number>> = {
  A: 11, B: 16, C: 17, D: 13, E: 12, F: 19, G: 13, H: 19, I: 11,
  J: 30, K: 22, L: 11, M: 16, N: 11, O: 10, P: 16, Q: 28, R: 12,
  S: 13, T: 11, U: 11, V: 17, W: 18, X: 32, Y: 20, Z: 36,
};

export interface OpponentState {
  botId: string;
  name?: string;
  balance: number;
  score: number;
  isSimulated: boolean;
  knownRack: Uint8Array; // Tiles publicly won in auctions and not yet played
  estimatedHiddenCount: number; // Remaining tiles from initial 5-tile deal
  wordsPlayed: { word: string; score: number }[];
  tilesWon: number;
  totalSpent: number;
}

/**
 * Subsystem B: Perfect State Tracking (Card Counting) & Opponent Hand Reconstructor.
 */
export class CardCounterStateTracker {
  readonly matchId: string;
  readonly unseenCounts: Uint8Array;
  readonly playedCounts: Uint8Array;
  readonly opponents = new Map<string, OpponentState>();
  readonly observedPaymentsByLetter = new Map<string, number[]>();
  readonly seenAuctionIds = new Set<string>();
  readonly seenWordPlayIds = new Set<string>();
  private initialRackRecorded = false;
  private returnUnsoldToBag: boolean;

  constructor(matchId = "default", returnUnsoldToBag = false) {
    this.matchId = matchId;
    this.returnUnsoldToBag = returnUnsoldToBag;
    this.unseenCounts = new Uint8Array(26);
    this.playedCounts = new Uint8Array(26);
    this.reset();
  }

  reset(): void {
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i);
      this.unseenCounts[i] = STANDARD_BAG_DISTRIBUTION[letter] ?? 0;
      this.playedCounts[i] = 0;
    }
    this.opponents.clear();
    this.observedPaymentsByLetter.clear();
    this.seenAuctionIds.clear();
    this.seenWordPlayIds.clear();
    this.initialRackRecorded = false;
  }

  /**
   * Decrement unseen counts for our own initial 5-tile rack.
   */
  recordOwnInitialRack(rack: readonly string[]): void {
    if (this.initialRackRecorded) return;
    this.initialRackRecorded = true;
    for (const tile of rack) {
      const idx = tile.toUpperCase().charCodeAt(0) - 65;
      if (idx >= 0 && idx < 26 && this.unseenCounts[idx]! > 0) {
        this.unseenCounts[idx]!--;
      }
    }
  }

  /**
   * Record an auction result broadcast from SpacetimeDB.
   */
  onAuctionResult(params: {
    auctionId: string;
    letter: string;
    winnerBotId: string | null | undefined;
    paid: number;
    myBotId?: string;
  }): void {
    const { auctionId, letter, winnerBotId, paid, myBotId } = params;
    if (this.seenAuctionIds.has(auctionId)) return;
    this.seenAuctionIds.add(auctionId);

    const idx = letter.toUpperCase().charCodeAt(0) - 65;
    if (idx >= 0 && idx < 26) {
      if (this.unseenCounts[idx]! > 0) {
        this.unseenCounts[idx]!--;
      }
      // If unsold and rules return unsold tiles to the bag pool, re-increment
      if ((winnerBotId === null || winnerBotId === undefined) && this.returnUnsoldToBag) {
        this.unseenCounts[idx]!++;
      }
    }

    if (winnerBotId !== null && winnerBotId !== undefined) {
      const cleanLetter = letter.toUpperCase();
      if (paid > 0) {
        const list = this.observedPaymentsByLetter.get(cleanLetter) ?? [];
        list.push(paid);
        this.observedPaymentsByLetter.set(cleanLetter, list);
      }

      if (winnerBotId !== myBotId) {
        const opp = this.getOrCreateOpponent(winnerBotId);
        opp.balance = Math.max(0, opp.balance - paid);
        opp.tilesWon++;
        opp.totalSpent += paid;
        if (idx >= 0 && idx < 26) {
          opp.knownRack[idx]!++;
        }
      }
    }
  }

  /**
   * Record a WordPlay broadcast from SpacetimeDB.
   * Reconstructs opponent hand states by removing played tiles from known won tiles;
   * any deficit must have come from their hidden initial rack (which also removes it from unseen pool!).
   */
  onWordPlay(params: {
    wordPlayId: string;
    botId: string;
    word: string;
    totalReward: number;
    myBotId?: string;
  }): void {
    const { wordPlayId, botId, word, totalReward, myBotId } = params;
    if (this.seenWordPlayIds.has(wordPlayId)) return;
    this.seenWordPlayIds.add(wordPlayId);

    const upper = word.toUpperCase();
    for (let i = 0; i < upper.length; i++) {
      const idx = upper.charCodeAt(i) - 65;
      if (idx >= 0 && idx < 26) {
        this.playedCounts[idx]!++;
      }
    }

    if (botId === myBotId) return;

    const opp = this.getOrCreateOpponent(botId);
    opp.score += totalReward;
    opp.balance += totalReward;
    opp.wordsPlayed.push({ word: upper, score: totalReward });

    for (let i = 0; i < upper.length; i++) {
      const idx = upper.charCodeAt(i) - 65;
      if (idx < 0 || idx >= 26) continue;
      if (opp.knownRack[idx]! > 0) {
        opp.knownRack[idx]!--;
      } else {
        // Tile came from opponent's hidden initial deal!
        opp.estimatedHiddenCount = Math.max(0, opp.estimatedHiddenCount - 1);
        if (this.unseenCounts[idx]! > 0) {
          this.unseenCounts[idx]!--;
        }
      }
    }
  }

  syncOpponentParticipant(params: {
    botId: string;
    balance: number;
    score: number;
    isSimulated?: boolean;
    name?: string;
  }): void {
    const opp = this.getOrCreateOpponent(params.botId);
    opp.balance = params.balance;
    opp.score = params.score;
    if (params.isSimulated !== undefined) opp.isSimulated = params.isSimulated;
    if (params.name !== undefined) opp.name = params.name;
  }

  private getOrCreateOpponent(botId: string): OpponentState {
    let opp = this.opponents.get(botId);
    if (!opp) {
      opp = {
        botId,
        balance: 100,
        score: 0,
        isSimulated: false,
        knownRack: new Uint8Array(26),
        estimatedHiddenCount: 5,
        wordsPlayed: [],
        tilesWon: 0,
        totalSpent: 0,
      };
      this.opponents.set(botId, opp);
    }
    return opp;
  }

  /**
   * Total unseen tiles across the remaining bag and hidden initial opponent racks.
   */
  totalUnseenTiles(): number {
    let sum = 0;
    for (let i = 0; i < 26; i++) sum += this.unseenCounts[i]!;
    return sum;
  }

  /**
   * Probability that a random unseen draw from the bag is `letter`.
   */
  letterDrawProbability(letter: string): number {
    const total = this.totalUnseenTiles();
    if (total <= 0) return 0;
    const idx = letter.toUpperCase().charCodeAt(0) - 65;
    if (idx < 0 || idx >= 26) return 0;
    return this.unseenCounts[idx]! / total;
  }

  /**
   * Expected number of copies of `letter` that will be revealed in the remaining `bagCount` auctions.
   */
  expectedFutureReveals(letter: string, remainingBagCount: number): number {
    return this.letterDrawProbability(letter) * Math.max(0, remainingBagCount);
  }

  /**
   * Dynamic market clearing price for `letter`, blending empirical priors with live match observations.
   */
  estimatedMarketPrice(letter: string): number {
    const clean = letter.toUpperCase();
    const prior = EMPIRICAL_MARKET_PRICES[clean] ?? (LETTER_VALUES[clean] || 1) + 8;
    const obs = this.observedPaymentsByLetter.get(clean);
    if (!obs || obs.length === 0) return prior;
    const sorted = [...obs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const weight = Math.min(0.7, obs.length * 0.25);
    return Math.round(prior * (1 - weight) + median * weight);
  }

  /**
   * Returns a snapshot of unseen tile frequencies for the live dashboard.
   */
  getUnseenDistributionSnapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i < 26; i++) {
      out[String.fromCharCode(65 + i)] = this.unseenCounts[i]!;
    }
    return out;
  }
}
