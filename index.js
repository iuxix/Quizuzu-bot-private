require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const path = require('path');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const ADMIN_ID = process.env.ADMIN_ID;
const db = new Low(new JSONFile(path.join(__dirname, 'db.json')));
const broadcastWaiters = new Set();

(async () => {
  await db.read();
  db.data ||= { users: [], hints: {}, last_questions: {} };
  await db.write();
})();

const RANKS = [
  { name: "Rookie", points: 0, emoji: "⬜" },
  { name: "Explorer", points: 10, emoji: "🔹" },
  { name: "Mathlete", points: 25, emoji: "➗" },
  { name: "Quiz Master", points: 100, emoji: "🥈" },
  { name: "Prodigy", points: 200, emoji: "🥇" },
  { name: "Legend", points: 400, emoji: "🏆" }
];

function stripHtml(t) {
  if (!t) return "";
  return t.replace(/&quot;/g, '"')
   .replace(/&#039;/g,"'").replace(/&amp;/g,"&")
   .replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/<[^>]+>/g,"");
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const getRank = pts => RANKS.slice().reverse().find(r => pts >= r.points);
const getLevel = pts => 1 + Math.floor(pts/25);
const prettyBadge = (pts, streak = 0) => pts >= 400 ? "🏆" : pts >= 200 ? "🥇" : pts >= 100 ? "🥈" : pts >= 50 ? "🥉" : streak >= 10 ? "🔥" : streak >= 5 ? "🌟" : "";
const prettyUsername = (u, md = false) => md && u.username ? `[${u.nickname||u.first_name||("@" + u.username)}](https://t.me/${u.username})` : (u.username ? "@" + u.username : u.nickname || u.first_name || "User");

// --- DB User helpers
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
    };
    db.data.users.push(user);
    await db.write();
    if (ADMIN_ID && String(ADMIN_ID) !== String(user.id)) {
      bot.sendMessage(ADMIN_ID, `🆕 👤 *New user joined:* ${prettyUsername(user, true)} (\`${user.id}\`)\n👥 Total users: ${db.data.users.length}`, { parse_mode: "Markdown" });
    }
  }
  return user;
}
async function updateUser(u) {
  await db.read();
  const idx = db.data.users.findIndex(x => x.id === u.id);
  if (idx !== -1) db.data.users[idx] = u;
  await db.write();
}

// --- Fetch quiz from OpenTDB (Math Only)
async function fetchQuiz() {
  const { data } = await axios.get("https://opentdb.com/api.php?amount=1&category=19&type=multiple");
  const q = data.results[0];
  const correct = stripHtml(q.correct_answer);
  const answers = shuffle([...q.incorrect_answers.map(stripHtml), correct]);
  return {
    question: `🧮 *Math Quiz!*\n\n${stripHtml(q.question)}`,
    answers,
    correct,
    correctIndex: answers.indexOf(correct),
    explanation: `✨ *Correct answer:* _${correct}_`,
    hint: "💡 Think mathematically! Eliminate and solve logically.",
  };
}

// --- Start MENU
const startMenu = `
🤖 *Welcome to Deb’s Quiz!*

✨ *Ultimate MCQ Challenge for Math!*

🎮 *Main Commands:*
/quiz – 🧮 Start math quiz
/fight – ⚔️ Group quiz battle
/leaderboard – 🏆 Group top 10
/profile – 👤 Your profile & stats
/setnick <name> – ✏️ Nickname
/setavatar <emoji> – 🎨 Avatar
/points – 💰 Coins, badges, streak
/daily – 🌞 Daily math quiz
/achievements – 🏅 Badges
/hint – 💡 Get a hint (3/day)
/answer – ℹ️ Explanation if wrong
/ranks – 🏅 Rank levels
/stats – 📊 Your progress

👑 *Admin Only:*
/broadcast – 📢 Message all users
/users – 👥 User list
/subs – 👥 User count

📣 *Speed bonus!* Fastest answers = +2 points!
`;

bot.onText(/^\/start$/, async msg => {
  await getUser(msg);
  bot.sendMessage(msg.chat.id, startMenu, { parse_mode: "Markdown" });
});

// --- QUIZ
async function sendQuiz(chatId, user, isGroup = false) {
  const quiz = await fetchQuiz();
  db.data.last_questions[`${chatId}:${user.id}`] = {
    ...quiz, time: Date.now(), chatId, userId: user.id, answered: false, isGroup
  };
  await db.write();
  await bot.sendPoll(chatId, quiz.question, quiz.answers, {
    type: "quiz", correct_option_id: quiz.correctIndex, is_anonymous: false,
    explanation: "🎯 Fastest right answer: +2 pts! Use /hint if stuck."
  });
}

