import {
  LETTER_VALUES,
  calculateWordScore,
  getGlobalDictionary,
  rackToHistogram,
} from "./dictionary.js";
import {
  CardCounterStateTracker,
  EMPIRICAL_MARKET_PRICES,
  STANDARD_BAG_DISTRIBUTION,
} from "./stateTracker.js";
import { chooseWord, decideBid, evaluateRackQuality } from "./strategy.js";

export type BotArchetype =
  | "ChampionDossier" // Our enhanced Dossier + Card-Counted Stem Valuation bot
  | "NaiveDossier"    // Literal page 4-7 Dossier snippet without stem/market calibration
  | "StarterBot"      // Official bot-starter greedy longest word + face+2 bidder
  | "MarketBingoBot"  // Top live rival archetype (market-price bidder + 36pt bingo hoarder)
  | "AggressiveSim"   // Server simulated bot: Aggressive
  | "ValueBidderSim"  // Server simulated bot: ValueBidder
  | "CheapskateSim";  // Server simulated bot: Cheapskate

export interface SimPlayer {
  id: string;
  name: string;
  archetype: BotArchetype;
  balance: number;
  score: number;
  rack: string[];
  wordsPlayed: { word: string; score: number; round: number }[];
  tilesWon: number;
  totalSpent: number;
  tracker: CardCounterStateTracker;
}

export interface SimulatedMatchResult {
  seed: number;
  winnerIds: string[];
  standings: {
    id: string;
    name: string;
    archetype: BotArchetype;
    score: number;
    balance: number;
    rank: number;
    tilesWon: number;
    totalSpent: number;
    wordsPlayed: { word: string; score: number; round: number }[];
  }[];
  totalRounds: number;
}

/**
 * Deterministic PRNG (Mulberry32) for reproducible multi-seed tournament benchmarks.
 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Runs a complete 6-player match following the exact SpacetimeDB server rules:
 * - 98-tile standard Scrabble bag (no blanks)
 * - 100 starting coins per bot
 * - 5 initial tiles dealt per bot (30 tiles dealt, 68 auctioned)
 * - Vickrey (second-price sealed-bid) auctions with reserve = 1
 */
