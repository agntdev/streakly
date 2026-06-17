import {
  createBot,
  inlineButton,
  menuKeyboard,
  type BotContext,
} from "@agntdev/bot-toolkit";
import type { BotError } from "grammy";
import { createOrGetUser, createHabit } from "./db.js";

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).
export interface AddHabitDraft {
  name?: string;
  // Populated by later add-habit tasks (E2T2+).
  frequency?: "daily" | "weekly";
  timesPerDay?: number;
  weeklyDays?: number[];
}

export interface Session {
  /** Current wizard step, if any. "idle" when not in a flow. */
  step?:
    | "idle"
    | "awaiting_habit_name"
    | "awaiting_frequency"
    | "awaiting_times"
    | "awaiting_days"
    | "awaiting_confirmation";
  /** Draft habit being assembled by the /add wizard. */
  addHabit?: AddHabitDraft;
  /** Telegram message_id of the last wizard prompt, so text handlers can
   *  edit the same message in place (callback handlers do it via ctx). */
  wizardPromptId?: number;
}

const WELCOME_TEXT =
  "Welcome to Streakly! 🎯\n\n" +
  "Build habits, track daily streaks, and watch your progress grow.\n\n" +
  "Choose an action:";

const HELP_TEXT =
  "Streakly — habit streaks, made simple. 🎯\n\n" +
  "Commands:\n" +
  "/start — Welcome + main menu\n" +
  "/help — This help message\n" +
  "/add — Add a new habit\n" +
  "/check — Log habits for today\n" +
  "/stats — Your streak stats\n\n" +
  "Tip: send /start any time to bring back the menu.";

const UNKNOWN_COMMAND_TEXT =
  "I don't recognize that command.\n\n" +
  "Send /help to see what I can do, or tap a button below.";

const ADD_HABIT_PROMPT =
  "Let's add a new habit! 📝\n\n" +
  "What habit would you like to track?\n\n" +
  "Send the name (1–60 characters), or /cancel to abort.";

const HABIT_NAME_MIN = 1;
const HABIT_NAME_MAX = 60;

type MenuCallback =
  | "menu:add"
  | "menu:check"
  | "menu:stats"
  | "menu:help"
  | "menu:back";

const MENU_ITEMS: ReadonlyArray<{ text: string; data: MenuCallback }> = [
  { text: "📝 Add Habit", data: "menu:add" },
  { text: "✅ Check Today", data: "menu:check" },
  { text: "📊 Stats", data: "menu:stats" },
  { text: "❓ Help", data: "menu:help" },
];

const MENU_DESCRIPTIONS: Record<Exclude<MenuCallback, "menu:back">, string> = {
  "menu:add":
    "To add a new habit, send /add and I'll walk you through name, frequency, and target.",
  "menu:check":
    "To log your habits for today, send /check and pick the ones you completed.",
  "menu:stats":
    "To see your streak lengths and completion stats, send /stats.",
  "menu:help":
    "To see every command Streakly supports, send /help.",
};

function isInWizard(step: Session["step"]): boolean {
  return step != null && step !== "idle";
}

// --- E2T3: times-per-day chooser ---

const TIMES_MAX = 6; // +/- chooser caps at 6 per the spec; text accepts 1–20
const TIMES_PRESETS = [1, 2, 3] as const;

function timesChooserText(name: string, n: number): string {
  return (
    `Times per day for "${name}": *${n}*\n\n` +
    `Tap − / + to nudge (1–${TIMES_MAX}), a preset (1 / 2 / 3), or send a number 1–20.\n\n` +
    `Tap ✅ Done to confirm.`
  );
}

function timesChooserMarkup(n: number) {
  return {
    inline_keyboard: [
      [
        inlineButton("−", "times:dec"),
        inlineButton(String(n), "times:noop"),
        inlineButton("+", "times:inc"),
      ],
      [
        inlineButton("1", "times:set:1"),
        inlineButton("2", "times:set:2"),
        inlineButton("3", "times:set:3"),
      ],
      [inlineButton("✅ Done", "times:done")],
    ],
  };
}

