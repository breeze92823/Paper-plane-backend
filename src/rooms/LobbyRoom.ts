import { Room, Client, CloseCode } from "colyseus";
import { LobbyState, PlayerState } from "./schema/LobbyState.js";
import {
  LEADERBOARD_REFRESH_MS,
  LEADERBOARD_QUERY_LIMIT,
  POWER_MAX,
  REBIRTH_MAX,
  WINS_MAX,
  STREET_LENGTH,
  ZONE_COUNT,
  PLANE_COUNT,
  DEFAULT_PLANE,
  PLAYTIME_FLUSH_MS,
  TRAINING_PAD_COUNT,
  THROW_MIN_INTERVAL_MS,
  EGG_PETS,
  PET_INVENTORY_MAX,
  PET_SLOTS_MAX,
  TUTORIAL_DONE_STEP,
  TUTORIAL_POWER,
  TUTORIAL_WINS,
  TUTORIAL_LEVEL,
  BOOST_MAX_MS,
  STORED_MAX,
  POTION_MAX_MINUTES,
} from "../constants.js";
import { levelForPower } from "../progression.js";
import { getPlayers, type PlayerDoc, type SavedPet, type X2Flags } from "../db.js";
import { claimDaily, dailyView, freshDaily, sanitizeDaily, type DailyDoc } from "../daily.js";

// One separate board per stat, matching the client's three in-world boards behind the
// Egg Row (client src/leaderboards.js): Rebirths, total time played, and Wins. Rebirth
// ties break on Power in the Mongo query (the one closer to the next rebirth ranks first).
const LEADERBOARD_STATS = ["rebirths", "playTime", "wins"] as const;
type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
type LeaderboardRow = { id: string; name: string; value: number };
type LeaderboardPayload = Record<LeaderboardStat, LeaderboardRow[]>;
type OnlineRow = { sessionId: string; userId: string | null; username: string } & Record<LeaderboardStat, number>;

// Collapse online rows that still share a userId (e.g. a leave/join racing the
// same tick) down to one, keeping the higher value for the ranked stat.
// Guests have no id to key on and are never collapsed against each other.
function dedupeOnline(rows: OnlineRow[], stat: LeaderboardStat): OnlineRow[] {
  const byUserId = new Map<string, OnlineRow>();
  const anonymous: OnlineRow[] = [];
  for (const row of rows) {
    if (!row.userId) {
      anonymous.push(row);
      continue;
    }
    const existing = byUserId.get(row.userId);
    if (!existing || row[stat] > existing[stat]) byUserId.set(row.userId, row);
  }
  return [...byUserId.values(), ...anonymous];
}

// The furthest tutorial step the doc's own stats prove the player has already passed
// (mirrors the client's src/tutorial.js step conditions).
function inferMinTutorialStep(doc: PlayerDoc): number {
  if ((doc.rebirths ?? 0) >= 1) return TUTORIAL_DONE_STEP; // past step 4 (rebirth)
  if (levelForPower(doc.power ?? 0) >= TUTORIAL_LEVEL) return 4; // past step 3
  if ((doc.equippedPlane ?? DEFAULT_PLANE) !== DEFAULT_PLANE) return 3; // past step 2 (new plane)
  if ((doc.wins ?? 0) >= TUTORIAL_WINS || (doc.ownedPlanes ?? []).some((i) => i !== DEFAULT_PLANE)) return 2; // past step 1
  if ((doc.power ?? 0) >= TUTORIAL_POWER) return 1; // past step 0
  return 0;
}

// What loadProgress() sends down as tutorialStep. A doc predating the field reads as finished;
// otherwise the stored step, raised to whatever the stats prove (a stored step that undercounts
// real progress must never show the player a step they've clearly blown past). Never lowers a
// stored step. Exported so tests can exercise the rules without a full room round trip.
export function resolveTutorialStep(doc: PlayerDoc): number {
  const stored = typeof doc.tutorialStep === "number" ? doc.tutorialStep : TUTORIAL_DONE_STEP;
  return Math.min(TUTORIAL_DONE_STEP, Math.max(stored, inferMinTutorialStep(doc)));
}

