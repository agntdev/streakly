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
export interface Session {
  // example: step?: "awaiting_amount";
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

/**
 * buildBot — assembles the bot and registers every handler, but does NOT start
 * it. Shared by the runtime entry (src/index.ts) and the Tests-gate harness
 * (src/harness-entry.ts) so both exercise the exact same bot. Add new commands
 * and flows here.
 */
export function buildBot(token: string) {
  const bot = createBot<Session>(token, {
    initial: () => ({}),
    // Global error boundary. grammY's bot.catch fires here on any unhandled
    // throw from a handler; we log it and try to reply gracefully so the
    // user sees something instead of silence, and the polling loop keeps
    // running. ctx may be absent on startup errors, hence the guard.
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

  // Unknown-command fallback. Fires for any text message that wasn't claimed
  // by a /command handler (so /start and /help never reach here). Plain text
  // (no leading "/") is intentionally left silent — the user can use the menu
  // or /help. Messages that look like a command (start with "/") get a
  // friendly nudge with the main menu so they're never stuck.
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) {
      await ctx.reply(UNKNOWN_COMMAND_TEXT, {
        reply_markup: menuKeyboard(MENU_ITEMS, 2),
      });
    }
  });

  // Main-menu routing. Every tap edits the /start message in place and tells
  // the user which command to use. Future feature tasks (E1T1 first-run
  // /start, E2T1 /add, E5T1 /check, E6T1 /stats) deepen the per-command
  // handlers — the menu structure stays.
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
