import { CronExpressionParser } from "cron-parser";
import * as DateTime from "effect/DateTime";

export interface CronSchedule {
  readonly cron: string;
  readonly timezone: string;
}

// bb's five-field cron contract. Keep the cursor in UTC and let the parser apply the job's zone.
export function validateSchedule({ cron, timezone }: CronSchedule): void {
  if (cron.trim().split(/\s+/u).length !== 5) {
    throw new Error("Expected five cron fields.");
  }
  new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  nextRunAt({ cron, timezone }, 0);
}

export function nextRunAt({ cron, timezone }: CronSchedule, now: number): number {
  return CronExpressionParser.parse(cron, {
    currentDate: DateTime.toDate(DateTime.makeUnsafe(now)),
    tz: timezone,
  })
    .next()
    .getTime();
}