export function runSimulatedMatch(
  seed: number,
  roster: { id: string; name: string; archetype: BotArchetype }[],
  auctionType: "Vickrey" | "FirstPrice" = "Vickrey"
): SimulatedMatchResult {
  const rng = createRng(seed);
  const engine = getGlobalDictionary();

  // Build 98-tile bag
  const bag: string[] = [];
  for (const [letter, count] of Object.entries(STANDARD_BAG_DISTRIBUTION)) {
    for (let i = 0; i < count; i++) bag.push(letter);
  }
  // Fisher-Yates shuffle
  for (let i = bag.length - 1; i >= 1; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = bag[i]!;
    bag[i] = bag[j]!;
    bag[j] = tmp;
  }

  const players: SimPlayer[] = roster.map((r) => ({
    id: r.id,
    name: r.name,
    archetype: r.archetype,
    balance: 100,
    score: 0,
    rack: [],
    wordsPlayed: [],
    tilesWon: 0,
    totalSpent: 0,
    tracker: new CardCounterStateTracker(`sim-${seed}-${r.id}`),
  }));

  // Deal 5 starting tiles to each participant
  for (const p of players) {
    for (let n = 0; n < 5; n++) {
      const tile = bag.pop();
      if (tile) p.rack.push(tile);
    }
    p.tracker.recordOwnInitialRack(p.rack);
  }

  let round = 0;
  let wordPlayCounter = 0;

  // Helper to execute word play for a player
  const attemptWordPlay = (p: SimPlayer, remainingBagCount: number) => {
    // A player can play multiple words in sequence if their rack allows it
    for (let step = 0; step < 3; step++) {
      if (p.rack.length < 2) break;
      const word = selectWordForArchetype(p, remainingBagCount);
      if (!word) break;

      // Verify and consume tiles from rack
      const tempRack = [...p.rack];
      let valid = true;
      for (let i = 0; i < word.length; i++) {
        const ch = word[i]!;
        const idx = tempRack.indexOf(ch);
        if (idx === -1) {
          valid = false;
          break;
        }
        tempRack.splice(idx, 1);
      }
      if (!valid || !engine.isValidWord(word)) break;

      p.rack = tempRack;
      const reward = calculateWordScore(word);
      p.score += reward;
      p.balance += reward;
      p.wordsPlayed.push({ word, score: reward, round });

      wordPlayCounter++;
      const wpId = `wp-${round}-${wordPlayCounter}`;
      for (const observer of players) {
        observer.tracker.onWordPlay({
          wordPlayId: wpId,
          botId: p.id,
          word,
          totalReward: reward,
          myBotId: observer.id,
        });
      }
    }
  };

  while (bag.length > 0) {
    round++;
    const revealedTile = bag.pop()!;
    const remainingBagCount = bag.length; // Excludes currently exposed tile, matching server `m.bagTotal`

    // External bots evaluate playing words before auction closes (especially when bagTotal === 0!)
    for (const p of players) {
      if (!p.archetype.endsWith("Sim")) {
        attemptWordPlay(p, remainingBagCount);
      }
    }

    // Collect sealed bids from all 6 bots
    const bids: { player: SimPlayer; amount: number }[] = [];
    for (const p of players) {
      for (const other of players) {
        if (other.id !== p.id) {
          p.tracker.syncOpponentParticipant({
            botId: other.id,
            balance: other.balance,
            score: other.score,
            isSimulated: other.archetype.endsWith("Sim"),
            name: other.name,
          });
        }
      }
      const rawBid = computeBidForArchetype(p, revealedTile, remainingBagCount, auctionType, rng);
      const validBid = Math.max(0, Math.min(p.balance, Math.floor(rawBid)));
      if (validBid > 0) {
        bids.push({ player: p, amount: validBid });
      }
    }

    // Shuffle bids for random tie-breaking, then stable sort descending
    for (let i = bids.length - 1; i >= 1; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = bids[i]!;
      bids[i] = bids[j]!;
      bids[j] = tmp;
    }
    bids.sort((a, b) => b.amount - a.amount);

    let winner: SimPlayer | null = null;
    let paid = 0;

    if (bids.length > 0) {
      winner = bids[0]!.player;
      if (auctionType === "FirstPrice") {
        paid = bids[0]!.amount;
      } else {
        paid = bids.length >= 2 ? bids[1]!.amount : Math.min(1, bids[0]!.amount);
      }
      winner.balance -= paid;
      winner.rack.push(revealedTile);
      winner.tilesWon++;
      winner.totalSpent += paid;
    }

    // Broadcast AuctionResult to all state trackers
    const auctionId = `auc-${round}`;
    for (const observer of players) {
      observer.tracker.onAuctionResult({
        auctionId,
        letter: revealedTile,
        winnerBotId: winner ? winner.id : null,
        paid,
        myBotId: observer.id,
      });
    }

    // Server simulated bots play words inside `closeAuction` immediately upon winning
    // External bots play words on `myRack.onInsert / onUpdate` while match is still Running (bag.length > 0)
    if (winner) {
      if (winner.archetype.endsWith("Sim") || bag.length > 0) {
        attemptWordPlay(winner, remainingBagCount);
      }
    }
  }

  // Final standings
  const sorted = [...players].sort((a, b) => b.score - a.score);
  const topScore = sorted[0]?.score ?? 0;
  const winnerIds = sorted.filter((p) => p.score === topScore).map((p) => p.id);

  const standings = sorted.map((p, idx) => ({
    id: p.id,
    name: p.name,
    archetype: p.archetype,
    score: p.score,
    balance: p.balance,
    rank: sorted.findIndex((s) => s.score === p.score) + 1,
    tilesWon: p.tilesWon,
    totalSpent: p.totalSpent,
    wordsPlayed: p.wordsPlayed,
  }));

  return {
    seed,
    winnerIds,
    standings,
    totalRounds: round,
  };
}