// Cap on the JSON avatar blob (see LobbyState.ts PlayerState.avatar).
const AVATAR_MAX_LEN = 4096;

function sanitizeAvatar(raw: unknown): string {
  return typeof raw === "string" && raw.length <= AVATAR_MAX_LEN ? raw : "";
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

const isKnownPet = (egg: unknown, name: unknown): boolean =>
  typeof egg === "string" && typeof name === "string" && Object.hasOwn(EGG_PETS, egg) && EGG_PETS[egg].includes(name);

// The pet fields of a save: known pets with unique positive integer ids (at most
// PET_INVENTORY_MAX), equipped ids that are among them (at most PET_SLOTS_MAX), known
// discovered keys (plus every owned pet's), and a next id past every owned one. Applied only
// when `pets` is an array, so a payload from before eggs leaves a saved collection alone.
export function sanitizePets(src: Record<string, unknown>): Pick<PlayerDoc, "pets" | "equipped" | "discovered" | "nextPetId"> | null {
  if (!Array.isArray(src.pets)) return null;
  const pets: SavedPet[] = [];
  const ids = new Set<number>();
  for (const raw of src.pets) {
    if (pets.length >= PET_INVENTORY_MAX) break;
    const p = raw as Partial<SavedPet> | null;
    if (!p || !Number.isInteger(p.id) || (p.id as number) < 1 || ids.has(p.id as number) || !isKnownPet(p.egg, p.name)) continue;
    ids.add(p.id as number);
    pets.push({ id: p.id as number, egg: p.egg as string, name: p.name as string });
  }
  const equipped: number[] = [];
  if (Array.isArray(src.equipped)) {
    for (const id of src.equipped) {
      if (equipped.length >= PET_SLOTS_MAX) break;
      if (Number.isInteger(id) && ids.has(id) && !equipped.includes(id)) equipped.push(id);
    }
  }
  const discovered = new Set<string>();
  if (Array.isArray(src.discovered)) {
    for (const key of src.discovered) {
      if (typeof key !== "string") continue;
      const at = key.indexOf(":");
      if (at > 0 && isKnownPet(key.slice(0, at), key.slice(at + 1))) discovered.add(key);
    }
  }
  for (const p of pets) discovered.add(`${p.egg}:${p.name}`);
  const maxId = pets.reduce((m, p) => Math.max(m, p.id), 0);
  const next = Number.isInteger(src.nextPetId) ? (src.nextPetId as number) : 1;
  return { pets, equipped, discovered: [...discovered], nextPetId: Math.max(maxId + 1, Math.min(next, Number.MAX_SAFE_INTEGER)) };
}

// Timed x2 boosts as epoch ms each runs until: only future ones, at most BOOST_MAX_MS ahead.
export function sanitizeBoosts(raw: unknown, now: number): { power: number; wins: number } {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const until = (v: unknown) => (finite(v) && v > now ? Math.min(v, now + BOOST_MAX_MS) : 0);
  return { power: until(src.power), wins: until(src.wins) };
}

// x2 Power / x2 Wins flags (owned, or switched on): true only when sent as exactly true.
export function sanitizeX2(raw: unknown): X2Flags {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { power: src.power === true, wins: src.wins === true };
}

// Stored items: known keys only, whole positive counts capped at STORED_MAX.
function sanitizeCounts(raw: unknown, ok: (key: string) => boolean): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, n] of Object.entries(raw as Record<string, unknown>)) {
    if (ok(key) && Number.isInteger(n) && (n as number) > 0) out[key] = Math.min(STORED_MAX, n as number);
  }
  return out;
}
const isStoredEgg = (key: string) => Object.hasOwn(EGG_PETS, key);
const isPotion = (key: string) => {
  const m = /^(power|wins):(\d+)$/.exec(key);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= POTION_MAX_MINUTES;
};
export const sanitizeStoredEggs = (raw: unknown) => sanitizeCounts(raw, isStoredEgg);
export const sanitizePotions = (raw: unknown) => sanitizeCounts(raw, isPotion);

