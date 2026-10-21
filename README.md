# Paper Plane Server

Colyseus multiplayer server for [Paper-plane](../Paper-plane), structured
after `Stone-Skipping-backend` — same stack (`colyseus` + `@colyseus/schema` +
Mongo persistence + Bloxity Legion deploy), adapted to Paper Plane's game
state: Power, Rebirths, Wins, best street distance, furthest zone, and
owned/equipped planes.

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
| `saveProgress` | `{ power, rebirths, wins, bestDistance, furthestZone, ownedPlanes, equippedPlane }` | debounced; no-op for a guest |
| `identify` | `{ username, userId }` | when sign-in state changes after join |
| `throw` | `{ kind: "street", range }` \| `{ kind: "pad", pad }` \| `{ kind: "free", dx, dz }` | when a toss starts; at most one per 300 ms is relayed |

Planes are **indices into the client's `MAP.pads`** (0 = the free `+1` plane …
9 = `+1.1K`), exactly as `game.ownedPlanes` / `game.equippedPlane` store them.
Out-of-range or non-integer indices are dropped and plane `0` is always owned.
`furthestZone` is an index into `STREET_ZONES` (0–9); `bestDistance` is metres
up the street, clamped to the street's 3,500 m length.

`multiplier` and `autoThrow` are per-session and not saved.

### Server → client

| Message | Payload | When |
|---|---|---|
| `progress` | saved doc: `{ power, level, playTime, rebirths, wins, bestDistance, furthestZone, ownedPlanes, equippedPlane }` | after a signed-in join/identify, if a saved doc exists |
| `noProgress` | `{}` | after a signed-in join/identify, for an account with no save yet |
| `leaderboard` | `{ level, playTime, power, wins }`, each `Row[]` with `Row = { id, name, value }` | every 15s and on roster changes; live roster merged with all-time Mongo top scorers |
| `throw` | the sender's `throw` plus `id` (their `sessionId`) | to everyone except the thrower |

A relayed `throw` is cosmetic: receivers play the toss on that player's
character and fly a plane (street throws land `range` metres up the street,
clamped to 3,500; `pad` is an index into the client's `MAP.trainingPads`;
`dx, dz` is normalised). They never earn anything from it.

Four separate boards: **level** (derived on the server from `power` using the
client's level table in `src/progression.ts`; ties break on power),
**playTime** (total seconds connected, **measured by the server clock** and
`$inc`'d to Mongo every 30s and on leave — never client-reported, so
`saveProgress` can't forge it), **power** and **wins**. Time spent while
disconnected/reconnecting isn't counted, and guest time before signing in
isn't either.

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

## Deploy

`.github/workflows/deploy.yml`: pull requests run build + tests; pushes to `dev`
deploy the `dev` channel and `main` the `prod` channel on Bloxity Legion (Docker
image pushed to GHCR, then the Legion deploy API is called). Needs the repo
**variable** `LEGION_GAME_ID` (= the client's `GAME_SLUG`, `paper-plane`) and the
**secret** `LEGION_DEPLOY_TOKEN`.
