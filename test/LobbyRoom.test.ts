import assert from "assert";
import type { Collection } from "mongodb";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { LobbyState } from "../src/rooms/schema/LobbyState.js";
import { resolveTutorialStep, sanitizeBoosts, sanitizeProgress, sanitizeThrow, type LobbyRoom } from "../src/rooms/LobbyRoom.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";
import { claimDaily, DAILY_DAY_MS, DAILY_REWARDS, freshDaily, sanitizeDaily } from "../src/daily.js";

// Hand-rolled fake `players` collection implementing only the subset
// LobbyRoom.ts calls: find().sort().limit().toArray(), updateOne() (upsert),
// findOne(). No MongoDB runs in the test process.
function fakePlayersCollection(seed: PlayerDoc[] = []) {
  const docs = new Map<string, PlayerDoc>(seed.map((d) => [d._id, d]));
  const fake = {
    docs,
    async findOne(filter: { _id: string }) {
      return docs.get(filter._id) ?? null;
    },
    async updateOne(filter: { _id: string }, update: any, options: any) {
      const existing = docs.get(filter._id);
      if (!existing && !options?.upsert) return;
      const base = existing ?? ({ _id: filter._id, ...(update.$setOnInsert ?? {}) } as PlayerDoc);
      docs.set(filter._id, { ...base, ...(update.$set ?? {}) } as PlayerDoc);
    },
    find(_filter: any) {
      let sortField: string | null = null;
      let limitN = Infinity;
      const cursor = {
        sort(spec: Record<string, number>) {
          sortField = Object.keys(spec)[0];
          return cursor;
        },
        limit(n: number) {
          limitN = n;
          return cursor;
        },
        async toArray() {
          let arr = Array.from(docs.values());
          if (sortField) {
            const field = sortField;
            arr = arr.slice().sort((a: any, b: any) => (b[field] ?? 0) - (a[field] ?? 0));
          }
          return arr.slice(0, limitN);
        },
      };
      return cursor;
    },
  };
  return fake as unknown as Collection<PlayerDoc> & { docs: Map<string, PlayerDoc> };
}