// A plane is its index into the client's MAP.pads.
function isPlane(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) < PLANE_COUNT;
}

// Same client-trusted model as every other message here -- no server-side
// game-logic validation. What IS enforced: shape and bounds, so a malformed
// payload can never corrupt this player's own Mongo document. A forged number
// can only ever affect the sender's own save.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const out: Partial<PlayerDoc> = {};

  if (finite(src.power)) {
    out.power = Math.min(POWER_MAX, Math.max(0, Math.floor(src.power)));
    out.level = levelForPower(out.power);
  }
  if (finite(src.rebirths)) out.rebirths = Math.min(REBIRTH_MAX, Math.max(0, Math.floor(src.rebirths)));
  if (finite(src.wins)) out.wins = Math.min(WINS_MAX, Math.max(0, Math.floor(src.wins)));
  if (finite(src.bestDistance)) out.bestDistance = Math.min(STREET_LENGTH, Math.max(0, src.bestDistance));
  if (finite(src.furthestZone)) out.furthestZone = Math.min(ZONE_COUNT - 1, Math.max(0, Math.floor(src.furthestZone)));

  if (Array.isArray(src.ownedPlanes)) {
    const owned = new Set<number>([DEFAULT_PLANE]); // the starter plane is always owned
    for (const i of src.ownedPlanes) if (isPlane(i)) owned.add(i);
    out.ownedPlanes = [...owned].sort((a, b) => a - b);
  }
  if (isPlane(src.equippedPlane)) out.equippedPlane = src.equippedPlane;
  // Only ever moves forward on the client (store.js advanceTutorial), so a save can safely take
  // whatever is sent, clamped to the valid range.
  if (finite(src.tutorialStep)) {
    out.tutorialStep = Math.min(TUTORIAL_DONE_STEP, Math.max(0, Math.floor(src.tutorialStep)));
  }
  if (typeof src.autoThrowOwned === "boolean") out.autoThrowOwned = src.autoThrowOwned;
  if (src.x2Owned && typeof src.x2Owned === "object") out.x2Owned = sanitizeX2(src.x2Owned);
  if (src.x2On && typeof src.x2On === "object") out.x2On = sanitizeX2(src.x2On);
  const pets = sanitizePets(src);
  if (pets) Object.assign(out, pets);
  if (src.boosts && typeof src.boosts === "object") out.boosts = sanitizeBoosts(src.boosts, Date.now());
  if (src.storedEggs && typeof src.storedEggs === "object") out.storedEggs = sanitizeStoredEggs(src.storedEggs);
  if (src.potions && typeof src.potions === "object") out.potions = sanitizePotions(src.potions);
  return out;
}

// One toss, relayed so other clients can play it (client src/throw.js):
//   street -- straight up the street, landing `range` metres from the Throw Area
//   pad    -- at training pad `pad`'s prize
//   free   -- a glide along (dx, dz)
// Purely cosmetic for the receivers: rewards are earned and reported by the
// thrower alone, through `stats`/`saveProgress`.
export type ThrowMsg =
  | { kind: "street"; range: number }
  | { kind: "pad"; pad: number }
  | { kind: "free"; dx: number; dz: number };

export function sanitizeThrow(raw: unknown): ThrowMsg | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  if (src.kind === "street" && finite(src.range)) {
    return { kind: "street", range: Math.min(STREET_LENGTH, Math.max(0, src.range)) };
  }
  if (src.kind === "pad" && Number.isInteger(src.pad) && (src.pad as number) >= 0 && (src.pad as number) < TRAINING_PAD_COUNT) {
    return { kind: "pad", pad: src.pad as number };
  }
  if (src.kind === "free" && finite(src.dx) && finite(src.dz)) {
    const len = Math.hypot(src.dx, src.dz);
    if (len < 1e-6) return null;
    return { kind: "free", dx: src.dx / len, dz: src.dz / len };
  }
  return null;
}

