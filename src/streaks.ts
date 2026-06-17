import {
  getDayRecord,
  listDayRecords,
  listHabits,
  upsertDayRecord,
  type HabitRow,
} from "./db.js";

// ---------- date helpers (timezone-aware) ----------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Format a UTC Date as YYYY-MM-DD in the given IANA timezone. */
export function formatLocalDate(date: Date, timezone: string): string {
  // Intl gives the local date/time parts in the target zone.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Today's date in the given IANA timezone. */
export function todayInTz(timezone: string, now: Date = new Date()): string {
  return formatLocalDate(now, timezone);
}

/** Add `n` days to a YYYY-MM-DD string. Negative n goes back. */
export function addDaysISO(dateStr: string, n: number): string {
  if (!ISO_DATE.test(dateStr)) throw new Error(`invalid ISO date: ${dateStr}`);
  const [y, m, d] = dateStr.split("-").map(Number);
  // UTC midnight of that civil date; day arithmetic is timezone-independent.
  const t = Date.UTC(y, m - 1, d) + n * 86_400_000;
  const dt = new Date(t);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Day of week 0..6 (Sun..Sat) for a YYYY-MM-DD civil date. TZ-independent. */
export function getDayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Is `dateStr` a scheduled occurrence for this habit? */
export function isScheduledOn(habit: HabitRow, dateStr: string): boolean {
  if (habit.frequency === "daily") return true;
  if (!habit.weekly_days) return false;
  let days: number[];
  try {
    days = JSON.parse(habit.weekly_days) as number[];
  } catch {
    return false;
  }
  return Array.isArray(days) && days.includes(getDayOfWeek(dateStr));
}

// ---------- done ↔ count (keeps done derived from count vs target) ----------

/**
 * Record an absolute count for a habit on a date. Auto-derives `done`:
 *   done = (count >= habit.times_per_day).
 * This preserves the schema invariant on every write.
 */
export function recordCount(habit: HabitRow, dateStr: string, count: number): void {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("count must be a non-negative integer");
  }
  const done = count >= habit.times_per_day;
  upsertDayRecord(habit.id, dateStr, { count, done });
}

/** Mark a habit as done for a date. Bumps count to target if it was below. */
export function markDone(habit: HabitRow, dateStr: string): void {
  const existing = getDayRecord(habit.id, dateStr);
  const count = Math.max(existing?.count ?? 0, habit.times_per_day);
  upsertDayRecord(habit.id, dateStr, { count, done: true });
}

/** Mark a habit as not-done for a date. Lowers count below target if needed. */
export function markUndone(habit: HabitRow, dateStr: string): void {
  const existing = getDayRecord(habit.id, dateStr);
  const target = habit.times_per_day;
  const count = Math.min(existing?.count ?? target, target - 1);
  upsertDayRecord(habit.id, dateStr, { count: Math.max(count, 0), done: false });
}

// ---------- streak computation ----------

/** Build a Set<dateStr> of done records for a habit, restricted to scheduled days. */
function doneScheduledSet(habit: HabitRow): Set<string> {
  const set = new Set<string>();
  for (const r of listDayRecords(habit.id)) {
    if (r.done === 1 && isScheduledOn(habit, r.date)) set.add(r.date);
  }
  return set;
}

const MAX_LOOKBACK_DAYS = 366 * 10; // 10 years safety bound

/**
 * Current (alive) streak for a habit as of `asOfDate` (YYYY-MM-DD).
 *  - Counts consecutive done scheduled-days ending at the most recent done
 *    scheduled day.
 *  - The streak is BROKEN if any scheduled day strictly between the last done
 *    day and `asOfDate` is not done. `asOfDate` itself, if scheduled and not
 *    yet done, is NOT a break (the user still has today).
 */
export function getCurrentStreak(habit: HabitRow, asOfDate: string): number {
  const done = doneScheduledSet(habit);
  if (done.size === 0) return 0;

  // Most recent done scheduled day <= asOfDate.
  let cursor = asOfDate;
  let lastDone: string | null = null;
  for (let i = 0; i < MAX_LOOKBACK_DAYS; i++) {
    if (done.has(cursor)) {
      lastDone = cursor;
      break;
    }
    cursor = addDaysISO(cursor, -1);
  }
  if (!lastDone) return 0;

  // No scheduled day in (lastDone, asOfDate) may be missed.
  let probe = addDaysISO(lastDone, 1);
  while (probe < asOfDate) {
    if (isScheduledOn(habit, probe) && !done.has(probe)) return 0;
    probe = addDaysISO(probe, 1);
  }

  // Alive. Walk back from lastDone, counting consecutive done scheduled days.
  let run = 0;
  cursor = lastDone;
  const created = habit.created_at.slice(0, 10);
  for (let i = 0; i < MAX_LOOKBACK_DAYS; i++) {
    if (cursor < created) break;
    if (isScheduledOn(habit, cursor)) {
      if (!done.has(cursor)) break;
      run++;
    }
    cursor = addDaysISO(cursor, -1);
  }
  return run;
}

/**
 * All-time longest streak for a habit. Scans scheduled days from `created_at`
 * to `asOfDate` and returns the longest run of consecutive done scheduled days.
 */
export function getLongestStreak(habit: HabitRow, asOfDate: string): number {
  const done = doneScheduledSet(habit);
  const created = habit.created_at.slice(0, 10);
  let best = 0;
  let run = 0;
  let cursor = created;
  for (let i = 0; i < MAX_LOOKBACK_DAYS; i++) {
    if (cursor > asOfDate) break;
    if (isScheduledOn(habit, cursor)) {
      if (done.has(cursor)) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    cursor = addDaysISO(cursor, 1);
  }
  return best;
}

/** Longest streak across all active habits for a user. */
export function getLongestStreakAcrossHabits(
  userId: number,
  asOfDate: string,
): number {
  const habits = listHabits(userId);
  let best = 0;
  for (const h of habits) {
    const v = getLongestStreak(h, asOfDate);
    if (v > best) best = v;
  }
  return best;
}

export interface HabitProgress {
  habitId: number;
  currentStreak: number;
  longestStreak: number;
  today: { scheduled: boolean; done: boolean; count: number; target: number };
}

/** Per-habit progress snapshot for the habits list / stats views. */
export function getHabitProgress(habit: HabitRow, asOfDate: string): HabitProgress {
  const today = {
    scheduled: isScheduledOn(habit, asOfDate),
    done: false,
    count: 0,
    target: habit.times_per_day,
  };
  if (today.scheduled) {
    const dr = getDayRecord(habit.id, asOfDate);
    if (dr) {
      today.done = dr.done === 1;
      today.count = dr.count;
    }
  }
  return {
    habitId: habit.id,
    currentStreak: getCurrentStreak(habit, asOfDate),
    longestStreak: getLongestStreak(habit, asOfDate),
    today,
  };
}
