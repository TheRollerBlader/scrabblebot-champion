import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getGlobalDictionary, calculateWordScore } from "./dictionary.js";
import { CardCounterStateTracker } from "./stateTracker.js";
import { chooseWord, decideBid, evaluateExpectedRackValue } from "./strategy.js";

const HOST = process.env.STDB_HOST ?? process.env.SPACETIMEDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? process.env.SPACETIMEDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "RackApex-Dossier";
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_NONCE = process.env.BOT_NONCE;
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const TELEMETRY_FILE = path.resolve(DIR, "..", "data", "live-telemetry.json");

// Preload dictionary in RAM prior to opening WebSocket connection (Dossier Section 5.1)
const dictionaryEngine = getGlobalDictionary();
console.log(
  `[Boot] Loaded ${dictionaryEngine.wordCount.toLocaleString()} words (${dictionaryEngine.anagramCount.toLocaleString()} anagram groups) in ${dictionaryEngine.loadTimeMs}ms`
);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();
const lastWordAttemptByMatch = new Map<string, number>();
const WORD_RETRY_MS = 180;

const trackers = new Map<string, CardCounterStateTracker>();
const initialRackRecorded = new Set<string>();
const recentDecisions: {
  timestamp: string;
  matchId: string;
  type: "BID" | "WORD";
  detail: string;
  latencyMs: number;
}[] = [];

function getTracker(matchId: bigint): CardCounterStateTracker {
  const key = matchId.toString();
  let t = trackers.get(key);
  if (!t) {
    t = new CardCounterStateTracker(key);
    trackers.set(key, t);
  }
  return t;
}

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackArrayForMatch(conn: DbConnection, matchId: bigint): string[] {
  const letters: string[] = [];
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    const ch = h.letter.trim().toUpperCase();
    for (let i = 0; i < h.count; i++) {
      letters.push(ch);
    }
  }
  return letters;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId !== myBotId) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(
      `[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`
    );
}

function persistTelemetry(conn: DbConnection, activeMatchId?: bigint) {
  try {
    const m = activeMatchId !== undefined ? conn.db.matchState.id.find(activeMatchId) : undefined;
    const me = activeMatchId !== undefined ? participantForMatch(conn, activeMatchId) : null;
    const rack = activeMatchId !== undefined ? rackArrayForMatch(conn, activeMatchId) : [];
    const tracker = activeMatchId !== undefined ? getTracker(activeMatchId) : undefined;
    const ev =
      rack.length > 0
        ? evaluateExpectedRackValue(
            rack,
            dictionaryEngine,
            m ? Number(m.bagTotal) : 30,
            tracker
          )
        : null;

    const payload = {
      updatedAt: new Date().toISOString(),
      botId: myBotId !== null ? Number(myBotId) : null,
      botName: BOT_NAME,
      activeMatch: m
        ? {
            matchId: Number(m.id),
            state: m.status.tag,
            auctionType: m.auctionType.tag,
            bagTotal: Number(m.bagTotal),
            balance: me ? me.balance : 0,
            score: me ? me.score : 0,
            rack,
            rackEV: ev,
            unseenDistribution: tracker ? tracker.getUnseenDistributionSnapshot() : null,
          }
        : null,
      recentDecisions: recentDecisions.slice(-25),
    };
    fs.writeFileSync(TELEMETRY_FILE, JSON.stringify(payload, null, 2));
  } catch {
    // Non-fatal telemetry write
  }
}

function tryPlayWordForMatch(conn: DbConnection, matchId: bigint, forceImmediate = false) {
  if (myBotId === null) return;
  const m = conn.db.matchState.id.find(matchId);
  if (!m || m.status.tag !== "Running") return;

  const key = String(matchId);
  const now = Date.now();
  if (!forceImmediate && now - (lastWordAttemptByMatch.get(key) ?? 0) < WORD_RETRY_MS) return;
  lastWordAttemptByMatch.set(key, now);

  const rack = rackArrayForMatch(conn, matchId);
  if (rack.length < 2) return;

  const tracker = getTracker(matchId);
  if (!initialRackRecorded.has(key)) {
    initialRackRecorded.add(key);
    tracker.recordOwnInitialRack(rack);
  }

  const participant = participantForMatch(conn, matchId);
  const balance = participant ? participant.balance : 100;
  const remainingBagCount = Number(m.bagTotal);

  const t0 = performance.now();
  const word = chooseWord(rack, undefined, balance, remainingBagCount, tracker);
  const elapsed = +(performance.now() - t0).toFixed(3);

  if (!word) return;
  const estScore = calculateWordScore(word);
  console.log(
    `[${BOT_NAME}] match ${matchId}: playing '${word}' (+${estScore} pts/coins) from [${rack.join("")}] | bag=${remainingBagCount} bal=${balance} (${elapsed}ms)`
  );
  conn.reducers
    .submitWord({ matchId, word })
    .catch(logFailure(`playing '${word}'`));

  recentDecisions.push({
    timestamp: new Date().toISOString(),
    matchId: key,
    type: "WORD",
    detail: `Played ${word} (+${estScore} pts/coins) from [${rack.join("")}]`,
    latencyMs: elapsed,
  });
  persistTelemetry(conn, matchId);
}

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") {
      tryPlayWordForMatch(conn, p.matchId);
    }
  }
}

