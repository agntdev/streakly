import {
  createBot,
  inlineButton,
  menuKeyboard,
  type BotContext,
} from "@agntdev/bot-toolkit";
import type { BotError } from "grammy";

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
      // Hand off to E2T2 (frequency selection). E2T1 sets step back to idle
      // so the generic text handler stays silent until E2T2 wires its own
      // step ("awaiting_frequency") and the frequency buttons.
      ctx.session.step = "idle";
      await ctx.reply(
        `Got it: "${name}".\n\nHow often? (Daily or Weekly)`,
      );
      return;
    }

    // --- 2. Future wizard steps (awaiting_frequency / times / days / confirm)
    //    will be handled here by E2T2+. ---

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

    // Unknown callback data — just stop the spinner.
    await ctx.answerCallbackQuery();
  });

  return bot;
}
