# Paper Plane Server

Colyseus multiplayer server for [Paper-plane](../Paper-plane), structured
after `Stone-Skipping-backend` — same stack (`colyseus` + `@colyseus/schema` +
Mongo persistence + Bloxity Legion deploy), adapted to Paper Plane's game
state: Power, Rebirths, Wins, best street distance, furthest zone,
owned/equipped planes, pets, and the tutorial step (a save from before the
tutorial loads as finished; one that undercounts is raised to what its stats
prove, see `resolveTutorialStep`).

## Usage

```
npm install
npm start
```

Then open http://localhost:2567 for the playground, or /monitor for the monitor.

## Structure

- `src/index.ts`: entry point (connects Mongo, then listens)
- `src/app.config.ts`: rooms, `/health`, CORS, dev-only monitor/playground
- `src/rooms/LobbyRoom.ts`: the single global room every client joins (`client.joinOrCreate("lobby")`)
- `src/rooms/schema/LobbyState.ts`: state synchronized to every client
- `src/db.ts`: Mongo-backed progress persistence (no-op if `MONGODB_URI` is unset/unreachable)
- `src/progression.ts`: port of the client's level table (Level from Power)
- `src/constants.ts`: leaderboard timing, value caps, plane/zone counts
- `test/LobbyRoom.test.ts`: boots the real server against a fake Mongo collection

## Scripts

- `npm start`: watch mode (`tsx watch src/index.ts`)
- `npm test`: mocha suite
- `npm run build`: compile to `build/`
- `npm run loadtest`: N simulated clients

## Wire protocol

Field names match the client's `src/store.js` (`game`).

Join with `client.joinOrCreate("lobby", { username, avatar, userId })`.
`userId` is the stable Bloxity user id — omit it for a guest, whose progress
isn't persisted.

### Client → server

| Message | Payload | Cadence |
|---|---|---|
| `move` | `{ x, y, z, yaw, moveBlend }` | throttled |
| `setAvatar` | `{ avatar }` (opaque JSON string, ≤4 KB) | on connect + on change |
| `stats` | `{ power, wins, rebirths, bestDistance, equippedPlane }` (all optional) | debounced on change |
| `saveProgress` | `{ power, rebirths, wins, bestDistance, furthestZone, ownedPlanes, equippedPlane, pets, equipped, discovered, nextPetId }` | debounced; no-op for a guest |
| `identify` | `{ username, userId }` | when sign-in state changes after join |
| `throw` | `{ kind: "street", range }` \| `{ kind: "pad", pad }` \| `{ kind: "free", dx, dz }` | when a toss starts; at most one per 300 ms is relayed |
| `claimDaily` | `{ day }` (1–7) | when the player presses a day's Claim! button |

Planes are **indices into the client's `MAP.pads`** (0 = the free `+1` plane …
9 = `+1.1K`), exactly as `game.ownedPlanes` / `game.equippedPlane` store them.
Out-of-range or non-integer indices are dropped and plane `0` is always owned.
`furthestZone` is an index into `STREET_ZONES` (0–9); `bestDistance` is metres
up the street, clamped to the street's 3,500 m length.

