require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node'); // This is the correct import for lowdb v5+
const path = require('path');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID; // Your admin Telegram user ID
const bot = new TelegramBot(TOKEN, { polling: true });

// LowDB database setup
const db = new Low(new JSONFile(path.join(__dirname, 'db.json')));

// Rank configuration for the quiz
const RANKS = [
  { name: "Rookie", pts: 0 },
  { name: "Explorer", pts: 10 },
  { name: "Mathlete", pts: 25 },
  { name: "Science Star", pts: 50 },
  { name: "Quiz Master", pts: 100 },
  { name: "Prodigy", pts: 200 },
  { name: "Legend", pts: 400 }
];

// --- Utility Functions ---

// Strips HTML entities and tags from strings (important for poll questions)
function stripHtml(text) {
  if (!text) return "";
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, ""); // Removes any actual HTML tags if present
}

// Shuffles an array (Fisher-Yates algorithm)
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Determines user rank based on points
function getRank(points) {
  let result = RANKS[0];
  for (const tier of RANKS) {
    if (points >= tier.pts) {
      result = tier;
    }
  }
  return result;
}

// Calculates user level based on points
function getLevel(points) {
  return 1 + Math.floor(points / 25);
}

// Returns a visual badge based on points or streak
function prettyBadge(points, streak = 0) {
  if (points >= 400) return "🏆";
  if (points >= 200) return "🥇";
  if (points >= 100) return "🥈";
  if (points >= 50) return "🥉";
  if (streak >= 10) return "🔥";
  if (streak >= 5) return "🌟";
  return "";
}

// Formats username for display
function prettyUsername(user) {
  return user.nickname || user.first_name || (user.username ? "@" + user.username : "User");
}

// Gets or creates a user entry in the database
async function getUser(msg) {
  await db.read();
  let user = db.data.users.find(u => u.id === msg.from.id);
  if (!user) {
    user = {
      id: msg.from.id,
      username: msg.from.username || "",
      first_name: msg.from.first_name || "",
      nickname: "",
      avatar: "",
      points: 0,
      streak: 0,
      level: 1,
      badges: [],
      groupStats: {}, // To store group-specific stats if needed later
    };
    db.data.users.push(user);
    await db.write();
    // Optional: Notify admin about new user
    if (ADMIN_ID && String(ADMIN_ID) !== String(user.id)) {
      bot.sendMessage(ADMIN_ID, `👤 New user: ${prettyUsername(user)} (ID: ${user.id})\nTotal users: ${db.data.users.length}`);
    }
  }
  return user;
}

// Updates a user's data in the database
async function updateUser(user) {
  let idx = db.data.users.findIndex(u => u.id === user.id);
  if (idx !== -1) {
    db.data.users[idx] = user;
    await db.write();
  }
}

// --- Database Initialization ---
(async function() {
  await db.read();
  // Set default structure if db is empty
  db.data ||= {
    users: [],
    hints: {}, // To track hints usage per user
    last_questions: {}, // Stores the last question for each chat/user
  };
  await db.write();
})();

// --- Quiz Logic ---

// Fetches a random quiz question from OpenTDB
async function fetchQuestion() {
  let url, category, catNoun;
  const roll = Math.random();
  // Randomly select question category
  if (roll < 0.4) { url = "https://opentdb.com/api.php?amount=1&category=19&type=multiple"; category = "Math"; catNoun = "🧮"; }
  else if (roll < 0.8) { url = "https://opentdb.com/api.php?amount=1&category=17&type=multiple"; category = "Science"; catNoun = "🔬"; }
  else { url = "https://opentdb.com/api.php?amount=1&category=9&type=multiple"; category = "English"; catNoun = "🔤"; }

  const { data } = await axios.get(url);
  const q = data.results[0]; // Get the first question

  // Prepare answers, shuffle them, and find the correct one's index
  let answers = shuffle([
    ...q.incorrect_answers.map(stripHtml),
    stripHtml(q.correct_answer)
  ]);

  return {
    question: `${catNoun} ${stripHtml(q.question)}`,
    answers,
    correct: answers.indexOf(stripHtml(q.correct_answer)),
    explanation: `The correct answer is: ${stripHtml(q.correct_answer)}.`,
    category,
    hint: "💡 Try elimination or recall basic concepts related to the question."
  };
}

