import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { JOB_STALE_AFTER_HOURS } from "../cron";

/**
 * The admin health dashboard flags a job stale after JOB_STALE_AFTER_HOURS.
 * Those thresholds once sat below the real gaps in the cron schedule, so
 * healthy jobs read as stale for hours a day. Pin them to vercel.json.
 */

type VercelCron = { path: string; schedule: string };

const crons: VercelCron[] = JSON.parse(
  readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"),
).crons;

const jobName = (cron: VercelCron) => cron.path.replace("/api/cron/", "");

function fieldValues(field: string, min: number, max: number): number[] {
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);
  if (field === "*") return range(min, max);
  return field.split(",").flatMap((part) => {
    const [from, to] = part.split("-").map(Number);
    return range(from, to ?? from);
  });
}

/** Longest gap between consecutive runs of an "m h * * dow" schedule, in hours. */
function longestGapHours(schedule: string): number {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = schedule.split(/\s+/);
  assert.equal(dayOfMonth, "*", `unsupported day-of-month in "${schedule}"`);
  assert.equal(month, "*", `unsupported month in "${schedule}"`);

  const runs = fieldValues(dayOfWeek, 0, 6)
    .flatMap((day) =>
      fieldValues(hour, 0, 23).flatMap((h) =>
        fieldValues(minute, 0, 59).map((m) => day * 1440 + h * 60 + m),
      ),
    )
    .sort((a, b) => a - b);

  const week = 7 * 1440;
  let longest = 0;
  runs.forEach((run, i) => {
    const next = i + 1 < runs.length ? runs[i + 1] : runs[0] + week;
    longest = Math.max(longest, next - run);
  });
  return longest / 60;
}

describe("longestGapHours", () => {
  it("handles lists, ranges, daily and weekly schedules", () => {
    assert.equal(longestGapHours("0 12,16,18,22,0,4 * * *"), 8);
    assert.equal(longestGapHours("0 0,3,7,11-23 * * *"), 4);
    assert.equal(longestGapHours("30 8 * * *"), 24);
    assert.equal(longestGapHours("0 6 * * 1"), 168);
  });
});

describe("JOB_STALE_AFTER_HOURS vs vercel.json", () => {
  it("has a threshold for every cron job and no others", () => {
    assert.deepEqual(
      Object.keys(JOB_STALE_AFTER_HOURS).sort(),
      crons.map(jobName).sort(),
    );
  });

  for (const cron of crons) {
    const job = jobName(cron);
    it(`${job}: threshold clears the longest scheduled gap`, () => {
      const gap = longestGapHours(cron.schedule);
      const threshold = JOB_STALE_AFTER_HOURS[job];
      // 30 minutes of slack: a run is only logged once it finishes.
      assert.ok(
        threshold >= gap + 0.5,
        `${job}: stale after ${threshold}h but the schedule has a ${gap}h gap`,
      );
    });
  }
});
