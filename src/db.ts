import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./migrations.js";

/** Resolved DB path: env override, else ./data/streakly.db (created on demand). */
export function resolveDbPath(): string {
  const fromEnv = process.env.STREAKLY_DB_PATH;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return "data/streakly.db";
}

/** Open a better-sqlite3 connection with sane pragmas for a bot workload. */
export function openDb(path: string = resolveDbPath()): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  return db;
}

/** Apply every pending migration from MIGRATIONS, in order, in one transaction. */
export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT    NOT NULL
    );
  `);
  const applied = new Set(
    db.prepare<[], { version: number }>("SELECT version FROM migrations").all().map((r) => r.version),
  );
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return;
  const insert = db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, ?)");
  const tx = db.transaction((ms: typeof pending) => {
    for (const m of ms) {
      db.exec(m.up);
      insert.run(m.version, new Date().toISOString());
    }
  });
  tx(pending);
}

// ---------- types ----------

export interface UserRow {
  id: number;
  telegram_user_id: number;
  display_name: string | null;
  timezone: string | null;
  created_at: string;
  updated_at: string;
}

export type Frequency = "daily" | "weekly";

export interface HabitRow {
  id: number;
  user_id: number;
  name: string;
  frequency: Frequency;
  times_per_day: number;
  weekly_days: string | null; // JSON array of 0-6 (Sun..Sat), e.g. "[1,3,5]"
  created_at: string;
  archived_at: string | null;
}

export interface DayRecordRow {
  id: number;
  habit_id: number;
  date: string; // YYYY-MM-DD
  count: number;
  done: number; // 0 | 1
  updated_at: string;
}

// ---------- module-level singleton ----------

let _db: Database.Database | null = null;

/** Lazy singleton used by handlers. Opens + migrates on first call. */
export function getDb(): Database.Database {
  if (_db) return _db;
  _db = openDb();
  migrate(_db);
  return _db;
}

// ---------- users ----------

export function getUserByTelegramId(telegramUserId: number): UserRow | undefined {
  return getDb()
    .prepare<[number], UserRow>(
      "SELECT * FROM users WHERE telegram_user_id = ?",
    )
    .get(telegramUserId);
}

export interface CreateUserInput {
  telegramUserId: number;
  displayName?: string | null;
  timezone?: string | null;
}

export function createOrGetUser(input: CreateUserInput): UserRow {
  const db = getDb();
  const existing = getUserByTelegramId(input.telegramUserId);
  if (existing) {
    if (
      (input.displayName != null && input.displayName !== existing.display_name) ||
      (input.timezone != null && input.timezone !== existing.timezone)
    ) {
      db.prepare(
        `UPDATE users
         SET display_name = COALESCE(?, display_name),
             timezone     = COALESCE(?, timezone),
             updated_at   = ?
         WHERE id = ?`,
      ).run(input.displayName ?? null, input.timezone ?? null, new Date().toISOString(), existing.id);
      return getUserByTelegramId(input.telegramUserId)!;
    }
    return existing;
  }
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO users (telegram_user_id, display_name, timezone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.telegramUserId, input.displayName ?? null, input.timezone ?? null, now, now);
  return getUserByTelegramId(input.telegramUserId)!;
}

export function setUserTimezone(userId: number, timezone: string): void {
  getDb()
    .prepare("UPDATE users SET timezone = ?, updated_at = ? WHERE id = ?")
    .run(timezone, new Date().toISOString(), userId);
}

// ---------- habits ----------

export interface CreateHabitInput {
  userId: number;
  name: string;
  frequency: Frequency;
  timesPerDay: number;
  weeklyDays?: number[] | null; // 0-6
}

export function createHabit(input: CreateHabitInput): HabitRow {
  const db = getDb();
  const weeklyDays =
    input.frequency === "weekly" && input.weeklyDays && input.weeklyDays.length > 0
      ? JSON.stringify([...new Set(input.weeklyDays)].sort((a, b) => a - b))
      : null;
  if (input.frequency === "weekly" && (!weeklyDays || JSON.parse(weeklyDays).length === 0)) {
    throw new Error("weekly habits require at least one day in weeklyDays");
  }
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO habits (user_id, name, frequency, times_per_day, weekly_days, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.userId,
      input.name,
      input.frequency,
      input.timesPerDay,
      weeklyDays,
      now,
    );
  return getHabit(Number(info.lastInsertRowid))!;
}

export function getHabit(habitId: number): HabitRow | undefined {
  return getDb().prepare<[number], HabitRow>("SELECT * FROM habits WHERE id = ?").get(habitId);
}

export function listHabits(userId: number, opts: { includeArchived?: boolean } = {}): HabitRow[] {
  if (opts.includeArchived) {
    return getDb()
      .prepare<[number], HabitRow>("SELECT * FROM habits WHERE user_id = ? ORDER BY created_at ASC")
      .all(userId);
  }
  return getDb()
    .prepare<[number], HabitRow>(
      "SELECT * FROM habits WHERE user_id = ? AND archived_at IS NULL ORDER BY created_at ASC",
    )
    .all(userId);
}

export interface UpdateHabitPatch {
  name?: string;
  frequency?: Frequency;
  timesPerDay?: number;
  weeklyDays?: number[] | null;
}

export function updateHabit(habitId: number, patch: UpdateHabitPatch): HabitRow | undefined {
  const db = getDb();
  const current = getHabit(habitId);
  if (!current) return undefined;
  const name = patch.name ?? current.name;
  const frequency = patch.frequency ?? current.frequency;
  const timesPerDay = patch.timesPerDay ?? current.times_per_day;
  let weeklyDays = current.weekly_days;
  if (patch.weeklyDays !== undefined) {
    weeklyDays =
      patch.weeklyDays && patch.weeklyDays.length > 0
        ? JSON.stringify([...new Set(patch.weeklyDays)].sort((a, b) => a - b))
        : null;
  }
  if (frequency === "weekly" && (!weeklyDays || JSON.parse(weeklyDays).length === 0)) {
    throw new Error("weekly habits require at least one day in weeklyDays");
  }
  db.prepare(
    `UPDATE habits
     SET name = ?, frequency = ?, times_per_day = ?, weekly_days = ?
     WHERE id = ?`,
  ).run(name, frequency, timesPerDay, weeklyDays, habitId);
  return getHabit(habitId);
}

export function archiveHabit(habitId: number): void {
  getDb()
    .prepare("UPDATE habits SET archived_at = ? WHERE id = ?")
    .run(new Date().toISOString(), habitId);
}

// ---------- day_records ----------

export interface UpsertDayRecordInput {
  count: number;
  done: boolean;
}

export function upsertDayRecord(
  habitId: number,
  date: string, // YYYY-MM-DD
  input: UpsertDayRecordInput,
): DayRecordRow {
  const db = getDb();
  const now = new Date().toISOString();
  const done = input.done ? 1 : 0;
  db.prepare(
    `INSERT INTO day_records (habit_id, date, count, done, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(habit_id, date) DO UPDATE SET
       count      = excluded.count,
       done       = excluded.done,
       updated_at = excluded.updated_at`,
  ).run(habitId, date, input.count, done, now);
  return getDayRecord(habitId, date)!;
}

export function getDayRecord(habitId: number, date: string): DayRecordRow | undefined {
  return getDb()
    .prepare<[number, string], DayRecordRow>(
      "SELECT * FROM day_records WHERE habit_id = ? AND date = ?",
    )
    .get(habitId, date);
}

export function listDayRecords(
  habitId: number,
  opts: { from?: string; to?: string } = {},
): DayRecordRow[] {
  if (opts.from && opts.to) {
    return getDb()
      .prepare<[number, string, string], DayRecordRow>(
        "SELECT * FROM day_records WHERE habit_id = ? AND date BETWEEN ? AND ? ORDER BY date ASC",
      )
      .all(habitId, opts.from, opts.to);
  }
  if (opts.from) {
    return getDb()
      .prepare<[number, string], DayRecordRow>(
        "SELECT * FROM day_records WHERE habit_id = ? AND date >= ? ORDER BY date ASC",
      )
      .all(habitId, opts.from);
  }
  if (opts.to) {
    return getDb()
      .prepare<[number, string], DayRecordRow>(
        "SELECT * FROM day_records WHERE habit_id = ? AND date <= ? ORDER BY date ASC",
      )
      .all(habitId, opts.to);
  }
  return getDb()
    .prepare<[number], DayRecordRow>(
      "SELECT * FROM day_records WHERE habit_id = ? ORDER BY date ASC",
    )
    .all(habitId);
}