function baseDoc(overrides: Partial<PlayerDoc> = {}): PlayerDoc {
  return {
    _id: "test",
    power: 0,
    rebirths: 0,
    wins: 0,
    bestDistance: 0,
    furthestZone: 0,
    ownedPlanes: [0],
    equippedPlane: 0,
    version: 1,
    updatedAt: new Date(),
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("LobbyRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  // Tests that swap in a fake collection reset it so the others keep
  // exercising the real "no MONGODB_URI" no-op path.
  afterEach(() => __setPlayersForTest(null));

  it("relays move, avatar and stats between two clients", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room);
    const client2 = await colyseus.connectTo(room);

    client1.send("move", { x: 1, y: 2, z: 3, yaw: 0.5, moveBlend: 0.75 });
    await room.waitForNextPatch();
    const p1 = client2.state.players.get(client1.sessionId);
    assert.strictEqual(p1.x, 1);
    assert.strictEqual(p1.moveBlend, 0.75);

    const avatar = JSON.stringify({ e: { headId: "42" }, p: { height: 1.2 } });
    client1.send("setAvatar", { avatar });
    await room.waitForNextPatch();
    assert.strictEqual(client2.state.players.get(client1.sessionId).avatar, avatar);

    client1.send("stats", { power: 2480, wins: 30, rebirths: 3, bestDistance: 812.5, equippedPlane: 4 });
    await room.waitForNextPatch();
    const s = client2.state.players.get(client1.sessionId);
    assert.strictEqual(s.power, 2480);
    assert.strictEqual(s.wins, 30);
    assert.strictEqual(s.rebirths, 3);
    assert.strictEqual(s.bestDistance, 812.5);
    assert.strictEqual(s.equippedPlane, 4);
    assert.ok(s.level > 1, "level is derived from power");

    // Negatives clamp to 0; an out-of-range plane index is ignored; distance caps at the street's end.
    client1.send("stats", { power: -5, equippedPlane: 10, bestDistance: 99999 });
    await room.waitForNextPatch();
    const s2 = client2.state.players.get(client1.sessionId);
    assert.strictEqual(s2.power, 0);
    assert.strictEqual(s2.level, 1);
    assert.strictEqual(s2.equippedPlane, 4);
    assert.strictEqual(s2.bestDistance, 3500);
  });

  it("degrades to no-op persistence when Mongo is unreachable", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { userId: "bloxity-user-1" });
    client1.send("saveProgress", { power: 42, rebirths: 1, wins: 7, ownedPlanes: [0], equippedPlane: 0 });
    await room.waitForNextPatch();
    assert.strictEqual(client1.state.players.get(client1.sessionId).username, "");
  });

  it("registers/clears the userId mapping via identify, independent of join", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { username: "Guest" });
    assert.strictEqual((room as unknown as LobbyRoom).userIds.has(client1.sessionId), false);

    client1.send("identify", { username: "RealName", userId: "u1" });
    await room.waitForNextPatch();
    assert.strictEqual((room as unknown as LobbyRoom).userIds.get(client1.sessionId), "u1");
    assert.strictEqual(client1.state.players.get(client1.sessionId).username, "RealName");

    client1.send("identify", { username: "Guest", userId: "" });
    await room.waitForNextPatch();
    assert.strictEqual((room as unknown as LobbyRoom).userIds.has(client1.sessionId), false);
  });

  it("evicts a stale session that already claims the same userId", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const first = await colyseus.connectTo(room, { userId: "dup" });
    const second = await colyseus.connectTo(room, { userId: "dup" });
    await sleep(50);
    assert.strictEqual((room as unknown as LobbyRoom).userIds.has(first.sessionId), false);
    assert.strictEqual((room as unknown as LobbyRoom).userIds.get(second.sessionId), "dup");
    assert.strictEqual(room.state.players.has(first.sessionId), false);
  });

  it("saves progress, then sends it back as `progress` on the next sign-in", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { userId: "u1", username: "Pilot" });

    client1.send("saveProgress", {
      power: 500,
      rebirths: 2,
      wins: 12,
      bestDistance: 640.25,
      furthestZone: 2,
      ownedPlanes: [3, 1, 42, "x", 1.5],
      equippedPlane: 3,
      pets: [
        { id: 1, egg: "basic", name: "Kite Cat" },
        { id: 2, egg: "meadow", name: "Bunny" },
      ],
      equipped: [1],
      discovered: ["basic:Kite Cat", "meadow:Bunny"],
      nextPetId: 3,
    });
    await sleep(100);

    const saved = fake.docs.get("u1")!;
    assert.strictEqual(saved.power, 500);
    assert.strictEqual(saved.username, "Pilot");
    assert.strictEqual(saved.bestDistance, 640.25);
    assert.strictEqual(saved.furthestZone, 2);
    // Starter plane is always kept, unknown/invalid indices dropped.
    assert.deepStrictEqual(saved.ownedPlanes, [0, 1, 3]);
    assert.strictEqual(saved.equippedPlane, 3);
    assert.strictEqual(saved.pets!.length, 2);
    assert.deepStrictEqual(saved.equipped, [1]);
    assert.strictEqual(saved.nextPetId, 3);

    // A fresh session for the same account is handed the saved doc.
    // Same account joining again evicts client1 (see the eviction test). The
    // `progress` reply can land before a client-side handler is registered, so
    // capture it on the server side.
    let progress: any = null;
    const r = room as any;
    const origLoad = r.loadProgress.bind(r);
    r.loadProgress = (c: any, ...rest: any[]) => {
      const origSend = c.send.bind(c);
      c.send = (type: string, msg: any) => {
        if (type === "progress") progress = msg;
        origSend(type, msg);
      };
      return origLoad(c, ...rest);
    };
    const client2 = await colyseus.connectTo(room, { userId: "u1" });
    await sleep(100);
    assert.ok(progress, "progress message was sent");
    assert.strictEqual(progress.wins, 12);
    assert.strictEqual(progress.equippedPlane, 3);
    assert.strictEqual(progress.furthestZone, 2);
    assert.deepStrictEqual(progress.ownedPlanes, [0, 1, 3]);
    // Pets come back with the rest of the save.
    assert.deepStrictEqual(progress.pets, [
      { id: 1, egg: "basic", name: "Kite Cat" },
      { id: 2, egg: "meadow", name: "Bunny" },
    ]);
    assert.deepStrictEqual(progress.equipped, [1]);
    assert.strictEqual(progress.nextPetId, 3);
    assert.strictEqual(client2.state.players.get(client2.sessionId).wins, 12);
    assert.strictEqual(client2.state.players.get(client2.sessionId).equippedPlane, 3);
  });

  it("falls back to the starter plane when the saved equipped plane isn't owned", async () => {
    const fake = fakePlayersCollection([baseDoc({ _id: "u2", ownedPlanes: [0, 2], equippedPlane: 7 })]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const c = await colyseus.connectTo(room, { userId: "u2" });
    await sleep(100);
    assert.strictEqual(c.state.players.get(c.sessionId).equippedPlane, 0);
  });

  it("sends noProgress to a brand-new account", async () => {
    __setPlayersForTest(fakePlayersCollection());
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const r = room as any;
    const sent: any[] = [];
    const origLoad = r.loadProgress.bind(r);
    r.loadProgress = (c: any, ...rest: any[]) => {
      const origSend = c.send.bind(c);
      c.send = (type: string, msg: any) => {
        sent.push([type, msg]);
        origSend(type, msg);
      };
      return origLoad(c, ...rest);
    };
    await colyseus.connectTo(room, { userId: "fresh" });
    await sleep(100);
    assert.deepStrictEqual(sent[0], ["noProgress", {}]);
  });

  it("claimed guest saves are ignored", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const guest = await colyseus.connectTo(room);
    guest.send("saveProgress", { power: 999 });
    await sleep(50);
    assert.strictEqual(fake.docs.size, 0);
  });

  it("broadcasts a leaderboard merging online players with saved offline ones", async () => {
    const fake = fakePlayersCollection([
      baseDoc({ _id: "off1", username: "OfflineAce", power: 9000, level: 40, playTime: 7200, wins: 100, rebirths: 4 }),
      baseDoc({ _id: "u1", username: "Me", power: 1 }), // online below -- must not duplicate
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { userId: "u1", username: "Me" });
    client1.send("stats", { power: 500, wins: 300, rebirths: 2 });
    await room.waitForNextPatch();

    const board: any = await new Promise((resolve) => {
      client1.onMessage("leaderboard", resolve);
      void (room as any).refreshLeaderboard();
    });
    assert.deepStrictEqual(
      board.rebirths.map((r: any) => [r.name, r.value]),
      [["OfflineAce", 4], ["Me", 2]],
    );
    assert.strictEqual(board.rebirths.filter((r: any) => r.name === "Me").length, 1);
    // Online live value beats the stale saved one; ranked above the offline row.
    assert.deepStrictEqual(
      board.wins.map((r: any) => [r.name, r.value]),
      [["Me", 300], ["OfflineAce", 100]],
    );
    assert.strictEqual(board.playTime[0].value, 7200);
    assert.ok(board.rebirths[1].id === client1.sessionId, "own row keeps the session id");
    assert.ok(board.rebirths[0].id.startsWith("offline:"), "offline rows never expose the real id");
    assert.deepStrictEqual(Object.keys(board).sort(), ["playTime", "rebirths", "wins"]);
  });

  it("counts server-measured playtime for signed-in players and persists it with $inc", async () => {
    const fake = fakePlayersCollection([baseDoc({ _id: "u1", playTime: 100 })]);
    // The fake has no $inc; emulate it so the flush is observable.
    const origUpdate = fake.updateOne.bind(fake);
    (fake as any).updateOne = async (f: any, u: any, o: any) => {
      if (u.$inc) {
        const d = fake.docs.get(f._id)!;
        d.playTime = (d.playTime ?? 0) + u.$inc.playTime;
        return;
      }
      return origUpdate(f, u, o);
    };
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const c = await colyseus.connectTo(room, { userId: "u1" });
    await sleep(100);
    const r = room as any;
    assert.strictEqual(c.state.players.get(c.sessionId).playTime, 100);
    // Pretend 90s have passed, then flush.
    r.playTimeMark.set(c.sessionId, Date.now() - 90_000);
    r.flushAllPlaytime();
    await sleep(50);
    assert.strictEqual(fake.docs.get("u1")!.playTime, 190);
    assert.strictEqual(room.state.players.get(c.sessionId).playTime, 190);
    // A client cannot forge it through saveProgress.
    c.send("saveProgress", { power: 10, playTime: 999999 });
    await sleep(50);
    assert.strictEqual(fake.docs.get("u1")!.playTime, 190);
    assert.strictEqual(fake.docs.get("u1")!.level, 2);
  });

  it("relays a throw to everyone but the sender, tagged and rate-limited", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const thrower = await colyseus.connectTo(room);
    const watcher = await colyseus.connectTo(room);
    const seenByWatcher: any[] = [];
    const seenByThrower: any[] = [];
    watcher.onMessage("throw", (m) => seenByWatcher.push(m));
    thrower.onMessage("throw", (m) => seenByThrower.push(m));

    thrower.send("throw", { kind: "street", range: 99999 });
    thrower.send("throw", { kind: "pad", pad: 2 }); // too soon after the first: dropped
    await sleep(80);
    assert.deepStrictEqual(seenByWatcher, [{ id: thrower.sessionId, kind: "street", range: 3500 }]);
    assert.strictEqual(seenByThrower.length, 0);

    (room as any).lastThrowAt.clear(); // skip the interval rather than sleep through it
    thrower.send("throw", { kind: "bogus" }); // invalid: dropped, doesn't use up the interval
    thrower.send("throw", { kind: "free", dx: 3, dz: -4 });
    await sleep(80);
    assert.strictEqual(seenByWatcher.length, 2);
    assert.deepStrictEqual(seenByWatcher[1], { id: thrower.sessionId, kind: "free", dx: 0.6, dz: -0.8 });
  });

  describe("tutorialStep", () => {
    it("clamps a saved step to 0..5 and ignores junk", () => {
      assert.strictEqual(sanitizeProgress({ tutorialStep: 3.9 })!.tutorialStep, 3);
      assert.strictEqual(sanitizeProgress({ tutorialStep: 99 })!.tutorialStep, 5);
      assert.strictEqual(sanitizeProgress({ tutorialStep: -2 })!.tutorialStep, 0);
      assert.strictEqual(sanitizeProgress({ tutorialStep: "4" })!.tutorialStep, undefined);
    });

    it("resolves legacy docs as finished and raises an undercounted step", () => {
      // No stored step (predates the field) -> finished.
      assert.strictEqual(resolveTutorialStep(baseDoc()), 5);
      // Stored step is kept when stats don't prove more.
      assert.strictEqual(resolveTutorialStep(baseDoc({ tutorialStep: 1 })), 1);
      assert.strictEqual(resolveTutorialStep(baseDoc({ tutorialStep: 0 })), 0);
      // ...but raised when stats prove the player is further along.
      assert.strictEqual(resolveTutorialStep(baseDoc({ tutorialStep: 0, power: 30 })), 1);
      assert.strictEqual(resolveTutorialStep(baseDoc({ tutorialStep: 0, wins: 3 })), 2);
      assert.strictEqual(resolveTutorialStep(baseDoc({ tutorialStep: 0, ownedPlanes: [0, 1] })), 2);
      assert.strictEqual(resolveTutorialStep(baseDoc({ tutorialStep: 0, ownedPlanes: [0, 1], equippedPlane: 1 })), 3);
      assert.strictEqual(resolveTutorialStep(baseDoc({ tutorialStep: 0, power: 229 })), 4); // level 20
      assert.strictEqual(resolveTutorialStep(baseDoc({ tutorialStep: 0, rebirths: 1 })), 5);
      // Never lowered.
      assert.strictEqual(resolveTutorialStep(baseDoc({ tutorialStep: 4 })), 4);
    });

    it("persists it via saveProgress and sends it (or noProgress) on join", async () => {
      const fake = fakePlayersCollection();
      __setPlayersForTest(fake);
      const room = await colyseus.createRoom<LobbyState>("lobby", {});
      const r = room as any;
      const sent: any[] = [];
      const origLoad = r.loadProgress.bind(r);
      r.loadProgress = (c: any, ...rest: any[]) => {
        const origSend = c.send.bind(c);
        c.send = (type: string, msg: any) => {
          sent.push([type, msg]);
          origSend(type, msg);
        };
        return origLoad(c, ...rest);
      };
      const first = await colyseus.connectTo(room, { userId: "tut1" });
      await sleep(100);
      assert.deepStrictEqual(sent[0], ["noProgress", {}]); // brand-new account

      first.send("saveProgress", { power: 10, tutorialStep: 2 });
      await sleep(80);
      assert.strictEqual(fake.docs.get("tut1")!.tutorialStep, 2);

      sent.length = 0;
      await colyseus.connectTo(room, { userId: "tut1" }); // evicts `first`, reloads
      await sleep(100);
      const progress = sent.find(([t]) => t === "progress");
      assert.strictEqual(progress[1].tutorialStep, 2);
    });
  });

  describe("sanitizeThrow", () => {
    it("accepts the three kinds and rejects junk", () => {
      assert.deepStrictEqual(sanitizeThrow({ kind: "street", range: -5 }), { kind: "street", range: 0 });
      assert.deepStrictEqual(sanitizeThrow({ kind: "pad", pad: 8 }), { kind: "pad", pad: 8 });
      assert.strictEqual(sanitizeThrow({ kind: "pad", pad: 9 }), null);
      assert.strictEqual(sanitizeThrow({ kind: "pad", pad: 1.5 }), null);
      assert.strictEqual(sanitizeThrow({ kind: "free", dx: 0, dz: 0 }), null);
      assert.strictEqual(sanitizeThrow({ kind: "street" }), null);
      assert.strictEqual(sanitizeThrow(null), null);
    });
  });

  describe("sanitizeProgress", () => {
    it("rejects non-objects and clamps values", () => {
      assert.strictEqual(sanitizeProgress(null), null);
      assert.strictEqual(sanitizeProgress("x"), null);
      const out = sanitizeProgress({
        power: 1e30,
        rebirths: 99999.7,
        wins: -4,
        bestDistance: NaN,
        furthestZone: 42,
        equippedPlane: -1,
      })!;
      assert.strictEqual(out.power, 1_000_000_000_000);
      assert.strictEqual(out.rebirths, 5000);
      assert.strictEqual(out.wins, 0);
      assert.strictEqual(out.bestDistance, undefined);
      assert.strictEqual(out.furthestZone, 9);
      assert.strictEqual(out.equippedPlane, undefined);
      // No `pets` array (an older client): the pet fields are left out, not wiped.
      assert.strictEqual(out.pets, undefined);
      assert.strictEqual(out.equipped, undefined);
    });

    it("keeps only known pets, owned equipped ids, known discovered keys, and a next id past them", () => {
      const out = sanitizeProgress({
        pets: [
          { id: 1, egg: "basic", name: "Pigeon" },
          { id: 2, egg: "basic", name: "Dragon" }, // not in the Basic Egg
          { id: 1, egg: "meadow", name: "Bunny" }, // duplicate id
          { id: 7, egg: "sunset", name: "Parrot" },
          { id: 0, egg: "basic", name: "Pigeon" }, // ids start at 1
          { id: 3, egg: "nope", name: "Pigeon" }, // unknown egg
          null,
        ],
        equipped: [7, 7, 2, 99],
        discovered: ["basic:Pigeon", "meadow:Fairy Fox", "basic:Nope", 5, "junk"],
        nextPetId: 3,
      })!;
      assert.deepStrictEqual(out.pets, [
        { id: 1, egg: "basic", name: "Pigeon" },
        { id: 7, egg: "sunset", name: "Parrot" },
      ]);
      assert.deepStrictEqual(out.equipped, [7]);
      assert.deepStrictEqual(out.discovered!.sort(), ["basic:Pigeon", "meadow:Fairy Fox", "sunset:Parrot"]);
      assert.strictEqual(out.nextPetId, 8);
    });

    it("caps the pet inventory and the equipped list", () => {
      const pets = Array.from({ length: 80 }, (_, i) => ({ id: i + 1, egg: "basic", name: "Pigeon" }));
      const out = sanitizeProgress({ pets, equipped: pets.map((p) => p.id), nextPetId: 81 })!;
      assert.strictEqual(out.pets!.length, 60);
      assert.strictEqual(out.equipped!.length, 10);
      assert.strictEqual(out.nextPetId, 81);
    });
  });

  describe("daily rewards", () => {
    const T0 = 1_700_000_000_000;

    it("unlocks a day at a time, claims each once, and starts the next cycle a week on", () => {
      let d = freshDaily(T0);
      assert.deepStrictEqual(claimDaily(d, 2, T0), { ok: false, daily: d, reason: "locked" });
      assert.strictEqual((claimDaily(d, 0, T0) as any).reason, "day");
      assert.strictEqual((claimDaily(d, "1", T0) as any).reason, "day");
      const one = claimDaily(d, 1, T0) as any;
      assert.ok(one.ok);
      assert.deepStrictEqual(one.reward, DAILY_REWARDS[0]);
      assert.deepStrictEqual(one.daily.claimed, [1]);
      assert.deepStrictEqual(d.claimed, [], "pure: the input is untouched");
      d = one.daily;
      assert.strictEqual((claimDaily(d, 1, T0) as any).reason, "claimed");
      // Day 2 opens one day in; skipped days stay claimable later, in any order.
      for (const day of [2, 3, 4, 5, 6, 7]) {
        const now = T0 + 6 * DAILY_DAY_MS;
        const r = claimDaily(d, day, now) as any;
        assert.ok(r.ok, `day ${day}`);
        d = r.daily;
      }
      // All seven claimed: a new cycle whose Day 1 opens a week after the last began.
      assert.deepStrictEqual(d, { start: T0 + 7 * DAILY_DAY_MS, claimed: [] });
      assert.strictEqual((claimDaily(d, 1, T0 + 6.5 * DAILY_DAY_MS) as any).reason, "locked");
    });

    it("restarts a stale cycle from now rather than handing over a week at once", () => {
      let d = freshDaily(T0);
      for (let day = 1; day <= 7; day++) d = (claimDaily(d, day, T0 + 30 * DAILY_DAY_MS) as any).daily;
      assert.deepStrictEqual(d, { start: T0 + 30 * DAILY_DAY_MS, claimed: [] });
    });

    it("sanitizes a stored cycle", () => {
      assert.deepStrictEqual(sanitizeDaily(null, T0), freshDaily(T0));
      assert.deepStrictEqual(sanitizeDaily({ start: "x" }, T0), freshDaily(T0));
      assert.deepStrictEqual(sanitizeDaily({ start: T0 + 99, claimed: [3, 1, 3, 9, 0, 2.5, "4"] }, T0), { start: T0, claimed: [1, 3] });
    });

    it("keeps only known stored eggs and potions, as whole counts", () => {
      const out = sanitizeProgress({
        storedEggs: { unicorn: 2, demon: 1.5, dragonite: 4, basic: -1, sphinx: 5000 },
        potions: { "wins:5": 3, "power:5": 0, "power:61": 1, "luck:5": 2, "power:15": 1 },
      })!;
      assert.deepStrictEqual(out.storedEggs, { unicorn: 2, sphinx: 999 });
      assert.deepStrictEqual(out.potions, { "wins:5": 3, "power:15": 1 });
      assert.strictEqual(sanitizeProgress({ wins: 1 })!.storedEggs, undefined, "absent: the saved ones stay");
    });

    it("saves stored eggs and potions and hands them back on the next sign-in", async () => {
      const fake = fakePlayersCollection();
      __setPlayersForTest(fake);
      const room = await colyseus.createRoom<LobbyState>("lobby", {});
      const c1 = await colyseus.connectTo(room, { userId: "items" });
      c1.send("saveProgress", { wins: 1, storedEggs: { unicorn: 1, demon: 2 }, potions: { "wins:5": 2, "power:5": 1 } });
      await sleep(100);
      assert.deepStrictEqual(fake.docs.get("items")!.storedEggs, { unicorn: 1, demon: 2 });
      let progress: any = null;
      const r = room as any;
      const origLoad = r.loadProgress.bind(r);
      r.loadProgress = (c: any, ...rest: any[]) => {
        const origSend = c.send.bind(c);
        c.send = (type: string, msg: any) => {
          if (type === "progress") progress = msg;
          origSend(type, msg);
        };
        return origLoad(c, ...rest);
      };
      await colyseus.connectTo(room, { userId: "items" });
      await sleep(100);
      assert.deepStrictEqual(progress.storedEggs, { unicorn: 1, demon: 2 });
      assert.deepStrictEqual(progress.potions, { "wins:5": 2, "power:5": 1 });
    });

    it("keeps x2 Power / x2 Wins flags only when exactly true", () => {
      const out = sanitizeProgress({ x2Owned: { power: true, wins: "yes" }, x2On: { power: 1, wins: true } })!;
      assert.deepStrictEqual(out.x2Owned, { power: true, wins: false });
      assert.deepStrictEqual(out.x2On, { power: false, wins: true });
      assert.strictEqual(sanitizeProgress({ wins: 1 })!.x2Owned, undefined, "absent: the saved ones stay");
    });

    it("saves x2 Power / x2 Wins and hands them back on the next sign-in", async () => {
      const fake = fakePlayersCollection();
      __setPlayersForTest(fake);
      const room = await colyseus.createRoom<LobbyState>("lobby", {});
      const c1 = await colyseus.connectTo(room, { userId: "x2" });
      c1.send("saveProgress", { wins: 1, x2Owned: { power: true, wins: true }, x2On: { power: false, wins: true } });
      await sleep(100);
      assert.deepStrictEqual(fake.docs.get("x2")!.x2Owned, { power: true, wins: true });
      let progress: any = null;
      const r = room as any;
      const origLoad = r.loadProgress.bind(r);
      r.loadProgress = (c: any, ...rest: any[]) => {
        const origSend = c.send.bind(c);
        c.send = (type: string, msg: any) => {
          if (type === "progress") progress = msg;
          origSend(type, msg);
        };
        return origLoad(c, ...rest);
      };
      await colyseus.connectTo(room, { userId: "x2" });
      await sleep(100);
      assert.deepStrictEqual(progress.x2Owned, { power: true, wins: true });
      assert.deepStrictEqual(progress.x2On, { power: false, wins: true });
    });

    it("keeps only future boosts, capped a week ahead", () => {
      assert.deepStrictEqual(sanitizeBoosts({ power: T0 - 1, wins: T0 + 5000 }, T0), { power: 0, wins: T0 + 5000 });
      assert.deepStrictEqual(sanitizeBoosts({ power: T0 + 99 * DAILY_DAY_MS }, T0), { power: T0 + 7 * 86_400_000, wins: 0 });
      assert.deepStrictEqual(sanitizeBoosts("junk", T0), { power: 0, wins: 0 });
      assert.deepStrictEqual(sanitizeProgress({ boosts: { wins: Date.now() + 1000 } })!.boosts!.power, 0);
    });

    it("claims through the room for a signed-in player, saves it, and refuses repeats and guests", async () => {
      const fake = fakePlayersCollection([baseDoc({ _id: "d1", tutorialStep: 5 })]);
      __setPlayersForTest(fake);
      const room = await colyseus.createRoom<LobbyState>("lobby", {});
      const c = await colyseus.connectTo(room, { userId: "d1" });
      await sleep(100);
      // An older doc gets its cycle saved on first load.
      assert.ok(fake.docs.get("d1")!.daily, "cycle saved on load");
      assert.deepStrictEqual(fake.docs.get("d1")!.daily!.claimed, []);

      const got: any[] = [];
      c.onMessage("dailyClaimed", (m: any) => got.push(["claimed", m]));
      c.onMessage("dailyDenied", (m: any) => got.push(["denied", m]));
      c.send("claimDaily", { day: 1 });
      c.send("claimDaily", { day: 1 }); // a double click
      c.send("claimDaily", { day: 2 }); // not open yet
      await sleep(150);
      // Exactly one grant. (The grant waits on its save, so the refusals can arrive first.)
      assert.strictEqual(got.length, 3);
      const claimed = got.filter(([k]) => k === "claimed").map(([, m]) => m);
      assert.strictEqual(claimed.length, 1);
      assert.deepStrictEqual(claimed[0].reward, DAILY_REWARDS[0]);
      assert.deepStrictEqual(claimed[0].daily.claimed, [1]);
      assert.strictEqual(claimed[0].daily.dayMs, DAILY_DAY_MS);
      const reasons = got.filter(([k]) => k === "denied").map(([, m]) => m.reason).sort();
      assert.deepStrictEqual(reasons, ["claimed", "locked"]);
      assert.deepStrictEqual(fake.docs.get("d1")!.daily!.claimed, [1]);

      // saveProgress can't touch the cycle.
      c.send("saveProgress", { wins: 5, daily: { start: 0, claimed: [] } });
      await sleep(100);
      assert.deepStrictEqual(fake.docs.get("d1")!.daily!.claimed, [1]);

      // A guest has no server-side calendar.
      const guest = await colyseus.connectTo(room, {});
      let denied: any = null;
      guest.onMessage("dailyDenied", (m: any) => (denied = m));
      guest.send("claimDaily", { day: 1 });
      await sleep(100);
      assert.strictEqual(denied?.reason, "signin");
    });

    it("starts and saves a calendar for a brand-new account without hiding its tutorial", async () => {
      const fake = fakePlayersCollection();
      __setPlayersForTest(fake);
      const room = await colyseus.createRoom<LobbyState>("lobby", {});
      await colyseus.connectTo(room, { userId: "newbie" });
      await sleep(100);
      const doc = fake.docs.get("newbie")!;
      assert.deepStrictEqual(doc.daily!.claimed, []);
      assert.strictEqual(resolveTutorialStep(doc), 0, "still starts the tutorial from the beginning");
    });
  });
});