bot.onText(/^\/quiz$/, async msg => {
  const user = await getUser(msg);
  await sendQuiz(msg.chat.id, user, msg.chat.type.endsWith("group"));
});
bot.onText(/^\/fight$/, async msg => {
  if (!msg.chat.type.endsWith("group"))
    return bot.sendMessage(msg.chat.id, "⚔️ Use /fight in a group chat!");
  const user = await getUser(msg);
  await sendQuiz(msg.chat.id, user, true);
});

// --- Poll answer handling (ensures ALL messages go where quiz was posted)
bot.on('poll_answer', async answer => {
  await db.read();
  const user = db.data.users.find(u => u.id === answer.user.id);
  if (!user) return;
  const entryKey = Object.keys(db.data.last_questions).find(k => k.endsWith(":"+user.id));
  if (!entryKey) return;
  const last = db.data.last_questions[entryKey];
  if (!last || last.answered) return;
  last.answered = true;
  const chatId = last.chatId;
  const now = Date.now();
  let bonus = 1;
  if (answer.option_ids.includes(last.correctIndex)) {
    bonus = (now - last.time < 30000 ? 2 : 1);
    user.points += bonus;
    user.streak++;
    user.level = getLevel(user.points);
    await updateUser(user);
    bot.sendMessage(chatId, `✅ *Correct!* (+${bonus} pts) – ${prettyUsername(user, true)}\n🔥 *Streak:* ${user.streak}`, { parse_mode: "Markdown" });
    setTimeout(() => sendQuiz(chatId, user, last.isGroup), 900);
  } else {
    user.streak = 0;
    await updateUser(user);
    last.wrong = true;
    bot.sendMessage(chatId, `❌ *Wrong!* – ${prettyUsername(user, true)}\nType /answer to check the solution.`, { parse_mode: "Markdown" });
  }
  db.data.last_questions[entryKey] = last;
  await db.write();
});
// --- Answer/Hint/Leaderboard/Stats/Profile/Admin etc.

bot.onText(/^\/answer/, async msg => {
  const user = await getUser(msg);
  const key = msg.chat.id + ":" + user.id;
  const last = db.data.last_questions[key];
  if (!last) return bot.sendMessage(msg.chat.id, "ℹ️ No quiz to explain. Try /quiz first!");
  if (!last.answered) return bot.sendMessage(msg.chat.id, "🕐 Solve the quiz first!");
  if (!last.wrong) return bot.sendMessage(msg.chat.id, "✅ You got it right! Try another /quiz.");
  bot.sendMessage(msg.chat.id, last.explanation, { parse_mode: "Markdown" });
});

bot.onText(/^\/profile$/, async msg => {
  const user = await getUser(msg);
  const txt = [
    "👤 *Your Profile*",
    `🆔 *Username*: ${prettyUsername(user, true)} ${user.avatar || ''}`,
    `🏅 *Rank*: ${getRank(user.points).emoji} ${getRank(user.points).name}`,
    `🌟 *Level*: ${getLevel(user.points)}`,
    `💰 *Points*: ${user.points}`,
    `🔥 *Streak*: ${user.streak}`,
    `🎖️ *Badges*: ${user.badges.length ? user.badges.join(', ') : 'None'}`,
    "",
    "✏️ /setnick <name> | 🎨 /setavatar <emoji>"
  ].join('\n');
  bot.sendMessage(msg.chat.id, txt, { parse_mode: "Markdown" });
});
bot.onText(/^\/setnick (.+)$/, async (msg, match) => {
  const user = await getUser(msg);
  user.nickname = match[1].substring(0, 20);
  await updateUser(user);
  bot.sendMessage(msg.chat.id, `✅ Nickname set to: *${user.nickname}*`, { parse_mode: "Markdown" });
});
bot.onText(/^\/setavatar (.+)$/, async (msg, match) => {
  const user = await getUser(msg);
  user.avatar = match[1].substring(0, 2);
  await updateUser(user);
  bot.sendMessage(msg.chat.id, `🎨 Avatar set to: ${user.avatar}`);
});
bot.onText(/^\/points$/, async msg => {
  const user = await getUser(msg);
  const txt = `💰 *Your Points:*\n\n🏅 Rank: ${getRank(user.points).emoji} ${getRank(user.points).name}\n🌟 Level: ${getLevel(user.points)}\n🔥 Streak: ${user.streak}\n💎 Total Points: ${user.points}`;
  bot.sendMessage(msg.chat.id, txt, { parse_mode: "Markdown" });
});
bot.onText(/^\/ranks$/, (msg) => {
  const text = ["🏅 *Rank Levels:*"];
  RANKS.forEach(r => text.push(`${r.emoji} ${r.name} – ${r.points} pts`));
  bot.sendMessage(msg.chat.id, text.join('\n'), { parse_mode: "Markdown" });
});
bot.onText(/^\/stats$/, async (msg) => {
  const user = await getUser(msg);
  const txt = `📊 *Progress for ${prettyUsername(user, true)}*\n\n🏅 Rank: ${getRank(user.points).name} ${getRank(user.points).emoji}\n💰 Points: ${user.points}\n🔥 Streak: ${user.streak}\n🌟 Level: ${getLevel(user.points)}\n🎖️ Badges: ${user.badges.length ? user.badges.join(', ') : 'None'}`;
  bot.sendMessage(msg.chat.id, txt, { parse_mode: "Markdown" });
});
bot.onText(/^\/achievements$/, async (msg) => {
  const user = await getUser(msg);
  bot.sendMessage(msg.chat.id, `🎖️ *Badges*: ${user.badges.length ? user.badges.join(", ") : "None yet"}\nSpecial: ${prettyBadge(user.points, user.streak)}`, { parse_mode: "Markdown" });
});
bot.onText(/^\/hint$/, async (msg) => {
  const user = await getUser(msg);
  const key = msg.chat.id + ":" + user.id;
  const last = db.data.last_questions[key];
  if (!last) return bot.sendMessage(msg.chat.id, "ℹ️ No active quiz. Type /quiz!");
  const now = new Date();
  db.data.hints[user.id] ||= { used: 0, lastReset: Date.now() };
  const hintData = db.data.hints[user.id];
  const lastReset = new Date(hintData.lastReset);
  if (now.toDateString() !== lastReset.toDateString()) {
    hintData.used = 0; hintData.lastReset = Date.now();
  }
  if (hintData.used >= 3) return bot.sendMessage(msg.chat.id, "🚫 All 3 hints used today!");
  hintData.used++;
  await db.write();
  bot.sendMessage(msg.chat.id, `💡 *Hint:* ${last.hint}`, { parse_mode: "Markdown" });
});
bot.onText(/^\/daily$/, async (msg) => {
  const user = await getUser(msg);
  bot.sendMessage(msg.chat.id, "🌞 *Daily Math Challenge!*",{parse_mode:"Markdown"});
  await sendQuiz(msg.chat.id, user, msg.chat.type.endsWith("group"));
});