**Pets** (from eggs): `pets` is `[{ id, egg, name }]` (a per-save positive integer id,
the egg id and the pet's name), `equipped` the equipped pets' ids, `discovered` every
`"egg:name"` ever hatched, and `nextPetId` the next id to hand out. `src/constants.ts`
`EGG_PETS` must list every egg and pet name the client's `EGG_SHOP` has: unknown pets,
duplicate ids, equipped ids that aren't owned and unknown discovered keys are dropped,
the inventory is capped at 60 and the equipped list at 10, and `nextPetId` is raised past
every owned id. A payload without a `pets` array leaves the saved pets untouched.

`multiplier` and `autoThrow` are per-session and not saved.

### Server → client

| Message | Payload | When |
|---|---|---|
| `progress` | saved doc: `{ power, level, playTime, rebirths, wins, bestDistance, furthestZone, ownedPlanes, equippedPlane, pets, equipped, discovered, nextPetId }` | after a signed-in join/identify, if a saved doc exists |
| `noProgress` | `{}` | after a signed-in join/identify, for an account with no save yet |
| `leaderboard` | `{ rebirths, playTime, wins }`, each `Row[]` with `Row = { id, name, value }` | every 15s and on roster changes; live roster merged with all-time Mongo top scorers |
| `throw` | the sender's `throw` plus `id` (their `sessionId`) | to everyone except the thrower |
| `daily` | `{ start, claimed, now, dayMs }`, or `null` after a sign-out | after a signed-in join/identify (with or without a save) |
| `dailyClaimed` | `{ day, reward, daily }` (`daily` as above) | a `claimDaily` the server granted, after saving it |
| `dailyDenied` | `{ day, reason, daily? }`, `reason` = `day` \| `claimed` \| `locked` \| `signin` | a `claimDaily` it refused |

### Daily rewards

A 7-day calendar per **signed-in** account (`src/daily.ts`), saved on its doc as
`daily: { start, claimed }`. Day N unlocks `(N − 1) × dayMs` after `start` and stays
claimable until claimed, in any order; claiming the last unclaimed day starts the next
cycle a week after this one began (or now, if that's already past). The **server** decides
every claim and sends the reward the client then hands out — `DAILY_REWARDS`, mirrored by
the client's `DAILY.days` (src/config.js). Potions and eggs go into the client's Items window
(Potions / Eggs) to drink or hatch later; the pet joins the pets at once:

| Day | Reward |
|---|---|
| 1, 6 | `{ kind: "boost", stat: "wins", ms: 300000 }` (x2 Wins, 5 min) |
| 3, 5 | `{ kind: "boost", stat: "power", ms: 300000 }` (x2 Power, 5 min) |
| 2 | `{ kind: "pet", egg: "daily", name: "Dragon" }` |
| 4 | `{ kind: "egg", egg: "unicorn" }` (one free hatch) |
| 7 | `{ kind: "egg", egg: "demon" }` |

`saveProgress` can't touch `daily`. A claim is recorded before the save is awaited, so a
double click or a second tab can't claim the same day twice. Guests have no account to hold
a calendar: their client keeps one in localStorage and never sends `claimDaily` (the server
answers `signin` if it does). The running boosts travel as `boosts: { power, wins }` (epoch
ms each runs until) in `saveProgress` and `progress`; only future ones are kept, at most a
week ahead. Stored items travel the same way as `storedEggs` (egg id → count, ids from
`EGG_PETS`) and `potions` (`"power:5"` / `"wins:5"`, i.e. `stat:minutes` up to 60 → count);
unknown keys are dropped and counts are whole numbers up to 999.

The HUD's x2 Power / x2 Wins (bought once with Wins, then switched on or off) travel as
`x2Owned: { power, wins }` and `x2On: { power, wins }` in `saveProgress` and `progress`;
each flag is true only when sent as exactly `true`, and older docs read as not owned.

A relayed `throw` is cosmetic: receivers play the toss on that player's
character and fly a plane (street throws land `range` metres up the street,
clamped to 3,500; `pad` is an index into the client's `MAP.trainingPads`;
`dx, dz` is normalised). They never earn anything from it.

Three separate boards, drawn in the client's lobby behind the Egg Row:
**rebirths** (ties break on power), **playTime** (total seconds connected,
**measured by the server clock** and `$inc`'d to Mongo every 30s and on leave —
never client-reported, so `saveProgress` can't forge it) and **wins**. Time
spent while disconnected/reconnecting isn't counted, and guest time before
signing in isn't either.

`LobbyState.players` (keyed by `sessionId`) carries `username`, `x/y/z/yaw`,
`moveBlend`, `avatar`, `equippedPlane`, `power`, `level`, `playTime`, `wins`,
`rebirths`, `bestDistance` for every connected player.

The server trusts the client for gameplay values (as the client is
authoritative locally); it only enforces shape and bounds so a bad payload
can't corrupt the sender's own save.

## Environment

- `MONGODB_URI` — injected by Bloxity Legion; unset locally (persistence off).
- `CLIENT_ORIGIN` — injected when deployed; CORS falls back to `*` locally.
- `PORT` — injected by Legion; falls back to 2567.
- `DAILY_DAY_MS` — length of a daily-rewards "day" in ms (default 86400000); shorten it to test locally.

## Deploy

`.github/workflows/deploy.yml`: pull requests run build + tests; pushes to `dev`
deploy the `dev` channel and `main` the `prod` channel on Bloxity Legion (Docker
image pushed to GHCR, then the Legion deploy API is called). Needs the repo
**variable** `LEGION_GAME_ID` (= the client's `GAME_SLUG`, `paper-plane`) and the
**secret** `LEGION_DEPLOY_TOKEN`.
