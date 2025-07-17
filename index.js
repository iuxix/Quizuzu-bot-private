require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { Low, JSONFile } = require('lowdb');
const path = require('path');

// === BOT SETUP ===
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const bot = new TelegramBot(TOKEN, { polling: true });
const db = new Low(new JSONFile(path.join(__dirname, 'db.json')));

// === RANKS CONFIG ===
const rankTiers = [
  { name: "Rookie", pts: 0 },
  { name: "Explorer", pts: 10 },
  { name: "Mathlete", pts: 25 },
  { name: "Science Star", pts: 50 },
  { name: "Quiz Master", pts: 100 },
  { name: "Prodigy", pts: 200 },
  { name: "Legend", pts: 400 }
];

// === DB INIT ===
async function initDB() {
  await db.read();
  db.data ||= {
    users: [],
    groups: [],
    hints: {},
    last_questions: {},
  };
  await db.write();
}
initDB();

// === UTILS ===
function getRank(points) {
  let result = rankTiers[0];
  for (const tier of rankTiers) if (points >= tier.pts) result = tier;
  return result;
}
function getLevel(points) {
  return 1 + Math.floor(points / 25);
}
function prettyBadge(points, streak=0) {
  if (points >= 400) return "🏆";
  if (points >= 200) return "🥇";
  if (points >= 100) return "🥈";
  if (points >= 50) return "🥉";
  if (streak >= 10) return "🔥";
  if (streak >= 5) return "🌟";
  return "";
}
function htmlDecode(str) {
  return str.replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">");
}
function shuffle(a) {
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
  return a;
}
function prettyUsername(user) {
  return user.nickname || user.first_name || (user.username ? `@${user.username}` : "User");
}

// === USERS ===
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
      fastest: null,
      last_leveled: 0,
      groupStats: {},
      last_quiz_at: 0
    };
    db.data.users.push(user);
    await db.write();
    // Admin notification
    bot.sendMessage(
      ADMIN_ID, `👤 New user: ${prettyUsername(user)} (ID: ${user.id})\nTotal users: ${db.data.users.length}`
    );
  }
  return user;
}
async function updateUser(user) {
  let idx = db.data.users.findIndex(u => u.id === user.id);
  db.data.users[idx] = user;
  await db.write();
}

// === FETCH QUESTION ===
async function fetchQuestion() {
  const roll = Math.random();
  let url, category = "", catNoun;
  if (roll < 0.4) { url = "https://opentdb.com/api.php?amount=1&category=19&type=multiple"; category = "Math"; catNoun = '🧮'; }
  else if (roll < 0.8) { url = "https://opentdb.com/api.php?amount=1&category=17&type=multiple"; category = "Science"; catNoun = '🔬'; }
  else { url = "https://opentdb.com/api.php?amount=1&category=9&type=multiple"; category = "English"; catNoun = "🔤";}
  const { data } = await axios.get(url);
  const q = data.results[0];
  let answers = shuffle([...q.incorrect_answers.map(htmlDecode), htmlDecode(q.correct_answer)]);
  return {
    question: `${catNoun} <b>${htmlDecode(q.question)}</b>`,
    answers,
    correct: answers.indexOf(htmlDecode(q.correct_answer)),
    explanation: `The correct answer is: <b>${htmlDecode(q.correct_answer)}</b>.`,
    category,
    hint: "💡 Think of basic concepts or eliminate wrong options."
  };
}

// === MENUS ===
function mainMenu() {
  return (
`🤖 Welcome to Deb’s Quiz!
MCQs: Math, Science, English. Earn points, badges, and ranks!

🟦 Student:
/quiz – 🎯 Start quiz
/fight – ⚔️ Group battle
/leaderboard – 🏆 View leaderboard
/ranks – 🏅 Rank levels
/points – 💰 Show points, badge, level
/profile – 🧑‍💻 Profile, nickname, avatar
/daily – 🌞 Daily challenge
/challenge – 🤝 1v1 Challenge
/hint – 💡 Get a hint!
/answer – ℹ️ See answer/explanation
/achievements – 🏅 Badges
/stats – 📊 Progress

👑 Admin:
/broadcast – 📢 Send to all
/subs – 📊 Subscribers/list
/groups – 📚 Groups list
/groupstats – 📈 Group board
/users – 👥 Users list
/setadmin – ⚙️ Manage admins

✨ Fast (<30s): +2 pts! Level up for ranks! Check /ranks!
` );
}

// === SENDING QUIZ ===
async function sendQuiz(chatId, user, isGroup=false) {
  const quiz = await fetchQuestion();
  db.data.last_questions[`${chatId}:${user.id}`] = { ...quiz, time: Date.now(), isGroup, chatId };
  await db.write();

  bot.sendPoll(chatId,
    `🧠 Solve this!\n\n${quiz.question}`,
    quiz.answers,
    {
      type: "quiz",
      correct_option_id: quiz.correct,
      is_anonymous: false,
      explanation: "Pick your answer and boost your brain!"
    }
  );
}

// ==== COMMANDS ====

