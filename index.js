require('dotenv').config();
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
  { name: "Rookie", pts: 0 },
  { name: "Explorer", pts: 10 },
  { name: "Mathlete", pts: 25 },
  { name: "Science Star", pts: 50 },
  { name: "Quiz Master", pts: 100 },
  { name: "Prodigy", pts: 200 },
  { name: "Legend", pts: 400 }
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
  for (const tier of RANKS) if (points >= tier.pts) result = tier;
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
      bot.sendMessage(ADMIN_ID, `👤 New user: ${prettyUsername(user)} (ID: ${user.id})\nTotal users: ${db.data.users.length}`);
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

// --- Quiz logic ---
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
    question: `${catNoun} ${stripHtml(q.question)}`,
    answers,
    correct: answers.indexOf(stripHtml(q.correct_answer)),
    explanation: `The correct answer is: ${stripHtml(q.correct_answer)}.`,
    hint: "💡 Try elimination or recall basic concepts."
  };
}
async function sendQuiz(chatId, user, isGroup = false) {
  const quiz = await fetchQuestion();
  db.data.last_questions[chatId + ":" + user.id] = { ...quiz, time: Date.now(), isGroup, chatId };
  await db.write();
  bot.sendPoll(chatId, quiz.question, quiz.answers, {
    type: "quiz",
    correct_option_id: quiz.correct,
    is_anonymous: false,
    explanation: "Choose wisely to earn points!"
  });
}

// --- Full Start Menu ---
const startMenu = `
🤖 Welcome to Deb’s Quiz!
MCQs from Math, Science, English. Earn points, ranks, badges. Level up, challenge friends, leaderboard, admin broadcast — all in one bot!

🟦 Student:
/quiz – 🎯 Start quiz
/fight – ⚔️ Group battle
/leaderboard – 🏆 View leaderboard
/ranks – 🏅 Rank levels
/points – 💰 Show points, badge, level
/profile – 🧑‍💻 Profile, set nickname/avatar
/daily – 🌞 Daily challenge
/challenge – 🤝 1v1 Challenge
/hint – 💡 Get a hint! (3 per day)
/answer – ℹ️ See answer/explanation
/achievements – 🏅 Badges collection
/stats – 📊 Progress stats

👑 Admin:
/broadcast – 📢 Announce to all
/subs – 📊 List subscribers
/groups – 📚 List groups
/groupstats – 📈 Group leaderboard
/users – 👥 User list
/setadmin – ⚙️ Manage admins

✨ Fast (<30s): +2 pts! Slow: +1. Level up for higher ranks. Use /ranks for details!
`;

// --- Commands ---
bot.onText(/^\/start$/, async msg => {
  await getUser(msg);
  bot.sendMessage(msg.chat.id, startMenu);
});
bot.onText(/^\/quiz$/, async msg => {
  let user = await getUser(msg);
  await sendQuiz(msg.chat.id, user, msg.chat.type.endsWith("group"));
});
bot.onText(/^\/fight$/, async msg => {
  if (!msg.chat.type.endsWith("group"))
    return bot.sendMessage(msg.chat.id, "This is for group battles only!");
  let user = await getUser(msg);
  await sendQuiz(msg.chat.id, user, true);
});
bot.onText(/^\/points$/, async msg => {
  let user = await getUser(msg);
  const badge = prettyBadge(user.points, user.streak);
  const rank = getRank(user.points);
  bot.sendMessage(msg.chat.id, `Points: ${user.points} ${badge}\nLevel: ${getLevel(user.points)} (${rank.name})\nStreak: ${user.streak}`);
});
bot.onText(/^\/profile$/, async msg => {
  let user = await getUser(msg);
  bot.sendMessage(msg.chat.id, `Name: ${prettyUsername(user)}\nAvatar: ${user.avatar || "👤"}\nLevel: ${getLevel(user.points)}\nRank: ${getRank(user.points).name}\nPoints: ${user.points}\nBadges: ${user.badges.join(", ") || "None"}\nTo set nickname: /setnick <your_nick>\nTo set avatar: /setavatar <emoji>`);
});
bot.onText(/^\/setnick (.+)$/, async (msg, match) => {
  let user = await getUser(msg);
  user.nickname = match[1].trim().substring(0, 20);
  await updateUser(user);
  bot.sendMessage(msg.chat.id, `✅ Nickname updated: ${user.nickname}`);
});
bot.onText(/^\/setavatar (.+)$/, async (msg, match) => {
  let user = await getUser(msg);
  user.avatar = match[1].trim().substring(0, 2);
  await updateUser(user);
  bot.sendMessage(msg.chat.id, `✅ Avatar updated: ${user.avatar}`);
});
bot.onText(/^\/ranks$/, msg => {
  let text = "🏅 Ranks:\n" + RANKS.map((r, i) => `${i + 1}. ${r.name} — ${r.pts} pts`).join('\n');
  bot.sendMessage(msg.chat.id, text);
});
bot.onText(/^\/hint$/, async msg => {
  let user = await getUser(msg);
  const key = msg.chat.id + ":" + user.id;
  const lastQuiz = db.data.last_questions[key];
  if (!lastQuiz) return bot.sendMessage(msg.chat.id, "No quiz running. Use /quiz!");
  db.data.hints[user.id] ||= { used: 0, lastReset: Date.now() };
  let hintData = db.data.hints[user.id];
  const now = new Date();
  const lastReset = new Date(hintData.lastReset);
  if (now.toDateString() !== lastReset.toDateString()) {
    hintData.used = 0; hintData.lastReset = Date.now();
  }
  if (hintData.used >= 3) return bot.sendMessage(msg.chat.id, "All 3 hints used for today! Try again tomorrow.");
  hintData.used++;
  await db.write();
  bot.sendMessage(msg.chat.id, `Hint: ${lastQuiz.hint}`);
});
bot.onText(/^\/answer$/, async msg => {
  let user = await getUser(msg);
  const key = msg.chat.id + ":" + user.id;
  const lastQuiz = db.data.last_questions[key];
  if (!lastQuiz) return bot.sendMessage(msg.chat.id, "No previous quiz. Use /quiz!");
  bot.sendMessage(msg.chat.id, lastQuiz.explanation);
});
bot.onText(/^\/leaderboard$/, async msg => {
  await db.read();
  let arr = db.data.users.slice().sort((a, b) => b.points - a.points).slice(0, 10);
  let s = arr.map((u, i) => `${i + 1}. ${prettyUsername(u)} — ${u.points} pts`).join('\n');
  bot.sendMessage(msg.chat.id, `Leaderboard:\n${s || "No players yet."}`);
});
bot.onText(/^\/achievements$/, async msg => {
  let user = await getUser(msg);
  bot.sendMessage(msg.chat.id, `Badges: ${user.badges.join(", ") || "None"}\nSpecial: ${prettyBadge(user.points, user.streak)}`);
});
bot.onText(/^\/stats$/, async msg => {
  let user = await getUser(msg);
  bot.sendMessage(msg.chat.id, `Your stats:\nPoints: ${user.points}\nLevel: ${getLevel(user.points)} (${getRank(user.points).name})\nStreak: ${user.streak}\nBadges: ${user.badges.join(", ") || "None"}`);
});
bot.onText(/^\/daily$/, async msg => {
  let user = await getUser(msg);
  bot.sendMessage(msg.chat.id, "🌞 Your daily challenge:", { reply_markup: { remove_keyboard: true } });
  await sendQuiz(msg.chat.id, user);
});
bot.onText(/^\/challenge$/, async msg => {
  bot.sendMessage(msg.chat.id, "🤝 1v1 challenge coming soon! Type /quiz for now.");
});

