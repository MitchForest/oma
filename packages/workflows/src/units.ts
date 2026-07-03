/** Human-friendly counts and durations for workflow budgets. */

const tokenPattern = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/;

/** "500k" -> 500_000, "2M" -> 2_000_000, 1500 -> 1500. */
export function parseTokenCount(value: number | string): number {
  if (typeof value === "number") {
    return value;
  }

  const match = tokenPattern.exec(value.trim());

  if (!match) {
    throw new Error(`Invalid token count: ${value}. Use a number, "500k", or "2M".`);
  }

  const scale = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2] ? 1_000 : 1;
  return Math.round(Number(match[1]) * scale);
}

const durationPattern = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;

const durationScales: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000
};

/** "30m" -> 1_800_000 ms, "2h" -> 7_200_000 ms. */
export function parseDuration(value: string): number {
  const match = durationPattern.exec(value.trim());

  if (!match) {
    throw new Error(`Invalid duration: ${value}. Use "45s", "30m", "2h", or "1d".`);
  }

  return Math.round(Number(match[1]) * durationScales[match[2]!]!);
}

export function isTokenCount(value: string): boolean {
  return tokenPattern.test(value.trim());
}

export function isDuration(value: string): boolean {
  return durationPattern.test(value.trim());
}