/**
 * Single global room every client joins via `client.joinOrCreate("lobby")`.
 * Clients report events (as they already do locally against src/store.js);
 * this room relays/stores them so other clients see them too. No server-side
 * gameplay validation.
 */
export class LobbyRoom extends Room<{ state: LobbyState }> {
  state = new LobbyState();

  // sessionId -> Bloxity user id, for whichever connected clients are signed
  // in. Deliberately NOT part of LobbyState: it has no reason to be broadcast,
  // it only gates this room's own Mongo reads/writes for that connection.
  userIds = new Map<string, string>();

  // sessionId -> epoch ms up to which that connection's playtime has already
  // been counted. Also not synced.
  private playTimeMark = new Map<string, number>();

  // sessionId -> epoch ms of its last relayed throw (THROW_MIN_INTERVAL_MS). Not synced.
  private lastThrowAt = new Map<string, number>();

  // sessionId -> that signed-in account's daily-reward cycle (src/daily.ts), loaded with its
  // progress. Guests never get one: the client keeps theirs. Not synced.
  private daily = new Map<string, DailyDoc>();

  messages = {
    // Throttled client-side -- not sent every physics frame.
    move: (client: Client, msg: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (finite(msg?.x)) p.x = msg.x;
      if (finite(msg?.y)) p.y = msg.y;
      if (finite(msg?.z)) p.z = msg.z;
      if (finite(msg?.yaw)) p.yaw = msg.yaw;
      if (finite(msg?.moveBlend)) p.moveBlend = msg.moveBlend;
    },
    // Bloxity avatar JSON; sent on connect and whenever the portal reports a change.
    setAvatar: (client: Client, msg: { avatar?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const avatar = sanitizeAvatar(msg?.avatar);
      if (avatar) p.avatar = avatar;
    },
    // Live stats for the in-world leaderboards, sent debounced on change.
    stats: (
      client: Client,
      msg: { power?: number; wins?: number; rebirths?: number; bestDistance?: number; equippedPlane?: number },
    ) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (finite(msg?.power)) {
        p.power = Math.min(POWER_MAX, Math.max(0, msg.power));
        p.level = levelForPower(p.power);
      }
      if (finite(msg?.wins)) p.wins = Math.min(WINS_MAX, Math.max(0, msg.wins));
      if (finite(msg?.rebirths)) p.rebirths = Math.min(REBIRTH_MAX, Math.max(0, msg.rebirths));
      if (finite(msg?.bestDistance)) p.bestDistance = Math.min(STREET_LENGTH, Math.max(0, msg.bestDistance));
      if (isPlane(msg?.equippedPlane)) p.equippedPlane = msg.equippedPlane;
    },
    // A toss just started on the sender: relay it to everyone else, tagged with
    // the sender's sessionId so they know whose character plays it. Not state --
    // a one-shot event a late joiner has no reason to replay.
    throw: (client: Client, msg: unknown) => {
      if (!this.state.players.has(client.sessionId)) return;
      const t = sanitizeThrow(msg);
      if (!t) return;
      const now = Date.now();
      if (now - (this.lastThrowAt.get(client.sessionId) ?? 0) < THROW_MIN_INTERVAL_MS) return;
      this.lastThrowAt.set(client.sessionId, now);
      this.broadcast("throw", { id: client.sessionId, ...t }, { except: client });
    },
    // Debounced push of the durable half of the client store. A guest has no
    // userId and this no-ops. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      const patch = sanitizeProgress(msg);
      if (!patch) return;
      // Display name comes from this connection's own PlayerState, not `msg`.
      const p = this.state.players.get(client.sessionId);
      try {
        await players.updateOne(
          { _id: userId },
          {
            $set: { ...patch, username: p?.username || "Player", updatedAt: new Date() },
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[LobbyRoom] saveProgress failed", err);
      }
    },
    // Claims one day of this account's daily rewards. The server checks the day is unlocked
    // and unclaimed and saves the claim before telling the client what to grant, so a reward
    // is never handed out twice -- not by a double click, a second tab or a reload.
    claimDaily: async (client: Client, msg: { day?: unknown }) => {
      const day = msg?.day;
      const d = this.daily.get(client.sessionId);
      if (!d) {
        client.send("dailyDenied", { day, reason: "signin" });
        return;
      }
      const now = Date.now();
      const res = claimDaily(d, day, now);
      if ("reason" in res) {
        client.send("dailyDenied", { day, reason: res.reason, daily: dailyView(d, now) });
        return;
      }
      // Recorded before any await, so a second claim racing this one sees it.
      this.daily.set(client.sessionId, res.daily);
      const userId = this.userIds.get(client.sessionId);
      const players = getPlayers();
      if (userId && players) {
        try {
          await players.updateOne(
            { _id: userId },
            { $set: { daily: res.daily, updatedAt: new Date() }, $setOnInsert: { version: 1, tutorialStep: 0 } },
            { upsert: true },
          );
        } catch (err) {
          console.warn("[LobbyRoom] daily claim save failed", err);
        }
      }
      client.send("dailyClaimed", { day, reward: res.reward, daily: dailyView(res.daily, Date.now()) });
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest
    // who signs in mid-session). Without this a late sign-in would never get
    // a userId and saveProgress would no-op for the whole session.
    identify: (client: Client, msg: { username?: string; userId?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = msg.username.slice(0, 64);
      this.setUserId(client, p, typeof msg?.userId === "string" ? msg.userId : "");
    },
  };

  // Runs once immediately -- a fresh room shouldn't sit on an empty board for
  // a full LEADERBOARD_REFRESH_MS -- then on a timer.
  onCreate() {
    void this.refreshLeaderboard();
    this.clock.setInterval(() => {
      void this.refreshLeaderboard();
    }, LEADERBOARD_REFRESH_MS);
    this.clock.setInterval(() => this.flushAllPlaytime(), PLAYTIME_FLUSH_MS);
  }

  // Adds the seconds elapsed since this session's last mark to its live
  // playTime and, for a signed-in player, $inc's the same amount into Mongo.
  // $inc (not $set) so it can't race saveProgress and a client can never
  // forge or reset its own time. Called by the interval, and right before a
  // session is dropped so the tail end of a visit isn't lost.
  private flushPlaytime(sessionId: string) {
    const mark = this.playTimeMark.get(sessionId);
    if (mark === undefined) return;
    const seconds = Math.floor((Date.now() - mark) / 1000);
    if (seconds <= 0) return;
    // Advance by whole seconds only, so sub-second remainders aren't dropped.
    this.playTimeMark.set(sessionId, mark + seconds * 1000);
    const p = this.state.players.get(sessionId);
    if (p) p.playTime += seconds;
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    players
      .updateOne(
        { _id: userId },
        { $inc: { playTime: seconds }, $set: { username: p?.username || "Player", updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      )
      .catch((err) => console.warn("[LobbyRoom] playtime flush failed", err));
  }

  private flushAllPlaytime() {
    for (const sessionId of [...this.playTimeMark.keys()]) this.flushPlaytime(sessionId);
  }

  // Drops a session's per-connection bookkeeping after a final playtime flush.
  private forgetSession(sessionId: string) {
    this.flushPlaytime(sessionId);
    this.playTimeMark.delete(sessionId);
    this.lastThrowAt.delete(sessionId);
    this.daily.delete(sessionId);
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
  }

  onJoin(client: Client, options?: { username?: string; avatar?: string; userId?: string }) {
    // No spawn assignment -- the client reports its real position in its
    // first "move" message.
    const p = new PlayerState();
    p.username = typeof options?.username === "string" ? options.username.slice(0, 64) : "";
    p.avatar = sanitizeAvatar(options?.avatar);
    this.state.players.set(client.sessionId, p);
    this.playTimeMark.set(client.sessionId, Date.now());

    this.setUserId(client, p, options?.userId ?? "");
    void this.refreshLeaderboard();
  }

  // Client-trusted Bloxity user id. A forged id can only read/overwrite the
  // SENDER's own save (there is no cross-player read in `saveProgress`).
  // Called from both onJoin and `identify`.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    const userId = typeof raw === "string" ? raw.slice(0, 128) : "";
    const prev = this.userIds.get(client.sessionId) || "";
    if (userId === prev) return; // no change -- e.g. a username-only identify

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one
      // account never shows as two leaderboard rows / two racing Mongo writers
      // (a crashed tab lingers up to 20s via allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
      this.daily.delete(client.sessionId); // until this account's own cycle has loaded
      void this.loadProgress(client, userId, p);
    } else {
      // Logged out: stop persisting for this connection. The client flushes a
      // final saveProgress under the OLD id before sending this.
      this.userIds.delete(client.sessionId);
      this.daily.delete(client.sessionId);
      client.send("daily", null); // back to the client's own (guest) calendar
    }

    void this.refreshLeaderboard();
  }

  // Seeds this player's own leaderboard row immediately and sends the saved
  // doc to just this client so it can hydrate what LobbyState doesn't carry
  // (owned planes, furthest zone). A missing doc or unreachable Mongo leaves
  // the client on its own defaults.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    if (!players) {
      // Nowhere to keep it: a cycle for this connection only.
      this.setDaily(client, freshDaily(Date.now()));
      return;
    }
    try {
      const doc = await players.findOne({ _id: userId });
      if (this.userIds.get(client.sessionId) !== userId) return; // signed out/switched meanwhile
      if (!doc) {
        // A brand-new account: tell the client there's nothing to load so it
        // can start fresh (tutorial at step 0) right away instead of waiting on a timeout.
        client.send("noProgress", {});
        // Its calendar starts now, saved so it doesn't restart on the next visit.
        const daily = freshDaily(Date.now());
        this.setDaily(client, daily);
        await players.updateOne(
          { _id: userId },
          { $set: { daily, updatedAt: new Date() }, $setOnInsert: { version: 1, tutorialStep: 0 } },
          { upsert: true },
        );
        return;
      }
      p.power = doc.power ?? 0;
      p.level = levelForPower(p.power);
      // Saved total (already includes anything flushed while signed in this
      // session) -- guest time before signing in isn't counted.
      p.playTime = doc.playTime ?? 0;
      p.wins = doc.wins ?? 0;
      p.rebirths = doc.rebirths ?? 0;
      p.bestDistance = doc.bestDistance ?? 0;
      const ownedPlanes = doc.ownedPlanes?.length ? doc.ownedPlanes : [DEFAULT_PLANE];
      const equippedPlane = ownedPlanes.includes(doc.equippedPlane) ? doc.equippedPlane : DEFAULT_PLANE;
      p.equippedPlane = equippedPlane;
      client.send("progress", {
        power: p.power,
        level: p.level,
        playTime: p.playTime,
        rebirths: p.rebirths,
        wins: p.wins,
        bestDistance: p.bestDistance,
        furthestZone: doc.furthestZone ?? 0,
        ownedPlanes,
        equippedPlane,
        tutorialStep: resolveTutorialStep(doc),
        autoThrowOwned: doc.autoThrowOwned === true,
        x2Owned: sanitizeX2(doc.x2Owned),
        x2On: sanitizeX2(doc.x2On),
        // Re-sanitized on the way out too, so an older or hand-edited doc can't hand the
        // client pets it doesn't know.
        ...(sanitizePets({ pets: doc.pets ?? [], equipped: doc.equipped, discovered: doc.discovered, nextPetId: doc.nextPetId }) ?? {}),
        boosts: sanitizeBoosts(doc.boosts, Date.now()),
        storedEggs: sanitizeStoredEggs(doc.storedEggs),
        potions: sanitizePotions(doc.potions),
      });
      const daily = sanitizeDaily(doc.daily, Date.now());
      this.setDaily(client, daily);
      // A doc from before daily rewards: save its cycle's start (only if still missing).
      if (!doc.daily) await players.updateOne({ _id: userId, daily: { $exists: false } } as any, { $set: { daily } });
    } catch (err) {
      console.warn("[LobbyRoom] loadProgress failed", err);
    }
  }

  // Sets this signed-in session's daily cycle and sends it down.
  private setDaily(client: Client, d: DailyDoc) {
    this.daily.set(client.sessionId, d);
    client.send("daily", dailyView(d, Date.now()));
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at
  // once. Anything else (WiFi blip, backgrounded tab) gets 20s to reconnect
  // with the same session, instead of re-joining as a brand new player.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      this.forgetSession(client.sessionId);
      return;
    }
    // Count time up to the drop, then pause the clock for the reconnect window.
    this.flushPlaytime(client.sessionId);
    this.playTimeMark.delete(client.sessionId);
    try {
      await this.allowReconnection(client, 20);
      this.playTimeMark.set(client.sessionId, Date.now());
    } catch {
      this.forgetSession(client.sessionId);
    }
  }