// Sends a quiz poll to the specified chat ID
async function sendQuiz(chatId, user) {
  const quiz = await fetchQuestion();
  // Store the quiz data for later validation
  db.data.last_questions[chatId + ":" + user.id] = { ...quiz, time: Date.now(), chatId };
  await db.write();

  bot.sendPoll(chatId, quiz.question, quiz.answers, {
    type: "quiz",
    correct_option_id: quiz.correct,
    is_anonymous: false, // Poll is not anonymous
    explanation: "Choose wisely to earn points!", // Explanation shown on wrong answer or after poll closes
  });
}

// --- Telegram Bot Command Handlers ---

// /start command: Greets user and provides main menu options
bot.onText(/^\/start$/, async msg => {
  await getUser(msg); // Ensure user is registered
  bot.sendMessage(msg.chat.id, `👋 Welcome to Deb's Quiz!\n\nUse /quiz to start a question. Check /commands for a full list.`);
});

// /commands command: Lists all available commands
bot.onText(/^\/commands$/, async msg => {
  bot.sendMessage(msg.chat.id, `
🤖 Deb's Quiz Commands:

**Student:**
/quiz - 🎯 Start a new quiz question
/points - 💰 Check your current points, level, and streak
/profile - 🧑‍💻 View/set your nickname and avatar
/leaderboard - 🏆 See top players
/ranks - 🏅 Understand rank levels
/hint - 💡 Get a hint for the current quiz (limited daily)
/answer - ℹ️ Reveal the correct answer and explanation for the last quiz

**Admin (if you are the admin):**
/broadcast <message> - 📢 Send a message to all users
/users - 👥 List all registered users
/groupstats - 📈 View stats for groups the bot is in
`);
});

// /quiz command: Starts a new quiz question
bot.onText(/^\/quiz$/, async msg => {
  let user = await getUser(msg); // Ensure user is registered
  await sendQuiz(msg.chat.id, user);
});

// /points command: Displays user's points, level, rank, and streak
bot.onText(/^\/points$/, async msg => {
  let user = await getUser(msg);
  const badge = prettyBadge(user.points, user.streak);
  const rank = getRank(user.points);
  bot.sendMessage(msg.chat.id, `💰 **${prettyUsername(user)}**\nPoints: **${user.points}** ${badge}\nLevel: **${getLevel(user.points)}** (${rank.name})\nStreak: **${user.streak}** correct answers in a row!`, { parse_mode: "Markdown" });
});

// /profile command: Shows user's profile and options to set nickname/avatar
bot.onText(/^\/profile$/, async msg => {
  let user = await getUser(msg);
  bot.sendMessage(msg.chat.id, `🧑‍💻 **Your Profile**\nName: ${prettyUsername(user)}\nAvatar: ${user.avatar || "👤"}\nLevel: ${getLevel(user.points)}\nRank: ${getRank(user.points).name}\nPoints: ${user.points}\nBadges: ${user.badges.join(", ") || "None"}\n\nTo set nickname: \`/setnick <your_nick>\`\nTo set avatar: \`/setavatar <emoji>\``, { parse_mode: "Markdown" });
});

// /setnick command: Sets user's nickname
bot.onText(/^\/setnick (.+)$/, async (msg, match) => {
  let user = await getUser(msg);
  user.nickname = match[1].trim().substring(0, 20); // Limit nickname length
  await updateUser(user);
  bot.sendMessage(msg.chat.id, `✅ Nickname updated to: **${user.nickname}**`, { parse_mode: "Markdown" });
});

// /setavatar command: Sets user's avatar (single emoji)
bot.onText(/^\/setavatar (.+)$/, async (msg, match) => {
  let user = await getUser(msg);
  user.avatar = match[1].trim().substring(0, 2); // Take first 2 characters for emoji
  await updateUser(user);
  bot.sendMessage(msg.chat.id, `✅ Avatar updated to: ${user.avatar}`);
});

