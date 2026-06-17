import { createBot, inlineButton, menuKeyboard } from "@agntdev/bot-toolkit";

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
  });

  // /start — welcome message + main menu (inline keyboard).
  bot.command("start", async (ctx) => {
    await ctx.reply(WELCOME_TEXT, {
      reply_markup: menuKeyboard(MENU_ITEMS, 2),
    });
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