  // Builds and broadcasts the merged "all-time saved + currently online"
  // leaderboard. Only the server has both the live roster and the
  // sessionId->userId map needed to tell "this online player already IS a
  // saved account" apart from "this saved account is offline". A private
  // method so tests can call and await it directly.
  private async refreshLeaderboard() {
    const onlineRows: OnlineRow[] = [];
    const onlineUserIds = new Set<string>();
    this.state.players.forEach((p, sessionId) => {
      const userId = this.userIds.get(sessionId) ?? null;
      if (userId) onlineUserIds.add(userId);
      onlineRows.push({
        sessionId,
        userId,
        username: p.username || "Player",
        rebirths: p.rebirths,
        playTime: p.playTime,
        wins: p.wins,
      });
    });

    const players = getPlayers();
    const payload = { rebirths: [], playTime: [], wins: [] } as LeaderboardPayload;

    for (const stat of LEADERBOARD_STATS) {
      // Online rows first: a connected player's live value is more current
      // than their last debounced save.
      const merged: LeaderboardRow[] = dedupeOnline(onlineRows, stat).map((row) => ({
        id: row.sessionId,
        name: row.username,
        value: row[stat],
      }));

      // Then everyone who has EVER saved, minus accounts already shown live.
      if (players) {
        try {
          const docs = await players
            .find({}, { projection: { _id: 1, username: 1, [stat]: 1 } })
            .sort(stat === "rebirths" ? { rebirths: -1, power: -1 } : { [stat]: -1 })
            .limit(LEADERBOARD_QUERY_LIMIT)
            .toArray();

          let offlineIndex = 0;
          for (const doc of docs) {
            if (onlineUserIds.has(doc._id)) continue;
            // Synthetic id -- never broadcast another account's raw Bloxity id.
            merged.push({
              id: `offline:${stat}:${offlineIndex++}`,
              name: doc.username || "Player",
              value: (doc[stat] as number | undefined) ?? 0,
            });
          }
        } catch (err) {
          console.warn(`[LobbyRoom] leaderboard query failed for stat=${stat}`, err);
        }
      }

      // Collapse rows sharing a display name (the same account under a
      // different id would otherwise appear twice). Keep the higher value but
      // prefer an online row's id so the client can recognise its own row.
      const byName = new Map<string, LeaderboardRow>();
      for (const row of merged) {
        const key = row.name || "Player";
        const existing = byName.get(key);
        if (!existing) {
          byName.set(key, row);
          continue;
        }
        const preferId = existing.id.startsWith("offline:") && !row.id.startsWith("offline:") ? row.id : existing.id;
        byName.set(key, { id: preferId, name: key, value: Math.max(existing.value, row.value) });
      }
      const deduped = [...byName.values()];

      deduped.sort((a, b) => b.value - a.value);
      payload[stat] = deduped.slice(0, LEADERBOARD_QUERY_LIMIT);
    }

    this.broadcast("leaderboard", payload);
  }
}
