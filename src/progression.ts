import { POWER_MAX } from "./constants.js";

// Port of client src/progression.js's level table (levelCost / levelForPower),
// kept in sync by comment cross-reference, not a shared import. The server
// derives Level from Power itself rather than trusting a client-reported
// level, so the two can never disagree on the leaderboard.
const LEVEL_MIN = 1;
const LEVEL_COSTS_EXACT = [
  ...Array(13).fill(10), // 1->2 .. 13->14
  12, 14, 15, 17, 19, 22, // 14->15 .. 19->20
  44, 53, 62, 71, 80, // 20->21 .. 24->25
];
const TAIL_START = 20;
const TAIL_EXP = 3.85085;
const TAIL_RATE = 0.1161;

function levelCost(level: number): number {
  if (level <= LEVEL_COSTS_EXACT.length) return LEVEL_COSTS_EXACT[Math.max(1, level) - 1];
  const d = level - TAIL_START;
  return Math.round(44 + 9 * d + TAIL_EXP * (Math.exp(TAIL_RATE * d) - 1));
}

// CUM[i] = total Power needed to reach level i + 1.
const CUM = [0];
while (CUM[CUM.length - 1] < POWER_MAX) {
  CUM.push(Math.min(POWER_MAX, CUM[CUM.length - 1] + levelCost(CUM.length)));
}

export function levelForPower(power: number): number {
  const s = Math.max(0, power);
  let lo = 0;
  let hi = CUM.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (CUM[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return LEVEL_MIN + lo;
}
