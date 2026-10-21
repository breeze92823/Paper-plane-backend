// Daily rewards: a 7-day calendar per signed-in account (client src/daily.js and the
// Daily Rewards window, src/dailyUi.js). Day N unlocks (N - 1) days after the cycle's
// `start` and stays claimable until claimed, in any order. Claiming the last unclaimed day
// starts the next cycle a full week after this one began (or now, if that's already past),
// so a returning player never banks a whole week at once.
//
// The SERVER decides here: whether a day is unlocked, whether it was already claimed, and
// what it grants. The client only applies the reward it is handed. Guests have no account to
// hold this, so the client keeps theirs locally (src/daily.js) and this never sees them.

// One reward. `ms` is the boost's length; a pet comes from DAILY_PET_EGG (constants.ts
// EGG_PETS); an egg is hatched once, free, on the client with its normal odds.
export type DailyReward =
  | { kind: "boost"; stat: "power" | "wins"; ms: number }
  | { kind: "pet"; egg: string; name: string }
  | { kind: "egg"; egg: string };

const MIN = 60_000;

// Day 1 first. Mirrors the client's DAILY.rewards (src/config.js), which only draws them.
export const DAILY_REWARDS: readonly DailyReward[] = [
  { kind: "boost", stat: "wins", ms: 5 * MIN },
  { kind: "pet", egg: "daily", name: "Dragon" },
  { kind: "boost", stat: "power", ms: 5 * MIN },
  { kind: "egg", egg: "unicorn" },
  { kind: "boost", stat: "power", ms: 5 * MIN },
  { kind: "boost", stat: "wins", ms: 5 * MIN },
  { kind: "egg", egg: "demon" },
];
export const DAILY_DAYS = DAILY_REWARDS.length;

// Real days in production; DAILY_DAY_MS (env) shortens them for local testing.
export const DAILY_DAY_MS = Number(process.env.DAILY_DAY_MS) > 0 ? Number(process.env.DAILY_DAY_MS) : 86_400_000;

// Saved on the player's doc as `daily`.
export interface DailyDoc {
  start: number; // epoch ms the current cycle's Day 1 unlocked
  claimed: number[]; // days (1..DAILY_DAYS) claimed this cycle
}

export const freshDaily = (now: number): DailyDoc => ({ start: now, claimed: [] });

// A stored (or hand-edited) doc made safe: a finite start no later than now, and unique
// in-range claimed days. Anything unusable starts a fresh cycle.
export function sanitizeDaily(raw: unknown, now: number): DailyDoc {
  const src = raw as Partial<DailyDoc> | null;
  if (!src || typeof src.start !== "number" || !Number.isFinite(src.start)) return freshDaily(now);
  const claimed = Array.isArray(src.claimed)
    ? [...new Set(src.claimed.filter((d) => Number.isInteger(d) && d >= 1 && d <= DAILY_DAYS))].sort((a, b) => a - b)
    : [];
  return { start: Math.min(src.start, now), claimed };
}

export const dailyUnlockAt = (d: DailyDoc, day: number) => d.start + (day - 1) * DAILY_DAY_MS;

// What the client is sent: the cycle plus the server's clock and day length, so its
// countdowns run on server time whatever the device clock says.
export const dailyView = (d: DailyDoc, now: number) => ({ start: d.start, claimed: d.claimed, now, dayMs: DAILY_DAY_MS });

export type ClaimResult =
  | { ok: true; daily: DailyDoc; reward: DailyReward }
  | { ok: false; daily: DailyDoc; reason: "day" | "claimed" | "locked" };

// Pure: claims `day` on `d` at `now`, returning the new doc (never mutating `d`).
export function claimDaily(d: DailyDoc, day: unknown, now: number): ClaimResult {
  if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > DAILY_DAYS) return { ok: false, daily: d, reason: "day" };
  const n = day as number;
  if (d.claimed.includes(n)) return { ok: false, daily: d, reason: "claimed" };
  if (now < dailyUnlockAt(d, n)) return { ok: false, daily: d, reason: "locked" };
  const claimed = [...d.claimed, n].sort((a, b) => a - b);
  const daily =
    claimed.length >= DAILY_DAYS ? { start: Math.max(d.start + DAILY_DAYS * DAILY_DAY_MS, now), claimed: [] } : { start: d.start, claimed };
  return { ok: true, daily, reward: DAILY_REWARDS[n - 1] };
}