// --- Admin commands ---
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
    } catch {}
  }
  bot.sendMessage(msg.chat.id, `✅ Broadcast sent to ${sentCount} users.`);
});
bot.onText(/^\/subs$/, async msg => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  await db.read();
  let text = `Subscribers: ${db.data.users.length}\n\n`;
  text += db.data.users.slice(0, 50).map((u, i) => `${i+1}. ${prettyUsername(u)} [${u.id}]`).join('\n');
  if (db.data.users.length > 50) text += "\n...and more.";
  bot.sendMessage(msg.chat.id, text);
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
  let text = "Groups:\n" + groups.map((g, i)=>`${i+1}. Group ID: ${g.id} – users: ${g.count}`).join('\n');
  if (!groups.length) text += "\nNo group stats yet.";
  bot.sendMessage(msg.chat.id, text);
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
  let text = "Groups:\n";
  if (!groupChats.length) text += "No group stats yet.";
  else groupChats.forEach((g, i) => {
    text += `${i + 1}. GroupID: ${g.id} Users: ${g.userCount}\n`;
  });
  bot.sendMessage(msg.chat.id, text);
});
bot.onText(/^\/users$/, async msg => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  await db.read();
  let text = "Users:\n";
  text += db.data.users.slice(0, 50).map((u, i) => `${i+1}. ${prettyUsername(u)} [${u.id}] pts: ${u.points}`).join('\n');
  if (db.data.users.length > 50) text += `\n...and more (${db.data.users.length} total).`;
  bot.sendMessage(msg.chat.id, text);
});
bot.onText(/^\/setadmin(?: (.+))?$/, async (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  if (!match[1]) return bot.sendMessage(msg.chat.id, "Usage: /setadmin <user_id>");
  bot.sendMessage(msg.chat.id, "Set admin placeholder (depends on your admin list handling)");
});

// --- Scoring and next-quiz logic ---
bot.on('poll_answer', async answer => {
  await db.read();
  let user = db.data.users.find(u => u.id === answer.user.id);
  if (!user) user = await getUser({ from: answer.user });
  let key = Object.keys(db.data.last_questions).find(k => k.endsWith(":" + user.id));
  let last = db.data.last_questions[key];
  if (!last) return;
  let now = Date.now(), bonus = 1;
  if (answer.option_ids && answer.option_ids.includes(last.correct)) {
    if (now - last.time < 30000) bonus = 2;
    user.points += bonus; user.streak++;
    let up = `Correct! (+${bonus} pts)`;
    let prevLvl = user.level, currLvl = getLevel(user.points);
    user.level = currLvl;
    if (currLvl > prevLvl) up += ` 🎉 Level up! Now level ${currLvl}`;
    await updateUser(user);
    bot.sendMessage(user.id, up);
    sendQuiz(last.chatId, user, !!last.isGroup);
  } else {
    user.streak = 0;
    await updateUser(user);
    bot.sendMessage(user.id, `Wrong! Try again! Type /answer to see correct answer.`);
    if (last.isGroup) sendQuiz(last.chatId, user, true);
  }
  delete db.data.last_questions[key];
  await db.write();
});
console.log("Deb's Quiz bot is running!");
