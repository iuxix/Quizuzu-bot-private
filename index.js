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
  return t?.replace(/&quot;/g, '"').replace(/&#039;/g,"'").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/<[^>]+>/g,"");
}
function shuffle(array) {
  for (let i=array.length-1;i>0;i--) {
    const j=Math.floor(Math.random()*(i+1));
    [array[i],array[j]]=[array[j],array[i]];
  }
  return array;
}
const getRank = pts => RANKS.slice().reverse().find(r => pts >= r.points);
const getLevel = pts => 1 + Math.floor(pts / 25);
const prettyBadge = (pts, streak=0) => pts>=400?"🏆":pts>=200?"🥇":pts>=100?"🥈":pts>=50?"🥉":streak>=10?"🔥":streak>=5?"🌟":"";
const prettyUsername = (u, md=false) => {
  const name = u.nickname || u.first_name || u.username || "User";
  return (md && u.username) ? `[${name}](https://t.me/${u.username})` : name;
};

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
      badges: []
    };
    db.data.users.push(user);
    await db.write();
    if (ADMIN_ID && String(ADMIN_ID) !== String(user.id))
      bot.sendMessage(ADMIN_ID, `🆕 *New user:* ${prettyUsername(user,true)} \`${user.id}\`\n👥 Total: ${db.data.users.length}`, { parse_mode: "Markdown" });
  }
  return user;
}
async function updateUser(u) {
  await db.read();
  const i = db.data.users.findIndex(x => x.id === u.id);
  if (i !== -1) db.data.users[i] = u;
  await db.write();
}
async function fetchQuiz() {
  const { data } = await axios.get("https://opentdb.com/api.php?amount=1&category=19&type=multiple");
  const q = data.results[0];
  const correct = stripHtml(q.correct_answer);
  const answers = shuffle([...q.incorrect_answers.map(stripHtml), correct]);
  return {
    question: `Solve This 🧠!\n\n${stripHtml(q.question)}`,
    answers,
    correct,
    correctIndex: answers.indexOf(correct),
    explanation: `✨ *Correct answer:* _${correct}_`,
    hint: "💡 Try logic, elimination, and reasoning!"
  };
}
async function sendQuiz(chatId, user, isGroup=false) {
  const quiz = await fetchQuiz();
  db.data.last_questions[`${chatId}:${user.id}`] = {
    ...quiz, time: Date.now(), chatId, userId: user.id, answered: false, isGroup
  };
  await db.write();
  await bot.sendPoll(chatId, quiz.question, quiz.answers, {
    type: "quiz", correct_option_id: quiz.correctIndex, is_anonymous: false,
    explanation: "🎯 Answer fast for bonus. Use /hint if stuck."
  });
}

// === START MENU ===
const startMenu = `
🤖 *Welcome to Deb’s Quiz!*

✨ _The ultimate MCQ challenge for Math!_

🎮 *Main Commands:*

/quiz – 🧠 _Start a quiz_
/fight – ⚔️ _Group quiz battle_
/leaderboard – 🏆 _Group top 10_
/profile – 👤 _View & personalize your stats_
/setnick <name> – ✏️ _Custom nickname_
/setavatar <emoji> – 🎨 _Set profile emoji_
/points – 💰 _Your coins, streak, badges_
/daily – 🌞 _Today's challenge_
/achievements – 🏅 _Your badges_
/hint – 💡 _Get a hint (3/day)_
/answer – ℹ️ _Get the explanation_
/ranks – 🏅 _Rank system_
/stats – 📊 _Your full progress_

👑 *Admin:*
/broadcast – 📢 _Send message/media to all_
/users – 👥 _See all users_
/subs – 👥 _Total subscriber count_

📣 _Fastest answers earn +2 points!_
`;

bot.onText(/^\/start$/, async msg => {
  await getUser(msg);
  bot.sendMessage(msg.chat.id, startMenu, { parse_mode: "Markdown" });
});

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

bot.on('poll_answer', async answer => {
  await db.read();
  const user = db.data.users.find(u => u.id === answer.user.id);
  if (!user) return;
  const entryKey = Object.keys(db.data.last_questions).find(k => k.endsWith(":"+user.id));
  if (!entryKey) return;
  const last = db.data.last_questions[entryKey];
  if (!last || last.answered) return;
  last.answered = true;

  const chatId = msg.chat.id;
  const now = Date.now();
  let bonus = 1;
  if (answer.option_ids.includes(last.correctIndex)) {
    bonus = (now - last.time < 30000) ? 2 : 1;
    user.points += bonus;
    user.streak++;
    user.level = getLevel(user.points);
    await updateUser(user);
    bot.sendMessage(chatId, `✅ *Correct!* (+${bonus}) – ${prettyUsername(user,true)}\n🔥 *Streak:* ${user.streak}`, { parse_mode: "Markdown" });
    setTimeout(() => sendQuiz(chatId, user, last.isGroup), 900);
  } else {
    user.streak = 0;
    await updateUser(user);
    last.wrong = true;
    bot.sendMessage(chatId, `❌ *Wrong!* – ${prettyUsername(user,true)}\nTry /answer for explanation.`, { parse_mode: "Markdown" });
  }
  db.data.last_questions[entryKey] = last;
  await db.write();
});