function tryBid(
  conn: DbConnection,
  auctionId: bigint,
  matchId: bigint,
  letter: string
) {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;

  const participant = participantForMatch(conn, matchId);
  if (!participant) return;

  const m = conn.db.matchState.id.find(matchId);
  const remainingBagCount = m ? Number(m.bagTotal) : 30;
  const auctionType = m?.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey";
  const tracker = getTracker(matchId);

  // Sync opponent participants into our CardCounterStateTracker
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId === matchId && p.botId !== myBotId) {
      tracker.syncOpponentParticipant({
        botId: p.botId.toString(),
        balance: Number(p.balance),
        score: Number(p.score),
      });
    }
  }

  // CRITICAL SERVER TIMING RULE: When remainingBagCount === 0, closeAuction immediately
  // finishes the match in the same transaction. Flush any playable words before it closes!
  if (remainingBagCount === 0) {
    tryPlayWordForMatch(conn, matchId, true);
  }

  const rack = rackArrayForMatch(conn, matchId);
  if (rack.length > 0 && !initialRackRecorded.has(matchId.toString())) {
    initialRackRecorded.add(matchId.toString());
    tracker.recordOwnInitialRack(rack);
  }

  const t0 = performance.now();
  const amount = decideBid(
    letter,
    rack,
    undefined,
    participant.balance,
    remainingBagCount,
    tracker,
    auctionType,
    participant.score
  );
  const elapsed = +(performance.now() - t0).toFixed(3);
  const clamped = Math.max(0, Math.min(amount, participant.balance));

  bidsByAuction.add(key);
  if (clamped <= 0) return;

  conn.reducers
    .submitBid({ auctionId, amount: BigInt(clamped) })
    .catch(logFailure(`bid on auction ${auctionId}`));

  console.log(
    `[${BOT_NAME}] bid ${clamped} on '${letter}' (match ${matchId}, auction ${auctionId}, bag=${remainingBagCount}, ${elapsed}ms)`
  );
  recentDecisions.push({
    timestamp: new Date().toISOString(),
    matchId: matchId.toString(),
    type: "BID",
    detail: `Bid ${clamped} on '${letter}' (rack=[${rack.join("")}], bag=${remainingBagCount})`,
    latencyMs: elapsed,
  });
  persistTelemetry(conn, matchId);
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  const inRunning = Array.from(conn.db.matchParticipant.iter()).some((p) => {
    if (p.botId !== myBotId) return false;
    const m = conn.db.matchState.id.find(p.matchId);
    return m?.status.tag === "Running";
  });
  if (inRunning) return;
  const openLobby = Array.from(conn.db.lobby.iter()).find(
    (l) => l.status.tag === "Open"
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.lobbyMember.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId
    );
  if (alreadyIn) return;
  console.log(`[${BOT_NAME}] joining lobby`);
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

function bootstrapActivity(conn: DbConnection) {
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        console.log(`[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`)
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  joinLobby(conn);
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  }
  tryPlayWord(conn);
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);

      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch(logFailure("claiming the credential"));
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`
              );
              process.exit(1);
            }
            const bot = conn.db.bot.id.find(myBotId);
            console.log(
              `[${BOT_NAME}] claimed credential for bot '${bot?.name ?? "?"}' (id ${myBotId})`
            );
            bootstrapActivity(conn);
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`
          );
          process.exit(1);
        }
      }

      const bot = conn.db.bot.id.find(myBotId);
      console.log(
        `[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`
      );
      bootstrapActivity(conn);
    })
    .subscribeToAllTables();

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  });
  conn.db.myRack.onInsert(() => tryPlayWord(conn));
  conn.db.myRack.onUpdate(() => tryPlayWord(conn));
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    const tracker = getTracker(r.matchId);
    tracker.onAuctionResult({
      auctionId: r.auctionId.toString(),
      letter: r.letter,
      winnerBotId:
        r.winnerBotId !== undefined && r.winnerBotId !== null
          ? String(r.winnerBotId)
          : null,
      paid: Number(r.paid),
      myBotId: myBotId.toString(),
    });
  });
  conn.db.wordPlay.onInsert((_ctx, wp) => {
    if (myBotId === null) return;
    const tracker = getTracker(wp.matchId);
    tracker.onWordPlay({
      wordPlayId: wp.id.toString(),
      botId: wp.botId.toString(),
      word: wp.word,
      totalReward: Number(wp.totalReward),
      myBotId: myBotId.toString(),
    });
  });

  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = Array.from(conn.db.matchParticipant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId
      );
      if (wasIn) {
        console.log(`[${BOT_NAME}] match ${neu.id} ended; rejoining lobby`);
        persistTelemetry(conn, neu.id);
        joinLobby(conn);
      }
    }
  });
}

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) =>
      console.error("connect error:", err.message)
    )
    .onDisconnect(() => console.log("disconnected"))
    .build();
}

main();
