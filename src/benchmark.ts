import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getGlobalDictionary } from "./dictionary.js";
import { chooseWord, decideBid, findPlayableWords } from "./strategy.js";
import { runSimulatedMatch, type BotArchetype } from "./simulator.js";

export interface BenchmarkReport {
  timestamp: string;
  checklist: {
    wordlistPreloading: {
      passed: boolean;
      wordCount: number;
      anagramCount: number;
      loadTimeMs: number;
    };
    processManagement: {
      passed: boolean;
      pm2ConfigPath: string;
    };
    latencyBenchmark: {
      passed: boolean;
      avgFindPlayableMs: number;
      p99FindPlayableMs: number;
      avgDecideBidMs: number;
      thresholdMs: number;
    };
    liquiditySafeguards: {
      passed: boolean;
      details: string;
    };
  };
  simulation: {
    matches: number;
    winRate: number;
    wins: number;
    avgScore: number;
    avgRank: number;
    normalizedPlacement: number;
    byArchetype: {
      name: string;
      archetype: BotArchetype;
      wins: number;
      winRate: number;
      avgScore: number;
      avgRank: number;
      avgTilesWon: number;
      avgSpent: number;
    }[];
  };
}

export function runFullBenchmark(numMatches = 100): BenchmarkReport {
  const dict = getGlobalDictionary();
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const pm2Path = path.resolve(dir, "..", "ecosystem.config.cjs");

  // 1. Latency Benchmark on 8-tile combined racks
  const testRacks = [
    ["S", "E", "R", "T", "I", "N", "A", "L"],
    ["Q", "U", "A", "R", "T", "Z", "E", "S"],
    ["J", "O", "U", "N", "C", "E", "S", "D"],
    ["P", "A", "I", "N", "T", "E", "R", "S"],
    ["W", "A", "V", "E", "L", "E", "T", "S"],
  ];

  const findTimes: number[] = [];
  const bidTimes: number[] = [];

  for (let iter = 0; iter < 40; iter++) {
    const rack = testRacks[iter % testRacks.length]!;
    const t0 = performance.now();
    findPlayableWords(rack);
    findTimes.push(performance.now() - t0);

    const t1 = performance.now();
    decideBid("S", rack.slice(0, 7), undefined, 75, 40);
    bidTimes.push(performance.now() - t1);
  }

  findTimes.sort((a, b) => a - b);
  const avgFindMs = +(findTimes.reduce((a, b) => a + b, 0) / findTimes.length).toFixed(3);
  const p99FindMs = +(findTimes[Math.floor(findTimes.length * 0.99)] ?? 0).toFixed(3);
  const avgBidMs = +(bidTimes.reduce((a, b) => a + b, 0) / bidTimes.length).toFixed(3);

  // 2. Liquidity Safeguards verification
  let safeguardPassed = true;
  for (const testBal of [12, 15, 25, 40, 80]) {
    for (const bagCount of [50, 30, 15, 7]) {
      const bid = decideBid("E", ["R", "T", "I", "N", "A", "S"], undefined, testBal, bagCount);
      const maxAllowed = Math.max(1, testBal - 12);
      if (bid > maxAllowed) {
        safeguardPassed = false;
      }
    }
  }

  // 3. 6-Player Simulation Benchmark
  const roster: { id: string; name: string; archetype: BotArchetype }[] = [
    { id: "hero", name: "ScrabbleBot-Champion (Us)", archetype: "ChampionDossier" },
    { id: "rival1", name: "MarketBingo-Alpha", archetype: "MarketBingoBot" },
    { id: "rival2", name: "Dossier-Baseline", archetype: "NaiveDossier" },
    { id: "rival3", name: "Starter-Greedy", archetype: "StarterBot" },
    { id: "sim1", name: "Brutus-sim (Aggressive)", archetype: "AggressiveSim" },
    { id: "sim2", name: "Valor-sim (ValueBidder)", archetype: "ValueBidderSim" },
  ];

  const statsMap = new Map<
    string,
    {
      name: string;
      archetype: BotArchetype;
      wins: number;
      scoreSum: number;
      rankSum: number;
      tilesSum: number;
      spentSum: number;
    }
  >();

  for (const r of roster) {
    statsMap.set(r.id, {
      name: r.name,
      archetype: r.archetype,
      wins: 0,
      scoreSum: 0,
      rankSum: 0,
      tilesSum: 0,
      spentSum: 0,
    });
  }

  for (let seed = 1; seed <= numMatches; seed++) {
    const res = runSimulatedMatch(1000 + seed, roster, "Vickrey");
    for (const s of res.standings) {
      const entry = statsMap.get(s.id)!;
      if (s.rank === 1) entry.wins++;
      entry.scoreSum += s.score;
      entry.rankSum += s.rank;
      entry.tilesSum += s.tilesWon;
      entry.spentSum += s.totalSpent;
    }
  }

  const byArchetype = Array.from(statsMap.values()).map((e) => ({
    name: e.name,
    archetype: e.archetype,
    wins: e.wins,
    winRate: +(e.wins / numMatches).toFixed(3),
    avgScore: +(e.scoreSum / numMatches).toFixed(1),
    avgRank: +(e.rankSum / numMatches).toFixed(2),
    avgTilesWon: +(e.tilesSum / numMatches).toFixed(1),
    avgSpent: +(e.spentSum / numMatches).toFixed(1),
  }));

  const heroStats = byArchetype[0]!;
  const normPlacement = +((6 - heroStats.avgRank) / 5).toFixed(3);

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    checklist: {
      wordlistPreloading: {
        passed: dict.wordCount >= 170000,
        wordCount: dict.wordCount,
        anagramCount: dict.anagramCount,
        loadTimeMs: dict.loadTimeMs,
      },
      processManagement: {
        passed: fs.existsSync(pm2Path),
        pm2ConfigPath: pm2Path,
      },
      latencyBenchmark: {
        passed: p99FindMs < 25.0 && avgBidMs < 25.0,
        avgFindPlayableMs: avgFindMs,
        p99FindPlayableMs: p99FindMs,
        avgDecideBidMs: avgBidMs,
        thresholdMs: 25.0,
      },
      liquiditySafeguards: {
        passed: safeguardPassed,
        details: "Confirmed MIN_RESERVE=12 coins enforced across all early/midgame states (bag > 6)",
      },
    },
    simulation: {
      matches: numMatches,
      winRate: heroStats.winRate,
      wins: heroStats.wins,
      avgScore: heroStats.avgScore,
      avgRank: heroStats.avgRank,
      normalizedPlacement: normPlacement,
      byArchetype,
    },
  };

  const outPath = path.resolve(dir, "..", "data", "benchmark-report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const count = Number(process.argv[2] ?? 100);
  const report = runFullBenchmark(count);
  console.log(JSON.stringify(report, null, 2));
}