// --- Group-only leaderboard
bot.onText(/^\/leaderboard$/, async (msg) => {
  if (!msg.chat.type.endsWith("group"))
    return bot.sendMessage(msg.chat.id, "🏆 *Leaderboard only in groups!*", { parse_mode: "Markdown" });
  await db.read();
  const top = db.data.users.filter(u => u.points > 0).sort((a, b) => b.points - a.points).slice(0, 10);
  if (!top.length) return bot.sendMessage(msg.chat.id, "😴 No points yet. Use /quiz!", { parse_mode: "Markdown" });

  const lines = top.map((u, i) =>
    `${i + 1}. ${prettyUsername(u, true)} (${u.username ? `@${u.username}` : "No username"})\n🏅 ${getRank(u.points).emoji} ${getRank(u.points).name} — ${u.points} pts`
  );
  bot.sendMessage(msg.chat.id, `🏆 *Top Players:*\n\n${lines.join('\n\n')}`, { parse_mode: "Markdown" });
});

// --- Admin
bot.onText(/^\/users$/, async (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  await db.read();
  const txt = db.data.users.slice(0, 50).map((u, i) =>
    `${i + 1}. ${prettyUsername(u, true)} [${u.id}] — ${u.points} pts`
  ).join('\n');
  bot.sendMessage(msg.chat.id, `👤 *Users:*\n\n${txt}`, { parse_mode: "Markdown" });
});
bot.onText(/^\/subs$/, async (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  await db.read();
  bot.sendMessage(msg.chat.id, `👥 Total Subscribers: ${db.data.users.length}`);
});
bot.onText(/^\/broadcast$/, (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  bot.sendMessage(msg.chat.id, "📨 Send the message/media to broadcast to all users.");
  broadcastWaiters.add(msg.from.id);
});
bot.on('message', async (msg) => {
  if (!broadcastWaiters.has(msg.from.id) || String(msg.from.id) !== String(ADMIN_ID)) return;
  await db.read();
  broadcastWaiters.delete(msg.from.id);
  let sent = 0, failed = 0;
  for (const user of db.data.users) {
    try {
      const id = user.id;
      if (msg.text) await bot.sendMessage(id, msg.text);
      else if (msg.photo) await bot.sendPhoto(id, msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption || "" });
      else if (msg.video) await bot.sendVideo(id, msg.video.file_id, { caption: msg.caption || "" });
      else if (msg.document) await bot.sendDocument(id, msg.document.file_id, { caption: msg.caption || "" });
      else if (msg.audio) await bot.sendAudio(id, msg.audio.file_id, { caption: msg.caption || "" });
      else if (msg.voice) await bot.sendVoice(id, msg.voice.file_id, { caption: msg.caption || "" });
      else if (msg.sticker) await bot.sendSticker(id, msg.sticker.file_id);
      sent++;
    } catch { failed++; }
  }
  bot.sendMessage(msg.chat.id, `✅ Broadcast sent.\n📬 Sent: ${sent}\n❌ Failed: ${failed}`);
});

console.log("✅ Deb’s Quiz Bot is running! No features missing.");