// /start
bot.onText(/^\/start/, async msg => {
  await getUser(msg);
  bot.sendMessage(msg.chat.id, mainMenu(), { parse_mode: "HTML" });
});

// /quiz
bot.onText(/^\/quiz/, async msg => {
  const user = await getUser(msg);
  sendQuiz(msg.chat.id, user, msg.chat.type.endsWith("group"));
});

// /fight
bot.onText(/^\/fight/, async msg => {
  if (!msg.chat.type.endsWith("group"))
    return bot.sendMessage(msg.chat.id, "This is for group battles only!");
  const user = await getUser(msg);
  sendQuiz(msg.chat.id, user, true);
});

// /points
bot.onText(/^\/points/, async msg => {
  const user = await getUser(msg);
  const badge = prettyBadge(user.points, user.streak);
  const rank = getRank(user.points);
  bot.sendMessage(msg.chat.id,
    `💰 <b>${prettyUsername(user)}</b>\nPoints: <b>${user.points}</b> ${badge}\nLevel: ${getLevel(user.points)}\nRank: ${rank.name}\nStreak: ${user.streak}`,
    { parse_mode: "HTML" });
});

// /profile, /setnick, /setavatar
bot.onText(/^\/profile/, async msg => {
  const user = await getUser(msg);
  bot.sendMessage(msg.chat.id,
    `🧑‍💻 <b>Your Profile</b>\nName: ${prettyUsername(user)}\nAvatar: ${(user.avatar || "👤")}\nLevel: ${getLevel(user.points)}\nRank: ${getRank(user.points).name}\nPoints: ${user.points}\nBadges: ${user.badges.join(", ") || "None"}\nTo set nickname: /setnick <your_nick>\nTo set avatar: /setavatar <emoji>`,
    { parse_mode: "HTML" });
});
bot.onText(/^\/setnick (.+)/, async (msg, match) => {
  const user = await getUser(msg);
  user.nickname = match[1].trim().substring(0, 20);
  await updateUser(user);
  bot.sendMessage(msg.chat.id, `✅ Nickname updated: ${user.nickname}`);
});
bot.onText(/^\/setavatar (.+)/, async (msg, match) => {
  const user = await getUser(msg);
  user.avatar = match[1].trim().substring(0, 2);
  await updateUser(user);
  bot.sendMessage(msg.chat.id, `✅ Avatar updated: ${user.avatar}`);
});

