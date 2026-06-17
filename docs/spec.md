# Streakly — Habit-tracking Telegram bot

## Summary
Streakly is a private-chat Telegram bot that helps a single user track daily habits and streaks. The user creates habits (Daily, X times/day, or Weekly on selected weekdays), marks them done via inline buttons (no new messages), and views progress and stats. Data is stored server-side so habits persist across reinstall. Long-polling only; no external APIs; no scheduled reminders in v1.

## Audience
Individual Telegram users who want a lightweight, emoji-light habit tracker in a private chat with all interactions driven by inline buttons.

## Core entities
- User
  - telegram_user_id, display_name, timezone, preferences
- Habit
  - id, owner_user_id, name, frequency_type (daily | times_per_day | weekly), times_target (int, only for times_per_day), weekly_days (array of weekdays), created_at, archived_flag
- DayRecord (per-habit-per-day)
  - habit_id, date (in user's TZ), count (integer checks today), done (boolean: count >= target or single check done), created_at, updated_at
- Streaks are computed from DayRecord.done across consecutive dates

## Integrations & notification targets
- Telegram Bot API (long-polling only)
- No external APIs, no push notifications, no webhooks
- Persistence: local server-side database (SQLite by default). Backups are file-based.

## Interaction flows (all flows use inline buttons; typing only used during name entry in /add)
- /start
  - If first run: prompt to choose timezone (inline selection), then show welcome and habits list (empty state with a big "+ Add habit" button).
  - If not first run: show a single message containing the habits list and top action row. This message will be edited for subsequent actions.
  - Top action row: "+ Add habit", "Stats".

- /add (multi-step)
  1. User issues /add (allowed during setup) -> bot asks for habit name (plain text reply; typing allowed for this step). After name entered, show frequency selection via inline buttons: "Daily", "X times/day", "Weekly".
  2. If "X times/day": ask for target number (inline number chooser: 1..6 with "+" and "-" paging and quick presets 1,2,3). Save times_target.
  3. If "Weekly": show weekdays as toggles (Mon..Sun) implemented with inline toggle buttons and a "Done" button.
  4. Optional: prompt for a reminder time is part of initial request but v1 has no scheduled reminders — store the optional time field but do not schedule notifications.
  5. Confirm creation and return to the main habits-list message (edited).

- Listing habits (/list or via main message)
  - The bot keeps a single edited message that lists habits (one line per habit). Each habit line shows: name, small progress info (e.g. "Today: 0/3" or "Done"), current streak (e.g. "🔥 4d"). Under each habit, inline buttons: primary 
    - For daily/weekly: "✓ Done" (if not done) or "Done ✅" (if done).
    - For times/day: "+1" (increments count) and if count>0 an "Undo" button to decrement; when count >= target the habit shows "Done ✅".
    - Always show a right-side "…" button leading to a details menu with actions: "Edit", "Delete", "History".
  - Tapping any button edits the same single message (updates counts, statuses, and button states). Callback queries are answered to remove the loading state.

- /check
  - Exposed via the inline buttons on the main message. Tapping the habit's primary button marks it done for the current day (or increments the count for times/day). The bot edits the list message in-place to reflect the change.

- Undo & corrections
  - For mistakes, provide an "Undo" button on the habit row (only affects the current day). The details menu includes "Adjust today" to set a specific count if needed.

- /stats
  - Edits the main message (or opens a short overlay detail) showing: today's progress (number of habits fully done vs total and per-habit mini-lines) and "Longest streak across all habits: N days" (computed as the max per-habit longest consecutive days where DayRecord.done == true). Also a "Back" button to return to the list.

## Persistence
- Default: server-side SQLite database file stored alongside the bot process. Data keyed by telegram_user_id to survive uninstall/reinstall.
- DB schema includes tables: users, habits, day_records, migrations table.
- Export: an optional export endpoint to download a JSON dump (manual admin action) is available as a sensible upgrade.

## Payments
- None.

## Non-goals (v1)
- No push notifications or scheduled reminders (explicitly out of scope for v1).
- No group chat support.
- No external API calls or webhooks.
- No multi-user sharing or collaborative habits.

## Assumptions & defaults
- Storage: use a single SQLite database on the bot host keyed by telegram_user_id — simple, zero-external-deps persistence that satisfies the "survives reinstall" requirement.
  Rationale: lightweight and easy to host; meets the persistence requirement without third-party services.
- Long-polling: run the bot as a long-polling service (getUpdates) only; no webhook support.
  Rationale: matches the owner's explicit constraint and simplifies hosting.
- Timezone setup: on first run the bot asks the user to select a timezone from a searchable list (presented in pages) and stores it on the user record.
  Rationale: owner requested an explicit timezone selection on first run.
- Day boundary: "today" is midnight-to-midnight in the user-selected timezone (00:00–23:59:59 local time).
  Rationale: intuitive day definition for streaks and counts.
- X times/day behavior: a times_per_day habit has an integer target; each tap of "+1" increments today's count; the habit is considered done for the day when count >= target; an "Undo" decrements (floor 0).
  Rationale: covers the expected multi-check workflow and lets the user recover from accidental taps.
- Editing & deletion: include a details menu ("…") for each habit with "Edit" and "Delete" actions (edit allows changing name, frequency, target, weekdays); delete asks for confirmation.
  Rationale: minimal management is necessary for a usable product.
- All interactive updates use callback queries and editMessageText/editMessageReplyMarkup to keep a single primary chat message per user updated.
  Rationale: matches the requirement "The bot edits the same message in place" and keeps chat uncluttered.
- Concurrency: callback handlers will re-read the DB and apply optimistic updates; if conflicts arise, the latest action wins and the UI updates to the resulting state.
  Rationale: simple and robust for single-user usage.
- Optional reminder time field: stored but ignored in v1 (no scheduler). UI shows the set time in habit details for future use.
  Rationale: preserves user input for later feature expansion without implementing scheduling now.


