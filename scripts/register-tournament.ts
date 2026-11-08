import { DbConnection, type ErrorContext } from "../src/module_bindings/index.js";
import { Identity } from "spacetimedb";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "rackpilot-live";
const BOT_TOKEN =
  process.env.BOT_TOKEN ??
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJoZXhfaWRlbnRpdHkiOiJjMjAwZjlmYmMzZWIyNTFiZjhmMTRhMTIzMzI0MTZkMjg5OTI3MmMzMjkzZGQ0ZjEzM2U5ZTUwOTkzYWIwZWNhIiwic3ViIjoiMjFjYjAyZjUtY2U4Ni00MDkxLTkzNmMtMGI4ZDEyMWY0ZTdkIiwiaXNzIjoibG9jYWxob3N0IiwiYXVkIjpbInNwYWNldGltZWRiIl0sImlhdCI6MTc5NDA5NzQ5N30.GWComnDbwhNzb1585G4iwYQNT3TSv9WiJS4j5gg62vYU-sDXHOjxkN8FkFhsQer60RC6ky_t9CWsZq6iomqrXg";
const TOURNAMENT_ID = BigInt(process.env.TOURNAMENT_ID ?? "2");

console.log(`Connecting as ${BOT_NAME} to register for tournament ${TOURNAMENT_ID}...`);

DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withToken(BOT_TOKEN)
  .onConnect((conn, identity: Identity) => {
    console.log(`Connected with identity: ${identity.toHexString()}`);
    conn
      .subscriptionBuilder()
      .onApplied(async () => {
        console.log("Subscription applied. Resolving bot...");
        let botId: bigint | null = null;
        for (const cred of conn.db.botCredential.iter()) {
          if (cred.identity.toHexString() === identity.toHexString()) {
            botId = cred.botId;
            break;
          }
        }
        console.log(`Bot resolved: id=${botId}`);

        try {
          console.log(`Submitting registration for tournament ${TOURNAMENT_ID}...`);
          await conn.reducers.registerForTournament({ tournamentId: TOURNAMENT_ID });
          console.log(`Successfully registered bot ${botId} for tournament ${TOURNAMENT_ID}!`);
        } catch (err) {
          console.error("Error during registration:", err);
        }

        setTimeout(() => {
          console.log("Exiting registration task.");
          process.exit(0);
        }, 1500);
      })
      .subscribeToAllTables();
  })
  .onConnectError((_ctx: ErrorContext, err: Error) => {
    console.error("Connection error:", err.message);
    process.exit(1);
  })
  .build();
