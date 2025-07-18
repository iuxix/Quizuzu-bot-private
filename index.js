require('dotenv').config();

// Paste the HTTP server code here:
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Deb's Quiz Bot is running!\n");
}).listen(PORT, () => {
  console.log(`Dummy HTTP server listening on port ${PORT}`);
});

// ...rest of your code (TelegramBot setup, etc.)

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const path = require('path');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;

const bot = new TelegramBot(TOKEN, { polling: true });
const db = new Low(new JSONFile(path.join(__dirname, 'db.json')));

const RANKS = [
  { name: "Rookie", points: 0 },
  { name: "Explorer", points: 10 },
  { name: "Mathlete", points: 25 },
  { name: "Science Star", points: 50 },
  { name: "Quiz Master", points: 100 },
  { name: "Prodigy", points: 200 },
  { name: "Legend", points: 400 }
];

function stripHtml(text) {
  if (!text) return "";
  return text.replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, "");
}
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
function getRank(points) {
  let result = RANKS[0];
  for (const tier of RANKS) if (points >= tier.points) result = tier;
  return result;
}
function getLevel(points) { return 1 + Math.floor(points / 25); }
function prettyBadge(points, streak = 0) {
  if (points >= 400) return "🏆";
  if (points >= 200) return "🥇";
  if (points >= 100) return "🥈";
  if (points >= 50) return "🥉";
  if (streak >= 10) return "🔥";
  if (streak >= 5) return "🌟";
  return "";
}
function prettyUsername(user) {
  return user.nickname || user.first_name || (user.username ? "@" + user.username : "User");
}
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
      groupStats: {}
    };
    db.data.users.push(user);
    await db.write();
    if (ADMIN_ID && String(ADMIN_ID) !== String(user.id)) {
      bot.sendMessage(ADMIN_ID, `🆕 👤 *New user joined*: ${prettyUsername(user)} (${user.id})\nTotal users: ${db.data.users.length}`, { parse_mode: "Markdown" });
    }
  }
  return user;
}
async function updateUser(user) {
  let idx = db.data.users.findIndex(u => u.id === user.id);
  db.data.users[idx] = user;
  await db.write();
}
(async function() {
  await db.read();
  db.data ||= { users: [], hints: {}, last_questions: {} };
  await db.write();
})();

// --- Quiz Logic ---
async function fetchQuestion() {
  let url, catNoun;
  const roll = Math.random();
  if (roll < 0.4) { url = "https://opentdb.com/api.php?amount=1&category=19&type=multiple"; catNoun = "🧮"; }
  else if (roll < 0.8) { url = "https://opentdb.com/api.php?amount=1&category=17&type=multiple"; catNoun = "🔬"; }
  else { url = "https://opentdb.com/api.php?amount=1&category=9&type=multiple"; catNoun = "🔤"; }
  const { data } = await axios.get(url);
  const q = data.results[0];
  let answers = shuffle([...q.incorrect_answers.map(stripHtml), stripHtml(q.correct_answer)]);
  return {
    question: `Solve This 🧠!\n\n${catNoun} ${stripHtml(q.question)}`,
    answers,
    correct: answers.indexOf(stripHtml(q.correct_answer)),
    explanation: `✨ *The correct answer is:* _${stripHtml(q.correct_answer)}_.\n\n🔎 *Explanation*: Use /quiz for more learning!`,
    hint: "💡 Think like a pro — try logic, eliminate, or recall concepts!"
  };
}
async function sendQuiz(chatId, user, isGroup = false) {
  const quiz = await fetchQuestion();
  db.data.last_questions[chatId + ":" + user.id] = { ...quiz, time: Date.now(), isGroup, chatId, answered: false, wrong: false };
  await db.write();
  bot.sendPoll(chatId, quiz.question, quiz.answers, {
    type: "quiz",
    correct_option_id: quiz.correct,
    is_anonymous: false,
    explanation: "🎯 Answer fast for max points! Use /hint if stuck."
  });
}

