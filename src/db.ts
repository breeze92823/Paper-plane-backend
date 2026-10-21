import { MongoClient, type Collection } from "mongodb";
import type { DailyDoc } from "./daily.js";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated
// database with scoped credentials, no provisioning. A local `npm start`
// normally has no Mongo reachable at all, so a missing/unreachable URI must
// degrade this to "no persistence" rather than crash the room -- same stance
// every external dependency in the client takes (src/bloxity.js).
export interface PlayerDoc {
  _id: string; // Bloxity user id (SDK.auth.getUser()._id) -- see LobbyRoom.ts
  // Display name as of the last save, so an offline leaderboard row still has
  // something to show. Older docs may lack it; readers fall back to "Player".
  username?: string;
  // The durable fields client src/store.js's `game` tracks, mirrored 1:1
  // (multiplier and autoThrow are per-session, not saved).
  power: number; // raw earned total
  rebirths: number;
  // Derived server-side from `power` (progression.ts) whenever power is saved,
  // so the Level leaderboard is indexable. Older docs may lack it.
  level?: number;
  // Total seconds this account has spent connected, measured by the SERVER
  // clock (LobbyRoom.ts flushPlaytime) -- never client-reported, so it can't
  // be forged via saveProgress. Older docs may lack it.
  playTime?: number;
  wins: number;
  bestDistance: number; // m: the longest street throw
  furthestZone: number; // index into the client's STREET_ZONES
  ownedPlanes: number[]; // indices into the client's MAP.pads
  equippedPlane: number;
  // Pets from eggs (client src/store.js): hatched pets, the equipped ones' ids, every
  // `${egg}:${name}` ever hatched, and the next id to hand out. Older docs lack them.
  pets?: SavedPet[];
  equipped?: number[];
  discovered?: string[];
  nextPetId?: number;
  // Onboarding progress (client src/tutorial.js), 0..TUTORIAL_DONE_STEP. Docs from before the
  // tutorial lack it; LobbyRoom.ts resolveTutorialStep reads those as finished.
  tutorialStep?: number;
  // Auto Throw bought with Wins (client src/store.js). Older docs lack it (= not owned).
  autoThrowOwned?: boolean;
  // The HUD's x2 Power / x2 Wins (client src/store.js): bought once with Wins, then switched
  // on or off. Older docs lack them (= not owned).
  x2Owned?: X2Flags;
  x2On?: X2Flags;
  // Daily rewards (src/daily.ts): this cycle's start and the days claimed. Written by the
  // server only (claimDaily), never by saveProgress. Older docs lack it.
  daily?: DailyDoc;
  // Timed x2 boosts from daily rewards: epoch ms each runs until (0 / past = off). Client-
  // reported through saveProgress, capped at BOOST_MAX_MS ahead. Older docs lack it.
  boosts?: { power?: number; wins?: number };
  // The Items window's stored eggs (by EGG_PETS id) and potions (`${stat}:${minutes}`) -> count.
  // Client-reported through saveProgress. Older docs lack them.
  storedEggs?: Record<string, number>;
  potions?: Record<string, number>;
  version: number;
  updatedAt: Date;
}

export interface X2Flags {
  power: boolean;
  wins: boolean;
}

// One hatched pet: a per-save id, the egg it came from and its name (constants.ts EGG_PETS).
export interface SavedPet {
  id: number;
  egg: string;
  name: string;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this
    // game+channel's own isolated database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");

    // refreshLeaderboard() sorts by each of these; createIndex is idempotent.
    // A failure only means those queries stay unindexed, never blocks startup.
    try {
      await players.createIndex({ level: -1, power: -1 });
      await players.createIndex({ playTime: -1 });
      await players.createIndex({ power: -1 });
      await players.createIndex({ wins: -1 });
      await players.createIndex({ rebirths: -1, power: -1 });
      await players.createIndex({ bestDistance: -1 });
    } catch (err) {
      console.warn("[db] failed to create leaderboard indexes:", err);
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as
// "skip persistence for this request", never throw.
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: lets tests exercise the leaderboard/save logic against an
// in-memory fake collection instead of a real MongoDB.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