// /ranks command: Displays the ranking tiers
bot.onText(/^\/ranks$/, msg => {
  let text = "🏅 **Ranks in Deb's Quiz:**\n\n";
  text += RANKS.map((r, i) => `${i + 1}. **${r.name}** — **${r.pts} pts**`).join('\n');
  text += "\n\nClimb up the ranks by earning points!";
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// /hint command: Provides a hint for the current quiz question (limited daily)
bot.onText(/^\/hint$/, async msg => {
  let user = await getUser(msg);
  const key = msg.chat.id + ":" + user.id;
  const lastQuiz = db.data.last_questions[key];
  if (!lastQuiz) return bot.sendMessage(msg.chat.id, "💡 No quiz in progress. Start one with /quiz!");

  // Hint usage tracking (3 hints per user per day)
  db.data.hints[user.id] ||= { used: 0, lastReset: Date.now() };
  let hintData = db.data.hints[user.id];
  const now = new Date();
  const lastResetDate = new Date(hintData.lastReset);

  // Reset hint count if it's a new day
  if (now.getUTCDate() !== lastResetDate.getUTCDate() || now.getUTCMonth() !== lastResetDate.getUTCMonth() || now.getUTCFullYear() !== lastResetDate.getUTCFullYear()) {
    hintData.used = 0;
    hintData.lastReset = Date.now();
  }

  if (hintData.used >= 3) {
    return bot.sendMessage(msg.chat.id, "🚫 You've used all 3 hints for today! Come back tomorrow.");
  }

  hintData.used++;
  await db.write();
  bot.sendMessage(msg.chat.id, `💡 Hint: ${lastQuiz.hint}`);
});

// /answer command: Reveals the correct answer for the last quiz
bot.onText(/^\/answer$/, async msg => {
  let user = await getUser(msg);
  const key = msg.chat.id + ":" + user.id;
  const lastQuiz = db.data.last_questions[key];
  if (!lastQuiz) return bot.sendMessage(msg.chat.id, "ℹ️ No previous quiz to show the answer for. Use /quiz!");

  bot.sendMessage(msg.chat.id, `ℹ️ **The correct answer was:** ${lastQuiz.explanation}`, { parse_mode: "Markdown" });
});

// /leaderboard command: Displays the top 10 players globally
bot.onText(/^\/leaderboard$/, async msg => {
  await db.read();
  let sortedUsers = db.data.users.slice().sort((a, b) => b.points - a.points); // Sort by points descending

  let text = "🏆 **Global Leaderboard**\n\n";
  if (sortedUsers.length === 0) {
    text += "No players yet! Be the first to score points!";
  } else {
    sortedUsers.slice(0, 10).forEach((u, i) => { // Top 10 players
      const rank = getRank(u.points);
      const badge = prettyBadge(u.points, u.streak);
      text += `${i + 1}. **${prettyUsername(u)}** ${u.avatar || ""} — **${u.points} pts** ${badge} [Lvl ${getLevel(u.points)}, ${rank.name}]\n`;
    });
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});


// --- Admin Commands ---

// /broadcast <message>: Sends a message to all registered users (Admin only)
bot.onText(/^\/broadcast (.+)$/, async (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) {
    return bot.sendMessage(msg.chat.id, "🚫 You are not authorized to use this command.");
  }
  const broadcastMessage = match[1];
  await db.read();
  let sentCount = 0;
  for (const user of db.data.users) {
    try {
      await bot.sendMessage(user.id, broadcastMessage);
      sentCount++;
    } catch (e) {
      console.error(`Failed to send broadcast to user ${user.id}:`, e.message);
      // User might have blocked the bot, etc.
    }
  }
  bot.sendMessage(msg.chat.id, `✅ Broadcast sent to ${sentCount} users.`);
});

// /users: Lists all registered users (Admin only)
bot.onText(/^\/users$/, async msg => {
  if (String(msg.from.id) !== String(ADMIN_ID)) {
    return bot.sendMessage(msg.chat.id, "🚫 You are not authorized to use this command.");
  }
  await db.read();
  let text = `👥 **Registered Users (${db.data.users.length})**:`;
  db.data.users.slice(0, 50).forEach((u, i) => { // List first 50 users
    text += `\n${i + 1}. ${prettyUsername(u)} (ID: ${u.id}) - Pts: ${u.points}`;
  });
  if (db.data.users.length > 50) text += "\n...and more.";
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// /groupstats: Displays basic stats for groups the bot is in (Admin only)
bot.onText(/^\/groupstats$/, async msg => {
  if (String(msg.from.id) !== String(ADMIN_ID)) {
    return bot.sendMessage(msg.chat.id, "🚫 You are not authorized to use this command.");
  }
  await db.read();
  let groupChats = [];
  // Iterate through users' groupStats to find unique groups
  for (const user of db.data.users) {
    if (user.groupStats) {
      for (const groupId in user.groupStats) {
        if (!groupChats.some(g => String(g.id) === String(groupId))) {
          groupChats.push({ id: groupId, userCount: 0 });
        }
      }
    }
  }

  // Count users per group
  for (const group of groupChats) {
    group.userCount = db.data.users.filter(u => u.groupStats && u.groupStats[group.id]).length;
    // Attempt to get group title (best effort, might not be stored directly)
    try {
      const chat = await bot.getChat(group.id);
      group.title = chat.title || `Unnamed Group (ID: ${group.id})`;
    } catch (e) {
      group.title = `Unknown Group (ID: ${group.id})`;
    }
  }

  let text = "📚 **Groups Bot is Active In:**\n\n";
  if (groupChats.length === 0) {
    text += "Bot has not recorded activity in any groups yet.";
  } else {
    groupChats.forEach((g, i) => {
      text += `${i + 1}. **${g.title}** (Users: ${g.userCount})\n`;
    });
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});


// --- Poll Answer Handling (Core Logic) ---

bot.on('poll_answer', async answer => {
  await db.read();
  let user = db.data.users.find(u => u.id === answer.user.id);

  if (!user) {
    // If somehow user is not in DB, try to add them (edge case)
    user = await getUser({ from: answer.user });
  }

  const key = Object.keys(db.data.last_questions).find(k => k.endsWith(":" + user.id));
  const lastQuiz = db.data.last_questions[key];

  // If no quiz was in progress for this user, ignore
  if (!lastQuiz) return;

  const now = Date.now();
  let pointsAwarded = 0;
  let feedbackMessage = '';

  // Check if the chosen option is correct
  if (answer.option_ids && answer.option_ids.includes(lastQuiz.correct)) {
    pointsAwarded = 1; // Base points for correct answer
    // Award bonus points for fast answers (within 30 seconds)
    if ((now - lastQuiz.time) < 30000) {
      pointsAwarded = 2; // Bonus points
      feedbackMessage = "🚀 **Fast and Correct!** You earned 2 points!";
    } else {
      feedbackMessage = "✅ **Correct!** You earned 1 point!";
    }

    user.points += pointsAwarded;
    user.streak++; // Increment correct answer streak

    let prevLevel = user.level;
    let currLevel = getLevel(user.points);
    user.level = currLevel;

    // Notify if user leveled up
    if (currLevel > prevLevel) {
      feedbackMessage += `\n🎉 **Level Up!** You are now Level ${currLevel} (${getRank(user.points).name})!`;
    }

    await updateUser(user);
    bot.sendMessage(user.id, feedbackMessage, { parse_mode: "Markdown" });

    // Automatically send next quiz after correct answer (for continuous play)
    await sendQuiz(lastQuiz.chatId, user);
  } else {
    // Wrong answer
    user.streak = 0; // Reset streak on wrong answer
    await updateUser(user);
    bot.sendMessage(user.id, "❌ **Wrong Answer!** Your streak has been reset.\n\nWant to know the correct answer? Type `/answer`.", { parse_mode: "Markdown" });
    // Optionally send a new quiz even on wrong answer if it's a group or specific mode
    // if (lastQuiz.isGroup) await sendQuiz(lastQuiz.chatId, user);
  }
  // Clear the last question after answer, regardless of correctness
  delete db.data.last_questions[key];
  await db.write();
});

// Log when the bot starts
console.log("Deb's Quiz bot is running!");
