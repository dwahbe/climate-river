// lib/evalCli.ts
// Shared helpers for CLI eval scripts (rewrite-bakeoff.ts, web-search-eval.ts).

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