// /ranks
bot.onText(/^\/ranks/, msg => {
  let text = "🏅 <b>Ranks in Deb's Quiz:</b>\n\n" +
    rankTiers.map((r,i) => `${i+1}. <b>${r.name}</b> — <b>${r.pts} pts</b>`).join('\n') +
    "\n\nLevel up for better badges!";
  bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// /hint
bot.onText(/^\/hint/, async msg => {
  const user = await getUser(msg);
  const key = `${msg.chat.id}:${user.id}`;
  const last = db.data.last_questions[key];
  if (!last) return bot.sendMessage(msg.chat.id, "No quiz in progress. Use /quiz!");
  // Daily limit: 3
  db.data.hints[user.id] ||= { used: 0, lastReset: Date.now() };
  let hobj = db.data.hints[user.id];
  let now = new Date(), lastDay = new Date(hobj.lastReset);
  if (now.getUTCDate() !== lastDay.getUTCDate() || now.getUTCMonth() !== lastDay.getUTCMonth()) {
    hobj.used = 0; hobj.lastReset = Date.now();
  }
  if (hobj.used >= 3) return bot.sendMessage(msg.chat.id, "🚫 No more hints left today!");
  hobj.used++;
  await db.write();
  bot.sendMessage(msg.chat.id, last.hint);
});

// /answer (explanation)
bot.onText(/^\/answer/, async msg => {
  const user = await getUser(msg);
  const key = `${msg.chat.id}:${user.id}`;
  const last = db.data.last_questions[key];
  if (!last) return bot.sendMessage(msg.chat.id, "No previous quiz. Use /quiz!");
  bot.sendMessage(msg.chat.id, `ℹ️ ${last.explanation}`, { parse_mode: "HTML" });
});

// /leaderboard (global/group)
bot.onText(/^\/leaderboard/, async msg => {
  await db.read();
  let type = "global", arr;
  if (msg.chat.type.endsWith("group")) {
    type = "group";
    arr = db.data.users.filter(u => u.groupStats[msg.chat.id]);
    arr.sort((a, b) => (b.groupStats[msg.chat.id]?.points||0) - (a.groupStats[msg.chat.id]?.points||0));
  } else {
    arr = db.data.users.slice().sort((a, b) => b.points - a.points);
  }
  let text = `🏆 <b>Leaderboard (${type === "global" ? "Global" : "This Group"})</b>\n\n`;
  arr.slice(0, 10).forEach((u, i) => {
    let pts = (type === "group" ? (u.groupStats[msg.chat.id]?.points||0) : u.points);
    let rank = getRank(pts);
    let badge = prettyBadge(pts, u.streak);
    let level = getLevel(pts);
    text += `${i+1}. <b>${prettyUsername(u)}</b> ${u.avatar||""} — <b>${pts} pts</b> ${badge} [Lvl ${level}, ${rank.name}]\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// === /subs (ADMIN, FULLY READY) ===
bot.onText(/^\/subs/, async msg => {
  if (msg.from.id.toString() !== ADMIN_ID) return;
  await db.read();
  let text = `📊 Subscribers: <b>${db.data.users.length}</b>\n\n`;
  text += db.data.users.slice(0, 50).map((u,i) =>
            `${i+1}. <b>${prettyUsername(u)}</b> [<code>${u.id}</code>]`).join('\n');
  if (db.data.users.length > 50) text += "\n...and more.";
  bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// === /groups (ADMIN, FULLY READY) ===
bot.onText(/^\/groups/, async msg => {
  if (msg.from.id.toString() !== ADMIN_ID) return;
  await db.read();
  let groups = [];
  db.data.users.forEach(u => {
    if (u.groupStats) {
      for (let gid in u.groupStats) {
        if (!groups.some(g=>g.id==gid))
          groups.push({id: gid, count: 1});
        else
          groups.find(g=>g.id==gid).count++;
      }
    }
  });
  let text = "📚 Groups & user counts:\n\n" + groups.map(
    (g,i)=>`${i+1}. Group ID: <code>${g.id}</code> – users: ${g.count}`
    ).join('\n');
  if (!groups.length) text += "\nNo group stats yet.";
  bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// === /users (ADMIN, FULLY READY) ===
bot.onText(/^\/users/, async msg => {
  if (msg.from.id.toString() !== ADMIN_ID) return;
  await db.read();
  let text = "👥 Users:\n\n";
  text += db.data.users.slice(0, 50).map((u,i)=>
    `${i+1}. ${prettyUsername(u)} [${u.id}] pts:${u.points} lvl:${getLevel(u.points)}`
  ).join('\n');
  if (db.data.users.length > 50) text += `\n...and more (${db.data.users.length} total).`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// === /broadcast (ADMIN, FULLY READY) ===
bot.onText(/^\/broadcast/, async msg => {
  if (msg.from.id.toString() !== ADMIN_ID) return;
  bot.sendMessage(msg.chat.id, "Reply to this with your broadcast text or media.");
  bot.once('message', async bmsg => {
    await db.read();
    for (let user of db.data.users) {
      try {
        if (bmsg.text) await bot.sendMessage(user.id, bmsg.text);
        if (bmsg.photo) await bot.sendPhoto(user.id, bmsg.photo[bmsg.photo.length-1].file_id, {caption: bmsg.caption||""});
        if (bmsg.document) await bot.sendDocument(user.id, bmsg.document.file_id, {caption: bmsg.caption||""});
        if (bmsg.video) await bot.sendVideo(user.id, bmsg.video.file_id, {caption: bmsg.caption||""});
        if (bmsg.audio) await bot.sendAudio(user.id, bmsg.audio.file_id, {caption: bmsg.caption||""});
      } catch(e){}
    }
    bot.sendMessage(msg.chat.id, "✅ Broadcast sent!");
  });
});

// === POLL HANDLING: feedback, next quiz ===
bot.on('poll_answer', async answer => {
  await db.read();
  const user = db.data.users.find(u => u.id === answer.user.id);
  if (!user) return;
  const lastQKey = Object.keys(db.data.last_questions).find(k => k.endsWith(`:${user.id}`));
  const last = db.data.last_questions[lastQKey];
  if (!last) return;

  let now = Date.now();
  let bonus = 1, feedback = '';
  if (answer.option_ids.includes(last.correct)) {
    if ((now - last.time) < 30000) { bonus = 2; feedback = "🚀 Fast! +2 points!"; }
    else { feedback = "✅ Correct! +1 point!"; }
    user.points += bonus;
    user.streak++;
    let prevLevel = user.level;
    let currLevel = getLevel(user.points);
    user.level = currLevel;
    if (currLevel > prevLevel) {
      bot.sendMessage(user.id, `🎉 Level up! Welcome to Level ${currLevel} (${getRank(user.points).name})!`);
    }
    await updateUser(user);
    // NEXT QUIZ
    sendQuiz(last.chatId, user, !!last.isGroup);
  } else {
    user.streak = 0;
    await updateUser(user);
    bot.sendMessage(user.id,
      "❌ Wrong answer. Study and try again!\nWant to see the correct answer? Type /answer."
    );
    if (last.isGroup) sendQuiz(last.chatId, user, true);
  }
});

// === ADMIN: Notify on group join ===
bot.on('message', async msg => {
  if (msg.new_chat_members) {
    for (const m of msg.new_chat_members) {
      if (m.id === parseInt(bot.id)) {
        bot.sendMessage(ADMIN_ID, `🤖 Bot added to <b>${msg.chat.title}</b> (ID: ${msg.chat.id})`, {parse_mode:"HTML"});
      }
    }
  }
  await getUser(msg);
});

console.log("Deb's Quiz bot is running!");

