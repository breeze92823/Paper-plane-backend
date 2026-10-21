import assert from "assert";
import type { Collection } from "mongodb";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { LobbyState } from "../src/rooms/schema/LobbyState.js";
import { sanitizeProgress, sanitizeThrow, type LobbyRoom } from "../src/rooms/LobbyRoom.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";

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
      baseDoc({ _id: "off1", username: "OfflineAce", power: 9000, level: 40, playTime: 7200, wins: 100 }),
      baseDoc({ _id: "u1", username: "Me", power: 1 }), // online below -- must not duplicate
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { userId: "u1", username: "Me" });
    client1.send("stats", { power: 500, wins: 3 });
    await room.waitForNextPatch();

    const board: any = await new Promise((resolve) => {
      client1.onMessage("leaderboard", resolve);
      void (room as any).refreshLeaderboard();
    });
    assert.deepStrictEqual(
      board.power.map((r: any) => [r.name, r.value]),
      [["OfflineAce", 9000], ["Me", 500]],
    );
    assert.strictEqual(board.power.filter((r: any) => r.name === "Me").length, 1);
    assert.strictEqual(board.wins[0].name, "OfflineAce");
    // Level board: derived from power server-side (500 power -> level > 1), offline row first.
    assert.strictEqual(board.level[0].name, "OfflineAce");
    assert.ok(board.level.find((r: any) => r.name === "Me").value > 1);
    assert.strictEqual(board.playTime[0].value, 7200);
    assert.ok(board.power[1].id === client1.sessionId, "own row keeps the session id");
    assert.ok(board.power[0].id.startsWith("offline:"), "offline rows never expose the real id");
    assert.deepStrictEqual(Object.keys(board).sort(), ["level", "playTime", "power", "wins"]);
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
    });
  });
});