// --- Start Menu ---
const startMenu = `
🤖 *Welcome to Deb’s Quiz!*

✨ *Join the ultimate MCQ challenge for Math, Science & English!*

🎮 *Main Commands:*
/quiz – 🧠 Start a solo quiz
/fight – ⚔️ Battle in group (group chats)
/leaderboard – 🏆 See the leaderboard
/profile – 👤 See your stats & edit profile
/points – 💰 Your points, badges, streak
/ranks – 🏅 See all ranks & points needed
/daily – 🌞 Play the daily MCQ
/achievements – 🏅 View your badges
/hint – 💡 Get a hint (limit 3/day)
/answer – ℹ️ Explanation after wrong answer
/stats – 📊 Full progress & history

👑 *Admin Commands:*
/broadcast – 📢 Send a global message
/users – 👥 User list
/groups – 🌐 Groups list
/groupstats – 📈 Group stats

📣 *Speed bonus!* Fastest answers = +2 points! Climb up with /ranks.
`;


// --- Emoji-Rich Command Handlers ---

bot.onText(/^\/start$/, async msg => {
  await getUser(msg);
  bot.sendMessage(msg.chat.id, startMenu, { parse_mode: "Markdown" });
});

bot.onText(/^\/quiz$/, async msg => {
  let user = await getUser(msg);
  await sendQuiz(msg.chat.id, user, msg.chat.type.endsWith("group"));
});

bot.onText(/^\/fight$/, async msg => {
  if (!msg.chat.type.endsWith("group"))
    return bot.sendMessage(msg.chat.id, "⚔️ That’s a group-only battle! Add me to your group and try again.");
  let user = await getUser(msg);
  await sendQuiz(msg.chat.id, user, true);
});

