// LobbyRoom.ts's refreshLeaderboard(): how often it re-queries Mongo for the
// all-time top players per stat, and how many rows it fetches per stat before
// merging with the live online roster.
export const LEADERBOARD_REFRESH_MS = 15_000;
export const LEADERBOARD_QUERY_LIMIT = 20;

// Playtime: how often each connected player's elapsed time is added to their
// total (in memory for everyone, $inc'd to Mongo for signed-in players).
export const PLAYTIME_FLUSH_MS = 30_000;

// Client src/progression.js's POWER_MAX / REBIRTH_MAX, and WINS_INITIAL's
// upper bound. Saved values are clamped to these so a forged payload can't push
// a bogus number onto the leaderboards.
export const POWER_MAX = 1_000_000_000_000;
export const REBIRTH_MAX = 5000;
export const WINS_MAX = Number.MAX_SAFE_INTEGER;

// Client src/config.js's STREET.length: metres from the Throw Area to the far
// end, so no throw can land further. bestDistance is clamped to it.
export const STREET_LENGTH = 3500;

// Client src/config.js's STREET_ZONES.length (Neighbourhood .. Sky Port).
// furthestZone is an index into that list.
export const ZONE_COUNT = 10;

// Client src/config.js's MAP.pads.length -- the Plane Hall's purchase pads.
// Planes are referred to by their index into that list, kept in sync by
// comment cross-reference, not a shared import. Pad 0 (+1) is the free starter
// plane every player owns.
export const PLANE_COUNT = 10;
export const DEFAULT_PLANE = 0;

// Client src/config.js's MAP.trainingPads.length -- a pad throw names its pad by index.
export const TRAINING_PAD_COUNT = 9;

// `throw` relay: a client tosses at most every ~0.7 s (ANIM.toss + THROW.reloadTime),
// so anything faster is a forged/duplicated packet and is dropped, not relayed.
export const THROW_MIN_INTERVAL_MS = 300;
