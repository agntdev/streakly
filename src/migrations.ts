/**
 * Versioned SQL migrations for Streakly. Each entry's `version` is monotonic;
 * `migrate(db)` applies every pending migration in a single transaction and
 * records it in the `migrations` table. Append a new entry to evolve the
 * schema — never edit a shipped migration.
 */

export interface Migration {
  version: number;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE users (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id INTEGER NOT NULL UNIQUE,
        display_name     TEXT,
        timezone         TEXT,
        created_at       TEXT    NOT NULL,
        updated_at       TEXT    NOT NULL
      );

      CREATE TABLE habits (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name          TEXT    NOT NULL,
        frequency     TEXT    NOT NULL CHECK (frequency IN ('daily','weekly')),
        times_per_day INTEGER NOT NULL DEFAULT 1 CHECK (times_per_day > 0),
        weekly_days   TEXT,
        created_at    TEXT    NOT NULL,
        archived_at   TEXT
      );
      CREATE INDEX idx_habits_user_active
        ON habits(user_id) WHERE archived_at IS NULL;

      CREATE TABLE day_records (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        habit_id   INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
        date       TEXT    NOT NULL,
        count      INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
        done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
        updated_at TEXT    NOT NULL,
        UNIQUE (habit_id, date)
      );
      CREATE INDEX idx_day_records_habit_date
        ON day_records(habit_id, date);
    `,
  },
];
