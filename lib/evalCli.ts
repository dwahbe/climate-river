// lib/evalCli.ts
// Shared CLI helpers for the eval scripts (rewrite-bakeoff, web-search-eval,
// categorize-bakeoff), for judge, judge-report and headline-check, and for the
// maintenance scripts' numeric flags.

import path from "node:path";

/**
 * Match `--flag value` or `--flag=value`. Returns null if argv[i] isn't this flag.
 * `skip` is 1 for the space-separated form (caller should advance), 0 for `=`.
 */
export function parseCliArg(
  argv: string[],
  i: number,
  flag: string,
): { value: string; skip: number } | null {
  const arg = argv[i];
  if (arg === flag) {
    return { value: argv[i + 1] ?? "", skip: 1 };
  }
  if (arg.startsWith(`${flag}=`)) {
    return { value: arg.slice(flag.length + 1), skip: 0 };
  }
  return null;
}

/**
 * Numeric value of `--name N` or `--name=N`; undefined when the flag is absent.
 * Throws when the value is missing or not a number, so a mistyped flag can't
 * silently fall back to a script's default.
 */
export function parseNumberFlag(
  argv: string[],
  name: string,
): number | undefined {
  const flag = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    const match = parseCliArg(argv, i, flag);
    if (!match) continue;
    const value = match.value.trim();
    const parsed = Number(value);
    if (value === "" || !Number.isFinite(parsed)) {
      throw new Error(`${flag} needs a number, got "${match.value}"`);
    }
    return parsed;
  }
  return undefined;
}

/** ISO timestamp safe for use as a directory name. */
export function timestampLabel(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** `tmp/<subdir>/<timestamp>/` under cwd. */
export function defaultEvalOutDir(subdir: string): string {
  return path.join(process.cwd(), "tmp", subdir, timestampLabel());
}

/** Returns the value at the given percentile (0-100), or null on empty input. */
export function percentile(values: number[], pct: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export function median(values: number[]): number | null {
  return percentile(values, 50);
}