async function renderTimesChooser(
  ctx: BotContext<Session>,
  n: number,
): Promise<void> {
  const name = ctx.session.addHabit?.name ?? "";
  const text = timesChooserText(name, n);
  const markup = timesChooserMarkup(n);
  if (ctx.session.wizardPromptId != null) {
    await ctx.api.editMessageText(ctx.chat!.id, ctx.session.wizardPromptId, text, {
      reply_markup: markup,
    });
  } else {
    const s = await ctx.reply(text, { reply_markup: markup });
    ctx.session.wizardPromptId = s.message_id;
  }
}

// --- E2T4: weekly-days chooser ---

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_LONG = [
  "Sunday", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday",
] as const;

function parseDaysText(raw: string): number[] | null {
  // Accept "mon,wed,fri", "Mon Wed Fri", "1,3,5", "0" (Sun=0). Returns sorted unique 0–6, or null on garbage.
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  const tokens = cleaned.split(/[\s,;]+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const out = new Set<number>();
  for (const t of tokens) {
    const asNum = Number(t);
    if (Number.isInteger(asNum) && asNum >= 0 && asNum <= 6) {
      out.add(asNum);
      continue;
    }
    const idx = DAY_LONG.findIndex((d) => d.toLowerCase().startsWith(t) || d.toLowerCase() === t);
    if (idx >= 0) {
      out.add(idx);
      continue;
    }
    const shortIdx = DAY_SHORT.findIndex((d) => d.toLowerCase() === t);
    if (shortIdx >= 0) {
      out.add(shortIdx);
      continue;
    }
    return null;
  }
  return [...out].sort((a, b) => a - b);
}

function daysChooserText(name: string, selected: number[]): string {
  const list = selected.length === 0
    ? "_none yet_"
    : selected.map((d) => DAY_SHORT[d]).join(", ");
  return (
    `Days for "${name}": *${list}*\n\n` +
    `Tap a day to toggle it on/off. Tap ✅ Done when at least one day is selected.\n\n` +
    `Tip: you can also send a list like "mon,wed,fri".`
  );
}

function daysChooserMarkup(selected: number[]) {
  const sel = new Set(selected);
  const label = (d: number) => (sel.has(d) ? `✅ ${DAY_SHORT[d]}` : DAY_SHORT[d]);
  return {
    inline_keyboard: [
      [
        inlineButton(label(1), "days:toggle:1"),
        inlineButton(label(2), "days:toggle:2"),
        inlineButton(label(3), "days:toggle:3"),
      ],
      [
        inlineButton(label(4), "days:toggle:4"),
        inlineButton(label(5), "days:toggle:5"),
        inlineButton(label(6), "days:toggle:6"),
      ],
      [inlineButton(label(0), "days:toggle:0")],
      [inlineButton("✅ Done", "days:done")],
    ],
  };
}

async function renderDaysChooser(
  ctx: BotContext<Session>,
  selected: number[],
): Promise<void> {
  const name = ctx.session.addHabit?.name ?? "";
  const text = daysChooserText(name, selected);
  const markup = daysChooserMarkup(selected);
  if (ctx.session.wizardPromptId != null) {
    await ctx.api.editMessageText(ctx.chat!.id, ctx.session.wizardPromptId, text, {
      reply_markup: markup,
    });
  } else {
    const s = await ctx.reply(text, { reply_markup: markup });
    ctx.session.wizardPromptId = s.message_id;
  }
}

// --- E2T5: confirmation (save / cancel) ---

function summaryText(name: string, frequency: "daily" | "weekly", timesPerDay: number, weeklyDays: number[]): string {
  if (frequency === "daily") {
    return `Summary for "${name}":\n  • Frequency: daily\n  • Target: ${timesPerDay}×/day`;
  }
  const days = weeklyDays.map((d) => DAY_SHORT[d]).join(", ");
  return `Summary for "${name}":\n  • Frequency: weekly\n  • Days: ${days}`;
}

function confirmMarkup() {
  return {
    inline_keyboard: [
      [
        inlineButton("✅ Save", "confirm:save"),
        inlineButton("❌ Cancel", "confirm:cancel"),
      ],
    ],
  };
}

async function renderConfirmPrompt(ctx: BotContext<Session>): Promise<void> {
  const draft = ctx.session.addHabit;
  if (!draft || !draft.name || !draft.frequency) return; // shouldn't happen
  const timesPerDay = draft.timesPerDay ?? 1;
  const weeklyDays = draft.weeklyDays ?? [];
  const text =
    summaryText(draft.name, draft.frequency, timesPerDay, weeklyDays) +
    "\n\nSave this habit?";
  const markup = confirmMarkup();
  if (ctx.session.wizardPromptId != null) {
    await ctx.api.editMessageText(ctx.chat!.id, ctx.session.wizardPromptId, text, {
      reply_markup: markup,
    });
  } else {
    const s = await ctx.reply(text, { reply_markup: markup });
    ctx.session.wizardPromptId = s.message_id;
  }
}

function clearWizard(ctx: BotContext<Session>): void {
  ctx.session.step = "idle";
  ctx.session.addHabit = undefined;
  ctx.session.wizardPromptId = undefined;
}

function cancelDraft(ctx: BotContext<Session>): void {
  const name = ctx.session.addHabit?.name;
  const promptId = ctx.session.wizardPromptId;
  clearWizard(ctx);
  const msg = name ? `Cancelled. "${name}" was not saved.` : "Cancelled.";
  if (promptId != null) {
    ctx.api
      .editMessageText(ctx.chat!.id, promptId, msg, { reply_markup: { inline_keyboard: [] } })
      .catch(() => {});
  } else {
    ctx.reply(msg).catch(() => {});
  }
}

async function saveDraftHabit(ctx: BotContext<Session>): Promise<void> {
  const draft = ctx.session.addHabit;
  if (!draft || !draft.name || !draft.frequency) {
    await ctx.reply("Nothing to save — the draft is incomplete. Send /start.");
    clearWizard(ctx);
    return;
  }
  const tgId = ctx.from?.id;
  if (tgId == null) {
    await ctx.reply("Couldn't identify your Telegram account. Try /start.");
    return;
  }
  const user = createOrGetUser({
    telegramUserId: tgId,
    displayName: ctx.from?.first_name ?? null,
  });
  const habit = createHabit({
    userId: user.id,
    name: draft.name,
    frequency: draft.frequency,
    timesPerDay: draft.timesPerDay ?? 1,
    weeklyDays: draft.weeklyDays ?? null,
  });
  const msg = `✅ Saved "${habit.name}"!\n\nSend /check to log it today, or /start for the menu.`;
  clearWizard(ctx);
  if (ctx.session.wizardPromptId != null) {
    // wizardPromptId was just cleared; use the captured id from the draft flow.
    // Re-read isn't possible, so send a fresh message instead.
  }
  await ctx.reply(msg, { reply_markup: menuKeyboard(MENU_ITEMS, 2) });
}

/**
 * buildBot — assembles the bot and registers every handler, but does NOT start
 * it. Shared by the runtime entry (src/index.ts) and the Tests-gate harness
 * (src/harness-entry.ts) so both exercise the exact same bot. Add new commands
 * and flows here.
 */
export function buildBot(token: string) {
  const bot = createBot<Session>(token, {
    initial: () => ({ step: "idle" }),
    onError: (err) => {
      const e = err as BotError<BotContext<Session>>;
      console.error("[streakly] unhandled error:", err);
      if (e?.ctx) {
        e.ctx
          .reply("Something went wrong on my end. Please try again in a moment.")
          .catch((replyErr) => {
            console.error("[streakly] error-boundary reply failed:", replyErr);
          });
      }
    },
  });

  // /start — welcome message + main menu (inline keyboard).
  bot.command("start", async (ctx) => {
    await ctx.reply(WELCOME_TEXT, {
      reply_markup: menuKeyboard(MENU_ITEMS, 2),
    });
  });

  // /help — list every command Streakly supports.
  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  // /add — start the new-habit wizard. Step 1 of N: ask for the habit name.
  // E2T1 owns this entry + the name capture. E2T2+ will deepen the wizard
  // (frequency → times/days → confirm) by handling the next session steps
  // and the "Got it" message E2T1 sends here.
  bot.command("add", async (ctx) => {
    ctx.session.step = "awaiting_habit_name";
    ctx.session.addHabit = {};
    await ctx.reply(ADD_HABIT_PROMPT);
  });

  // /cancel — exit any in-progress wizard, clear the draft.
  bot.command("cancel", async (ctx) => {
    const wasInWizard = isInWizard(ctx.session.step);
    ctx.session.step = "idle";
    ctx.session.addHabit = undefined;
    if (wasInWizard) {
      await ctx.reply("Cancelled. Your draft habit was discarded.");
    } else {
      await ctx.reply("Nothing to cancel. Send /start for the main menu.");
    }
  });

  // Unified message:text handler. Order:
  //   1. Wizard steps (awaiting text) — consume.
  //   2. Unknown /command — reply with the friendly fallback.
  //   3. Plain text (no wizard, no /command) — silent.
  // The handler always consumes (no next()) so a single text message is
  // processed by exactly one branch.
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;

    // --- 1. Wizard: awaiting habit name (E2T1) ---
    if (ctx.session.step === "awaiting_habit_name") {
      const name = text.trim();
      if (name.length < HABIT_NAME_MIN || name.length > HABIT_NAME_MAX) {
        await ctx.reply(
          `Name must be ${HABIT_NAME_MIN}–${HABIT_NAME_MAX} characters. Try again, or /cancel.`,
        );
        return;
      }
      ctx.session.addHabit = { name };
      // Hand off to E2T2 (frequency selection). E2T2 adds the Daily/Weekly
      // inline buttons and the awaiting_frequency handler.
      ctx.session.step = "awaiting_frequency";
      const sent = await ctx.reply(
        `Got it: "${name}".\n\nHow often? (Daily or Weekly)`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                inlineButton("📅 Daily", "freq:daily"),
                inlineButton("📆 Weekly", "freq:weekly"),
              ],
            ],
          },
        },
      );
      ctx.session.wizardPromptId = sent.message_id;
      return;
    }

    // --- 2. Wizard: awaiting frequency (E2T2) ---
    if (ctx.session.step === "awaiting_frequency") {
      const choice = text.trim().toLowerCase();
      if (choice === "daily" || choice === "weekly") {
        const freq = choice as "daily" | "weekly";
        const name = ctx.session.addHabit?.name ?? "";
        ctx.session.addHabit = { ...(ctx.session.addHabit ?? {}), frequency: freq };
        if (freq === "daily") {
          ctx.session.step = "awaiting_times";
          const nextText = `Daily it is — "${name}".\n\nHow many times per day? Send a number between 1 and 20, or /cancel.`;
          if (ctx.session.wizardPromptId != null) {
            await ctx.api.editMessageText(ctx.chat.id, ctx.session.wizardPromptId, nextText, {
              reply_markup: { inline_keyboard: [] },
            });
          } else {
            const s = await ctx.reply(nextText);
            ctx.session.wizardPromptId = s.message_id;
          }
        } else {
          ctx.session.step = "awaiting_days";
          const nextText = `Weekly — "${name}".\n\nWhich days? You'll pick the days next. /cancel to abort.`;
          if (ctx.session.wizardPromptId != null) {
            await ctx.api.editMessageText(ctx.chat.id, ctx.session.wizardPromptId, nextText, {
              reply_markup: { inline_keyboard: [] },
            });
          } else {
            const s = await ctx.reply(nextText);
            ctx.session.wizardPromptId = s.message_id;
          }
        }
        return;
      }
      // Other text in the frequency step: fall through to the generic
      // unknown-/command and plain-text-silent handling below. The user can
      // tap a button or type "daily"/"weekly".
    }

    // --- 3. Wizard: awaiting times-per-day (E2T3) ---
    if (ctx.session.step === "awaiting_times") {
      const parsed = Number.parseInt(text.trim(), 10);
      const current = ctx.session.addHabit?.timesPerDay ?? 1;
      const next = Number.isFinite(parsed) && parsed >= 1 && parsed <= 20 ? parsed : current;
      ctx.session.addHabit = { ...(ctx.session.addHabit ?? {}), timesPerDay: next };
      await renderTimesChooser(ctx, next);
      return;
    }

    // --- 4. Wizard: awaiting weekly days (E2T4) ---
    if (ctx.session.step === "awaiting_days") {
      const parsed = parseDaysText(text);
      if (parsed !== null) {
        ctx.session.addHabit = { ...(ctx.session.addHabit ?? {}), weeklyDays: parsed };
        await renderDaysChooser(ctx, parsed);
        return;
      }
      // Invalid text: re-render the chooser with the current selection so the
      // user sees the buttons and a fresh hint.
      const current = ctx.session.addHabit?.weeklyDays ?? [];
      await renderDaysChooser(ctx, current);
      return;
    }

    // --- 5. Wizard: awaiting confirmation (E2T5) ---
    if (ctx.session.step === "awaiting_confirmation") {
      const t = text.trim().toLowerCase();
      if (t === "save" || t === "yes" || t === "confirm") {
        await saveDraftHabit(ctx);
        return;
      }
      if (t === "cancel" || t === "no") {
        cancelDraft(ctx);
        return;
      }
      // Anything else: reveal the Save / Cancel buttons so the user can act.
      await renderConfirmPrompt(ctx);
      return;
    }

    // --- 2. Future wizard steps (awaiting_times / days / confirmation) will
    //    be handled here by E2T3+. ---

    // --- 3. Unknown /command fallback ---
    if (text.startsWith("/")) {
      await ctx.reply(UNKNOWN_COMMAND_TEXT, {
        reply_markup: menuKeyboard(MENU_ITEMS, 2),
      });
      return;
    }

    // --- 4. Plain text, not in a wizard — stay silent. ---
  });

  // Main-menu routing. Every tap edits the /start message in place and tells
  // the user which command to use. Future feature tasks (E1T1 first-run
  // /start, E2T2 /add frequency, E5T1 /check, E6T1 /stats) deepen the
  // per-command handlers — the menu structure stays.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data === "menu:back") {
      await ctx.editMessageText(WELCOME_TEXT, {
        reply_markup: menuKeyboard(MENU_ITEMS, 2),
      });
      await ctx.answerCallbackQuery();
      return;
    }

    if (
      data === "menu:add" ||
      data === "menu:check" ||
      data === "menu:stats" ||
      data === "menu:help"
    ) {
      const guidance = MENU_DESCRIPTIONS[data];
      const backRow = [inlineButton("« Back to menu", "menu:back")];
      await ctx.editMessageText(guidance, {
        reply_markup: { inline_keyboard: [backRow] },
      });
      await ctx.answerCallbackQuery();
      return;
    }

    if (data === "freq:daily" || data === "freq:weekly") {
      const freq = data === "freq:daily" ? "daily" : "weekly";
      const name = ctx.session.addHabit?.name ?? "";
      ctx.session.addHabit = { ...(ctx.session.addHabit ?? {}), frequency: freq };
      if (freq === "daily") {
        ctx.session.step = "awaiting_times";
        await ctx.editMessageText(
          `Daily it is — "${name}".\n\nHow many times per day? Send a number between 1 and 20, or /cancel.`,
          { reply_markup: { inline_keyboard: [] } },
        );
      } else {
        ctx.session.step = "awaiting_days";
        await ctx.editMessageText(
          `Weekly — "${name}".\n\nWhich days? You'll pick the days next. /cancel to abort.`,
          { reply_markup: { inline_keyboard: [] } },
        );
      }
      await ctx.answerCallbackQuery();
      return;
    }

    if (data.startsWith("times:")) {
      const current = ctx.session.addHabit?.timesPerDay ?? 1;
      let next = current;
      if (data === "times:dec") next = Math.max(1, current - 1);
      else if (data === "times:inc") next = Math.min(TIMES_MAX, current + 1);
      else if (data === "times:set:1") next = 1;
      else if (data === "times:set:2") next = 2;
      else if (data === "times:set:3") next = 3;
      else if (data === "times:noop") {
        await ctx.answerCallbackQuery();
        return;
      } else if (data === "times:done") {
        ctx.session.addHabit = { ...(ctx.session.addHabit ?? {}), timesPerDay: current };
        ctx.session.step = "awaiting_confirmation";
        const name = ctx.session.addHabit?.name ?? "";
        const text = `Summary so far for "${name}":\n  • Frequency: daily\n  • Target: ${current}×/day\n\nSaving... (E2T5 will add the confirm button.)`;
        await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [] } });
        await ctx.answerCallbackQuery();
        return;
      } else {
        await ctx.answerCallbackQuery();
        return;
      }
      ctx.session.addHabit = { ...(ctx.session.addHabit ?? {}), timesPerDay: next };
      await renderTimesChooser(ctx, next);
      await ctx.answerCallbackQuery();
      return;
    }

    if (data === "confirm:save") {
      // The confirm chooser may have been revealed by the text handler; either
      // way, the wizardPromptId at the time of THIS callback is the
      // currently-displayed message (the confirm prompt), which is the right
      // one to replace with the saved confirmation.
      // But saveDraftHabit clears the wizard and sends a NEW message with the
      // menu, leaving the confirm prompt in place. We answer the spinner first
      // so it doesn't hang, then save (which sends a new message).
      await ctx.answerCallbackQuery({ text: "Saved!" });
      await saveDraftHabit(ctx);
      return;
    }

    if (data === "confirm:cancel") {
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      cancelDraft(ctx);
      return;
    }

    if (data.startsWith("days:")) {
      const current = [...(ctx.session.addHabit?.weeklyDays ?? [])].sort((a, b) => a - b);
      if (data === "days:done") {
        if (current.length === 0) {
          await ctx.answerCallbackQuery({ text: "Pick at least one day.", show_alert: true });
          return;
        }
        ctx.session.addHabit = { ...(ctx.session.addHabit ?? {}), weeklyDays: current };
        ctx.session.step = "awaiting_confirmation";
        const name = ctx.session.addHabit?.name ?? "";
        const list = current.map((d) => DAY_SHORT[d]).join(", ");
        const text = `Summary so far for "${name}":\n  • Frequency: weekly\n  • Days: ${list}\n\nSaving... (E2T5 will add the confirm button.)`;
        await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [] } });
        await ctx.answerCallbackQuery();
        return;
      }
      const m = /^days:toggle:([0-6])$/.exec(data);
      if (!m) {
        await ctx.answerCallbackQuery();
        return;
      }
      const day = Number(m[1]);
      const set = new Set(current);
      if (set.has(day)) set.delete(day);
      else set.add(day);
      const next = [...set].sort((a, b) => a - b);
      ctx.session.addHabit = { ...(ctx.session.addHabit ?? {}), weeklyDays: next };
      await renderDaysChooser(ctx, next);
      await ctx.answerCallbackQuery();
      return;
    }

    // Unknown callback data — just stop the spinner.
    await ctx.answerCallbackQuery();
  });

  return bot;
}
