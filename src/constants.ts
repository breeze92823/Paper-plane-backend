// LobbyRoom.ts's refreshLeaderboard(): how often it re-queries Mongo for the
// all-time top players per stat, and how many rows it fetches per stat before
// merging with the live online roster.
export const LEADERBOARD_REFRESH_MS = 15_000;
export const LEADERBOARD_QUERY_LIMIT = 20;

// Client src/store.js's tutorialStep: 0 Power, 1 Wins, 2 equip a new plane, 3 level 20,
// 4 rebirth, 5 done (src/tutorial.js). The thresholds mirror the client's TUTORIAL in
// src/config.js, kept in sync by comment cross-reference, not a shared import.
export const TUTORIAL_DONE_STEP = 5;
export const TUTORIAL_POWER = 30;
export const TUTORIAL_WINS = 3;
export const TUTORIAL_LEVEL = 20;

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

// Client src/config.js's EGG_SHOP: every pet name each egg can hatch, kept in sync by
// comment cross-reference, not a shared import. A saved pet is { id, egg, name }; one
// whose egg/name isn't listed here is dropped, so a client release that adds pets must
// add them here too.
export const EGG_PETS: Readonly<Record<string, readonly string[]>> = {
  basic: ["Paper Crane", "Pigeon", "Origami Frog", "Kite Cat", "Balloon Pup", "Golden Crane"],
  meadow: ["Ladybug", "Bunny", "Butterfly", "Bumblebee", "Hummingbird", "Fairy Fox"],
  sunset: ["Sunset Duck", "Flamingo", "Parrot", "Phoenix Chick", "Sun Hawk", "Sunset Dragon"],
  unicorn: ["Cloud Pony", "Moon Bat", "Rainbow Owl", "Star Cat", "Unicorn", "Galaxy Unicorn"],
  sphinx: ["Camel", "Scarab", "Falcon", "Jackal", "Sphinx", "Golden Sphinx"],
  demon: ["Demon Dragon"],
  // Not an egg anyone buys: pets only the daily rewards hand out (src/daily.ts).
  daily: ["Dragon"],
};
// Client EGGS.inventoryMax: most pets a save can hold.
export const PET_INVENTORY_MAX = 60;
// Ceiling on the equipped list. The client starts at EGGS.slots (1) and re-clamps to its
// own slot count on load; this only stops a forged payload equipping the whole inventory.
export const PET_SLOTS_MAX = 10;

// Timed x2 boosts (daily-reward potions): a saved boost runs at most this far past the save
// time, so a forged payload can't buy a permanent x2.
export const BOOST_MAX_MS = 7 * 86_400_000;

// Stored items (the client's Items window): at most this many of any one egg or potion. A
// potion is keyed `${stat}:${minutes}` (power|wins, 1..POTION_MAX_MINUTES); an egg by its
// EGG_PETS id.
export const STORED_MAX = 999;
export const POTION_MAX_MINUTES = 60;

// Client src/config.js's MAP.trainingPads.length -- a pad throw names its pad by index.
export const TRAINING_PAD_COUNT = 9;

// `throw` relay: a client tosses at most every ~0.7 s (ANIM.toss + THROW.reloadTime),
// so anything faster is a forged/duplicated packet and is dropped, not relayed.
export const THROW_MIN_INTERVAL_MS = 300;