function computeBidForArchetype(
  p: SimPlayer,
  letter: string,
  remainingBagCount: number,
  auctionType: "Vickrey" | "FirstPrice",
  rng: () => number
): number {
  const val = LETTER_VALUES[letter] || 1;
  switch (p.archetype) {
    case "ChampionDossier":
      return decideBid(
        letter,
        p.rack,
        undefined,
        p.balance,
        remainingBagCount,
        p.tracker,
        auctionType,
        p.score
      );

    case "NaiveDossier": {
      // Exact literal snippet from Dossier pages 6-7 without stem/market calibration
      const MIN_RESERVE = 12;
      const RESERVE = remainingBagCount <= 6 ? 0 : MIN_RESERVE;
      const availableCapital = Math.max(0, p.balance - RESERVE);
      if (availableCapital <= 1) return 1;
      const engine = getGlobalDictionary();
      const currentWords = engine.findPlayableWords(p.rack);
      const currentBestScore = currentWords.reduce(
        (max, w) => Math.max(max, calculateWordScore(w)),
        0
      );
      const potentialRack = [...p.rack, letter];
      const potentialWords = engine.findPlayableWords(potentialRack);
      const potentialBestScore = potentialWords.reduce(
        (max, w) => Math.max(max, calculateWordScore(w)),
        0
      );
      const marginalScoreGain = potentialBestScore - currentBestScore;
      const qualityDelta = evaluateRackQuality(potentialRack) - evaluateRackQuality(p.rack);
      let rawBid = 1;
      if (marginalScoreGain > 0) {
        rawBid = Math.floor(marginalScoreGain * 0.65) + qualityDelta;
      } else {
        rawBid = Math.max(1, Math.floor(qualityDelta));
      }
      if (remainingBagCount <= 6 && marginalScoreGain > 15) {
        return Math.min(p.balance, Math.max(1, rawBid * 2));
      }
      return Math.max(1, Math.min(availableCapital, rawBid));
    }

    case "StarterBot": {
      const have = p.rack.filter((c) => c === letter).length;
      const want = have === 0 ? val + 2 : Math.max(1, val);
      return Math.min(want, p.balance);
    }

    case "MarketBingoBot": {
      // Models standard live bots that bid around market price when lacking a letter
      const have = p.rack.filter((c) => c === letter).length;
      if (have >= 2 || p.balance <= 10) return 1;
      const mkt = EMPIRICAL_MARKET_PRICES[letter] ?? 10;
      const jitter = Math.floor(rng() * 5) - 2;
      const bid = have === 0 ? mkt + jitter : Math.floor(mkt * 0.5);
      return Math.max(1, Math.min(p.balance - 10, bid));
    }

    case "AggressiveSim": {
      const isVowel = "AEIOU".includes(letter);
      const jitter = Math.floor(rng() * 5) - 2;
      return Math.max(1, Math.min(p.balance, val + (isVowel ? 4 : 2) + jitter));
    }

    case "ValueBidderSim": {
      const jitter = Math.floor(rng() * 5) - 2;
      return Math.max(1, Math.min(p.balance, val + jitter));
    }

    case "CheapskateSim": {
      const jitter = Math.floor(rng() * 5) - 2;
      return Math.max(1, Math.min(p.balance, val - 1 + jitter));
    }
  }
}

function selectWordForArchetype(p: SimPlayer, remainingBagCount: number): string | null {
  const engine = getGlobalDictionary();
  switch (p.archetype) {
    case "ChampionDossier":
      return chooseWord(p.rack, undefined, p.balance, remainingBagCount, p.tracker);

    case "NaiveDossier": {
      const validWords = engine.findPlayableWords(p.rack);
      if (validWords.length === 0) return null;
      const emergencyMode = p.balance < 10 || remainingBagCount <= 10;
      let bestWord: string | null = null;
      let maxScore = -1;
      for (const word of validWords) {
        if (!emergencyMode && word.length <= 4) continue;
        const score = calculateWordScore(word);
        if (score > maxScore) {
          maxScore = score;
          bestWord = word;
        }
      }
      return bestWord;
    }

    case "MarketBingoBot": {
      const { hist, mask, total } = rackToHistogram(p.rack);
      const groups = engine.findPlayableGroups(hist, mask, total);
      if (groups.length === 0) return null;
      if (remainingBagCount <= 8 || p.balance < 12) return groups[0]!.bestWord;
      const big = groups.find((g) => g.length >= 6 || g.score >= 32);
      return big ? big.bestWord : null;
    }

    case "StarterBot": {
      const { hist, mask, total } = rackToHistogram(p.rack);
      const groups = engine.findPlayableGroups(hist, mask, total);
      if (groups.length === 0) return null;
      groups.sort((a, b) => b.length - a.length || b.score - a.score);
      return groups[0]!.bestWord;
    }

    case "AggressiveSim":
    case "ValueBidderSim":
    case "CheapskateSim": {
      const { hist, mask, total } = rackToHistogram(p.rack);
      const groups = engine.findPlayableGroups(hist, mask, total);
      const valid = groups.filter((g) => g.length >= 3);
      if (valid.length === 0) return null;
      valid.sort((a, b) => b.length - a.length || (a.bestWord < b.bestWord ? -1 : 1));
      return valid[0]!.bestWord;
    }
  }
}