bot.onText(/^\/points$/, async msg => {
  let user = await getUser(msg);
  const badge = prettyBadge(user.points, user.streak);
  const rank = getRank(user.points);
  const text = [
    "💰 *Your Points, Level, Rank*",
    "",
    `💰 *Points*: ${user.points}`,
    `🏅 *Rank*: ${rank.name}  ${badge ? badge : ""}`,
    `🌟 *Level*: ${getLevel(user.points)}`,
    `🔥 *Streak*: ${user.streak}`,
    "",
    "Keep winning quizzes and streaking for higher ranks & badges!",
    "─────"
  ].join('\n');
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/^\/profile$/, async msg => {
  let user = await getUser(msg);
  const badge = prettyBadge(user.points, user.streak);
  const text = [
    "👤 *Your Profile*",
    "",
    `🆔 *Username*: ${prettyUsername(user)} ${user.avatar || ""}`,
    `🏅 *Rank*: ${getRank(user.points).name}  ${badge ? badge : ""}`,
    `🌟 *Level*: ${getLevel(user.points)}`,
    `💰 *Points*: ${user.points}`,
    `🔥 *Streak*: ${user.streak}`,
    `🎖️ *Badges*: ${user.badges.length ? user.badges.join(", ") : "None yet"}`,
    "",
    "✏️ *Change Nickname*: `/setnick <your_name>`",
    "🎨 *Change Avatar*: `/setavatar <emoji>`",
    "",
    "🏆 Keep playing to earn more! Use /quiz to start!",
    "─────────────────────"
  ].join('\n');
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/^\/setnick (.+)$/, async (msg, match) => {
  let user = await getUser(msg);
  user.nickname = match[1].trim().substring(0, 20);
  await updateUser(user);
  bot.sendMessage(msg.chat.id, `✏️ Nickname changed to: *${user.nickname}* — it’ll show on the leaderboard & stats!`, { parse_mode: "Markdown" });
});

bot.onText(/^\/setavatar (.+)$/, async (msg, match) => {
  let user = await getUser(msg);
  user.avatar = match[1].trim().substring(0, 2);
  await updateUser(user);
  bot.sendMessage(msg.chat.id, `🎨 Avatar changed to: ${user.avatar} — stand out on the leaderboard!`);
});

bot.onText(/^\/ranks$/, msg => {
  let text = "🏅 *Ranks & Level System*: \n\n" + RANKS.map((r, i) =>
    `${i + 1}. ${r.name} — ${r.points} points`).join('\n') +
    `\n\nEach rank brings new badges and flex. Play daily for fastest upgrades!\n─────`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/^\/hint$/, async msg => {
  let user = await getUser(msg);
  const key = msg.chat.id + ":" + user.id;
  const lastQuiz = db.data.last_questions[key];
  if (!lastQuiz) return bot.sendMessage(msg.chat.id, "💡 No quiz running. Use /quiz to get a question!");
  db.data.hints[user.id] ||= { used: 0, lastReset: Date.now() };
  let hintData = db.data.hints[user.id];
  const now = new Date();
  const lastReset = new Date(hintData.lastReset);
  if (now.toDateString() !== lastReset.toDateString()) {
    hintData.used = 0; hintData.lastReset = Date.now();
  }
  if (hintData.used >= 3) return bot.sendMessage(msg.chat.id, "🚫 All 3 hints used for today! Come back tomorrow.");
  hintData.used++;
  await db.write();
  bot.sendMessage(msg.chat.id, `💡 *Hint*: ${lastQuiz.hint}`, { parse_mode: "Markdown" });
});

bot.onText(/^\/answer$/, async msg => {
  let user = await getUser(msg);
  const key = msg.chat.id + ":" + user.id;
  const lastQuiz = db.data.last_questions[key];

  if (!lastQuiz)
    return bot.sendMessage(msg.chat.id, "ℹ️ No recent quiz to show the answer. Use /quiz to get started!");

  if (!lastQuiz.answered)
    return bot.sendMessage(msg.chat.id, "🚦 Solve the MCQ first! You’ll unlock /answer only if you get it wrong.");

  if (!lastQuiz.wrong)
    return bot.sendMessage(msg.chat.id, "✅ You answered that correctly! No need for /answer. Try another /quiz!");

  bot.sendMessage(msg.chat.id, lastQuiz.explanation, { parse_mode: "Markdown" });
});

bot.onText(/^\/leaderboard$/, async msg => {
  await db.read();
  const top = db.data.users.slice()
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);

  if (!top.length)
    return bot.sendMessage(msg.chat.id, "🏆 *Leaderboard Empty*\n\nNo players yet. Your name could shine here! Start with /quiz.", { parse_mode: "Markdown" });

  let medals = ["🥇", "🥈", "🥉"];
  let leaderboard = top.map((u, i) => {
    const badge = prettyBadge(u.points, u.streak);
    return `${medals[i] || "🔹"} *${prettyUsername(u)}* ${u.avatar || ""}\n• Points: _${u.points}_ ${badge ? `| ${badge}` : ""}\n• Level: _${getLevel(u.points)}_`;
  }).join('\n\n');

  bot.sendMessage(
    msg.chat.id,
    `🏆 *Leaderboard: Top Prodigies*\n\n${leaderboard}\n\n🎯 Keep quizzing to jump higher!`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/^\/achievements$/, async msg => {
  let user = await getUser(msg);
  bot.sendMessage(
    msg.chat.id,
    `🏅 *Badges*: ${user.badges.length ? user.badges.join(", ") : "None yet"}\nSpecial: ${prettyBadge(user.points, user.streak)}`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/^\/stats$/, async msg => {
  let user = await getUser(msg);
  bot.sendMessage(
    msg.chat.id,
    [
      "🌟 *Your Quiz Progress* 🌟",
      "",
      `👤 *Username*: ${prettyUsername(user)} ${user.avatar || ""}`,
      `🏅 *Rank*: ${getRank(user.points).name}  ${prettyBadge(user.points, user.streak)}`,
      `🌟 *Level*: ${getLevel(user.points)}`,
      `💰 *Points*: ${user.points}`,
      `🔥 *Streak*: ${user.streak}`,
      `🎖️ *Badges*: ${user.badges.length ? user.badges.join(", ") : "None yet"}`,
      "",
      "🎯 Tip: Play /daily challenge for secret achievements!",
      "───────────────"
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
});

bot.onText(/^\/daily$/, async msg => {
  let user = await getUser(msg);
  bot.sendMessage(msg.chat.id, "🌞 *Daily Challenge:*\nReady for your best?", { parse_mode: "Markdown" });
  await sendQuiz(msg.chat.id, user);
});

bot.onText(/^\/challenge$/, async msg => {
  bot.sendMessage(msg.chat.id, "🤝 1v1 challenge mode coming soon! For now, try a single /quiz.");
});

// --- Admin Commands ---

bot.onText(/^\/broadcast (.+)$/i, async (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) {
    return bot.sendMessage(msg.chat.id, "🚫 Only the admin can broadcast.");
  }
  const msgText = match[1];
  await db.read();
  let sent = 0, failed = 0;
  for (const user of db.data.users) {
    try {
      await bot.sendMessage(user.id, `📢 *Announcement:*\n${msgText}`, { parse_mode: "Markdown" });
      sent++;
    } catch (err) {
      failed++;
    }
  }
  bot.sendMessage(msg.chat.id, `✅ Broadcast sent!\n\n📬 Delivered: *${sent}*\n❌ Failed: *${failed}*`, { parse_mode: "Markdown" });
});
bot.onText(/^\/subs$/, async msg => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  await db.read();
  let text = `👥 *Subscribers*: ${db.data.users.length}\n\n`;
  text += db.data.users.slice(0, 50).map((u, i) => `${i+1}. ${prettyUsername(u)} [${u.id}]`).join('\n');
  if (db.data.users.length > 50) text += "\n...and more.";
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});
bot.onText(/^\/groups$/, async msg => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  await db.read();
  let groups = [];
  db.data.users.forEach(u => {
    if (u.groupStats) {
      for (let gid in u.groupStats) {
        if (!groups.some(g => g.id==gid))
          groups.push({id: gid, count: 1});
        else
          groups.find(g => g.id==gid).count++;
      }
    }
  });
  let text = "📚 *Groups:*\n" + groups.map((g, i)=>`${i+1}. Group ID: ${g.id} – users: ${g.count}`).join('\n');
  if (!groups.length) text += "\nNo group stats yet.";
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});
bot.onText(/^\/groupstats$/, async msg => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  await db.read();
  let groupChats = [];
  for (const user of db.data.users) {
    if (user.groupStats) {
      for (const groupId in user.groupStats) {
        if (!groupChats.some(g => String(g.id) === String(groupId))) {
          groupChats.push({ id: groupId, userCount: 0 });
        }
      }
    }
  }
  for (const group of groupChats) {
    group.userCount = db.data.users.filter(u => u.groupStats && u.groupStats[group.id]).length;
  }
  let text = "📚 *Groups:*\n";
  if (!groupChats.length) text += "No group stats yet.";
  else groupChats.forEach((g, i) => {
    text += `${i + 1}. GroupID: ${g.id} Users: ${g.userCount}\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});
bot.onText(/^\/users$/, async msg => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  await db.read();
  let text = "👥 *Users:*\n";
  text += db.data.users.slice(0, 50).map((u, i) => `${i+1}. ${prettyUsername(u)} [${u.id}] points: ${u.points}`).join('\n');
  if (db.data.users.length > 50) text += `\n...and more (${db.data.users.length} total).`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// --- Poll Answer Handler and /answer Protection ---
bot.on('poll_answer', async answer => {
  await db.read();
  let user = db.data.users.find(u => u.id === answer.user.id);
  if (!user) user = await getUser({ from: answer.user });
  let key = Object.keys(db.data.last_questions).find(k => k.endsWith(":" + user.id));
  let last = db.data.last_questions[key];
  if (!last) return;
  let now = Date.now(), bonus = 1;
  last.answered = true;
  if (answer.option_ids && answer.option_ids.includes(last.correct)) {
    last.wrong = false;
    bonus = (now - last.time < 30000) ? 2 : 1;
    user.points += bonus;
    user.streak++;
    let prevLvl = user.level, currLvl = getLevel(user.points);
    user.level = currLvl;
    let up = [
      `✅ *Correct!* (+${bonus} points)`,
      `🔥 *Streak*: ${user.streak}`
    ];
    if (currLvl > prevLvl) up.push(`🆙 Level up: *${getRank(user.points).name}*`);
    await updateUser(user);
    bot.sendMessage(user.id, up.join('\n'), { parse_mode: "Markdown" });
    sendQuiz(last.chatId, user, !!last.isGroup);
  } else {
    last.wrong = true;
    user.streak = 0;
    await updateUser(user);
    bot.sendMessage(user.id, `❌ *Wrong!*\nWant the explanation? Type /answer.`, { parse_mode: "Markdown" });
    if (last.isGroup) sendQuiz(last.chatId, user, true);
  }
  db.data.last_questions[key] = last;
  await db.write();
});

console.log("🎉 Deb's Quiz bot is running — professional, emoji-rich, and ready for the world!");