// === All Other Commands: profile, leaderboard, users etc.
bot.onText(/^\/profile$/, async msg => {
  const u = await getUser(msg);
  const text = `
👤 *Profile*
🆔 ${prettyUsername(u, true)} ${u.avatar || ''}
🏅 ${getRank(u.points).emoji} ${getRank(u.points).name}
💰 Points: ${u.points}
🔥 Streak: ${u.streak}
🌟 Level: ${getLevel(u.points)}
🎖️ Badges: ${u.badges.length ? u.badges.join(", ") : "None yet"}
`.trim();
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});
bot.onText(/^\/setnick (.+)$/i, async (msg, m) => {
  const u = await getUser(msg);
  u.nickname = m[1].slice(0, 30);
  await updateUser(u);
  bot.sendMessage(msg.chat.id, `✅ Nickname set to *${u.nickname}*`, { parse_mode:"Markdown" });
});
bot.onText(/^\/setavatar (.+)$/i, async (msg, m) => {
  const u = await getUser(msg);
  u.avatar = m[1].slice(0, 2);
  await updateUser(u);
  bot.sendMessage(msg.chat.id, `🎨 Avatar set to ${u.avatar}`);
});

bot.onText(/^\/points$/, async msg => {
  const user = await getUser(msg);
  bot.sendMessage(msg.chat.id, `
💰 *Your Points*
Rank: ${getRank(user.points).emoji} ${getRank(user.points).name}
Level: ${getLevel(user.points)}
Points: ${user.points}
Streak: ${user.streak}
`, { parse_mode: "Markdown" });
});

bot.onText(/^\/leaderboard$/, async msg => {
  if (!msg.chat.type.endsWith("group"))
    return bot.sendMessage(msg.chat.id, "🏆 *Leaderboard works only in groups!*", { parse_mode:"Markdown" });
  await db.read();
  const top = db.data.users.filter(u=>u.points>0).sort((a,b)=>b.points-a.points).slice(0, 10);
  if (!top.length) return bot.sendMessage(msg.chat.id, "No scores. Start with /quiz");

  const list = top.map((u, i) =>
    `${i+1}. ${prettyUsername(u,true)}\n${u.avatar || ''} Rank: ${getRank(u.points).emoji} ${getRank(u.points).name}\nPoints: ${u.points}`
  ).join('\n\n');
  bot.sendMessage(msg.chat.id, `🏆 *Top in Group:*\n\n${list}`, { parse_mode: 'Markdown' });
});

bot.onText(/^\/answer$/, async msg => {
  const u = await getUser(msg);
  const key = msg.chat.id + ":" + u.id;
  const last = db.data.last_questions[key];
  if (!last) return bot.sendMessage(msg.chat.id, "ℹ️ No quiz to explain. Try /quiz.");
  if (!last.answered) return bot.sendMessage(msg.chat.id, "🕐 First answer it.");
  if (!last.wrong) return bot.sendMessage(msg.chat.id, "✅ You were right. Try /quiz again!");
  bot.sendMessage(msg.chat.id, last.explanation, { parse_mode: "Markdown" });
});

bot.onText(/^\/hint$/, async msg => {
  const u = await getUser(msg);
  const key = msg.chat.id + ":" + u.id;
  const last = db.data.last_questions[key];
  if (!last) return bot.sendMessage(msg.chat.id, "ℹ️ No quiz to hint. Use /quiz first!");

  db.data.hints[u.id] ||= { used: 0, lastReset: Date.now() };
  let hintRef = db.data.hints[u.id];
  const now = new Date();
  const lastReset = new Date(hintRef.lastReset);
  if (now.toDateString() !== lastReset.toDateString()) {
    hintRef.used = 0;
    hintRef.lastReset = Date.now();
  }
  if (hintRef.used >= 3) return bot.sendMessage(msg.chat.id, "🚫 All 3 hints used today!");
  hintRef.used++;
  await db.write();
  bot.sendMessage(msg.chat.id, `💡 *Hint*: ${last.hint}`, { parse_mode: "Markdown" });
});

bot.onText(/^\/subs$/, async msg => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  await db.read();
  bot.sendMessage(msg.chat.id, `👥 Total Subscribers: ${db.data.users.length}`);
});
bot.onText(/^\/users$/, async msg => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  await db.read();
  const text = db.data.users.map((u,i)=>`${i+1}. ${prettyUsername(u,true)} – ${u.points} pts`).join('\n');
  bot.sendMessage(msg.chat.id, `👥 *Users List:*\n\n${text}`, { parse_mode: "Markdown" });
});
bot.onText(/^\/broadcast$/, msg => {
  if (String(msg.from.id)!==String(ADMIN_ID)) return;
  bot.sendMessage(msg.chat.id, "📨 *Send me any message or media to broadcast.*", { parse_mode: "Markdown" });
  broadcastWaiters.add(msg.from.id);
});

bot.on('message', async msg => {
  if (!broadcastWaiters.has(msg.from.id) || String(msg.from.id)!==String(ADMIN_ID)) return;
  await db.read();
  broadcastWaiters.delete(msg.from.id);
  let sent = 0, failed = 0;
  for (const user of db.data.users) {
    try {
      if (msg.text) await bot.sendMessage(user.id, msg.text);
      else if (msg.photo) await bot.sendPhoto(user.id, msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption || "" });
      else if (msg.video) await bot.sendVideo(user.id, msg.video.file_id, { caption: msg.caption || "" });
      else if (msg.document) await bot.sendDocument(user.id, msg.document.file_id, { caption: msg.caption || "" });
      else if (msg.audio) await bot.sendAudio(user.id, msg.audio.file_id, { caption: msg.caption || "" });
      else if (msg.voice) await bot.sendVoice(user.id, msg.voice.file_id, { caption: msg.caption || "" });
      else if (msg.sticker) await bot.sendSticker(user.id, msg.sticker.file_id);
      sent++;
    } catch { failed++; }
  }
  bot.sendMessage(msg.chat.id, `✅ Broadcast done!\n📬 Sent: ${sent}\n❌ Failed: ${failed}`);
});

console.log("✅ Deb’s Quiz Bot is live. Ready to rule math with full leaderboard, polls, battles, and fun!");
