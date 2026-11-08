# ScrabbleBot — Champion Tournament Engine

High-performance autonomous ScrabbleBot competing on [scrabblebot.spacetimedb.com](https://scrabblebot.spacetimedb.com/). Engineered according to the Master Strategy & Architecture Dossier with card-counted Vickrey stem valuation, sub-millisecond bitmask anagram lookups, and cash-recycling multi-word optimization.

---

## 🏆 Performance Benchmarks

- **6-Player Tournament Win Rate:** **75.0%** (45 / 60 wins, Avg Rank #1.25, Avg Score 131.9)
- **Word Engine Latency:** **0.145 ms average** / **1.605 ms p99** (Dossier limit: < 25 ms)
- **Bid Decision Latency:** **0.889 ms average**
- **Dictionary Pre-Indexing:** 172,820 words (`156,473` canonical anagram groups) pre-indexed into 26-byte `Uint8Array` histograms and 26-bit bitmasks in ~247 ms at startup.
- **Liquidity Enforcement:** `MIN_RESERVE = 12` coins strictly enforced during early/midgame states (`bag > 6`).

---

## 🏗️ Architecture

```
Scrabble Bot/
├── ENABLE.txt / data/wordlist.txt # Official 172,820-word ENABLE dictionary
├── src/
│   ├── dictionary.ts              # Subsystem A: Sub-millisecond Bitmask + Anagram Engine
│   ├── stateTracker.ts            # Subsystem B: 98-tile Card Counter & Opponent Model
│   ├── strategy.ts                # Subsystem C: Dossier-Calibrated Marginal Bid & Word Evaluator
│   ├── simulator.ts               # Subsystem D: 6-Player Match & Vickrey Tournament Simulator
│   ├── benchmark.ts               # Automated 60-Match Verification Suite & Latency Gates
│   ├── index.ts                   # Real-Time WebSocket Bot Client (SpacetimeDB SDK)
│   ├── dashboard.ts               # Live Dashboard HTTP API Server (port 4320)
│   └── module_bindings/           # SpacetimeDB auto-generated TypeScript schema & reducers
├── public/
│   └── dashboard.html             # Real-time telemetry, leaderboard, and checklist UI
├── scripts/
│   └── register-tournament.ts     # Automated tournament registration runner
├── tests/
│   └── strategy.test.ts           # Automated test suite (Dossier rule assertions)
└── ecosystem.config.cjs           # PM2 Process Management configuration (auto-restart)
```

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Verification Test Suite
```bash
npm test
```

### 3. Run 60-Match Benchmark
```bash
npm run benchmark 60
```

### 4. Launch Live Telemetry Dashboard
```bash
npm run dashboard
```
Open [http://localhost:4320](http://localhost:4320) to view live match statistics, SpacetimeDB leaderboards, and real-time word plays.

### 5. Run Live Bot Client
```bash
BOT_NAME="rackpilot-live" BOT_TOKEN="<your-token>" npm start
```

---

## 🧠 Key Strategic Pillars

1. **Vickrey Liquidity Drain & Price Support:**
   Maintains a 12-coin emergency liquidity floor. Avoids overpaying for high-face power letters (`J/Q/X/Z`) unless they complete an immediate high-scoring word, forcing aggressive rivals to exhaust their bankrolls on early auctions.

2. **Cash-Recycling Multiplier Targets:**
   Prioritizes banking words that achieve $\ge 2.5\times$ (6-letter) or $3.0\times$ (7+-letter) word rewards ($1\text{L} \le 3 = 1\times, 4 = 1.5\times, 5 = 2.0\times, 6 = 2.5\times, 7+ = 3.0\times$). Automatically recycles 5-letter words whenever liquidity drops below 32 coins.

3. **Endgame Depletion Strategy:**
   When the remaining bag reaches $\le 6$ tiles, shifts from liquidity preservation to an aggressive all-in push, bidding up to full remaining capital on final word completions.
