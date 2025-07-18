require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const path = require('path');

// === Initialization ===
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const db = new Low(new JSONFile(path.join(__dirname, 'db.json')));
const ADMIN_ID = process.env.ADMIN_ID;

(async () => {
  await db.read();
  db.data ||= { users: [], hints: {}, last_questions: {} }; // User stats only
  await db.write();
})();

// === Helper Functions & Emojis ===
const RANKS = [
  { name: "Rookie", points: 0, emoji: "⬜" },
  { name: "Explorer", points: 10, emoji: "🔹" },
  { name: "Mathlete", points: 25, emoji: "➗" },
  { name: "Science Star", points: 50, emoji: "🔬" },
  { name: "Quiz Master", points: 100, emoji: "🥈" },
  { name: "Prodigy", points: 200, emoji: "🥇" },
  { name: "Legend", points: 400, emoji: "🏆" }
];
const stripHtml = t => t?.replace(/&quot;/g, '"').replace(/&#039;/g,"'").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/<[^>]+>/g,"");
function shuffle(array) { for (let i=array.length-1;i>0;i--) { const j = Math.floor(Math.random() * (i+1)); [array[i], array[j]] = [array[j], array[i]]; } return array; }
const getRank = pts => RANKS.slice().reverse().find(r=>pts>=r.points);
const getLevel = pts => 1+Math.floor(pts/25);
const prettyBadge = (pts, streak=0) => pts >= 400 ? "🏆" : pts>=200 ? "🥇" : pts>=100 ? "🥈" : pts>=50 ? "🥉" : streak>=10 ? "🔥" : streak>=5 ? "🌟" : "";
const prettyUsername = (u, md=false) => md&&u.username ? `[${u.nickname||u.first_name||("@"+u.username)}](https://t.me/${u.username})` : (u.username?("@"+u.username):(u.nickname||u.first_name||"User"));

async function getUser(msg) {
  await db.read();
  let user = db.data.users.find(u=>u.id===msg.from.id);
  if (!user) {
    user={
      id:msg.from.id,username:msg.from.username||"",
      first_name:msg.from.first_name||"",nickname:"",avatar:"",
      points:0,streak:0,level:1,badges:[]
    };
    db.data.users.push(user);
    await db.write();
    if (ADMIN_ID&&ADMIN_ID!=user.id) {
      bot.sendMessage(
        ADMIN_ID,
        `🆕 👤 *New user joined*: ${prettyUsername(user,true)} (\`${user.id}\`)\n👥 Total users: ${db.data.users.length}`,
        { parse_mode:"Markdown" }
      );
    }
  }
  return user;
}
async function updateUser(u) {
  await db.read();
  db.data.users[db.data.users.findIndex(x=>x.id===u.id)]=u;
  await db.write();
}

// === Quiz Logic ===
async function fetchQuestion() {
  const url = [
    "https://opentdb.com/api.php?amount=1&category=19&type=multiple", // Math
    "https://opentdb.com/api.php?amount=1&category=17&type=multiple", // Science
    "https://opentdb.com/api.php?amount=1&category=9&type=multiple"   // English
  ][Math.floor(Math.random()*3)];
  const { data } = await axios.get(url);
  const q = data.results[0];
  const correct = stripHtml(q.correct_answer);
  const question = stripHtml(q.question);
  const answers = shuffle([...q.incorrect_answers.map(stripHtml), correct]);
  return {
    question: `🧠 *Solve This!*\n\n${question}`,
    answers, correct, correctIndex: answers.indexOf(correct),
    explanation: `✨ *The correct answer is:* _${correct}_\n💡 Use /quiz for more learning!`,
    hint: "💡 Think like a pro — try logic, eliminate, or recall concepts!"
  };
}
async function sendQuiz(chatId, user) {
  const quiz = await fetchQuestion();
  db.data.last_questions[`${chatId}:${user.id}`] = {
    ...quiz, time: Date.now(), chatId, answered: false, wrong: false
  };
  await db.write();
  bot.sendPoll(chatId, quiz.question, quiz.answers, {
    type:"quiz", correct_option_id:quiz.correctIndex, is_anonymous:false,
    explanation:"🎯 Fastest answers = more points! Use /hint if stuck."
  });
}

// === Menus & Commands ===

const startMenu = `
🤖 *Welcome to Deb’s Quiz!*

✨ *Join the ultimate MCQ challenge for Math, Science & English!*

🎮 *Main Commands:*
/quiz – 🧠 _Start a solo quiz_
/fight – ⚔️ _Quiz battle in group chats_
/leaderboard – 🏆 _See the current top 10_
/profile – 👤 _Your stats & profile_
/points – 💰 _View your points, badges, streak_
/ranks – 🏅 _See levels, ranks, and progress_
/daily – 🌞 _Play the daily MCQ_
/achievements – 🎖️ _See special badges_
/hint – 💡 _Get a hint (3/day)_
/answer – ℹ️ _Explanation after wrong answer_
/stats – 📊 _Your full stats history_

👑 *Admin Commands:*
/broadcast – 📢 _Send a global message_
/users – 👥 _User list_
/subs – 👥 _User/Subscriber count_

📣 *Speed bonus!* Fastest right answers = +2 points! Use /ranks to climb.
`;

bot.onText(/^\/start$/, async msg => {
  await getUser(msg);
  bot.sendMessage(msg.chat.id, startMenu, { parse_mode:"Markdown" });
});

bot.onText(/^\/quiz$/, async msg => {
  const user = await getUser(msg);
  await sendQuiz(msg.chat.id, user);
});

bot.onText(/^\/fight$/, async msg => {
  if (!msg.chat.type.endsWith("group"))
    return bot.sendMessage(msg.chat.id, "⚔️ That’s a group chat only command! Add me to a group.");
  const user = await getUser(msg);
  await sendQuiz(msg.chat.id, user);
});

bot.on('poll_answer', async answer => {
  await db.read();
  const user = db.data.users.find(u => u.id === answer.user.id);
  if (!user) return;
  const key = Object.keys(db.data.last_questions).find(k=>k.endsWith(":"+user.id));
  const last = db.data.last_questions[key];
  if (!last) return;
  const now = Date.now();
  last.answered = true;
  const chatId = last.chatId;
  if (answer.option_ids.includes(last.correctIndex)) {
    last.wrong = false;
    const bonus = (now-last.time<30000)?2:1;
    user.points += bonus;
    user.streak++;
    user.level = getLevel(user.points);
    await updateUser(user);
    bot.sendMessage(chatId, `✅ *Correct!* (+${bonus} pts)\n🔥 *Streak*: ${user.streak}`, { parse_mode:"Markdown" });
    await sendQuiz(chatId, user);
  } else {
    last.wrong = true;
    user.streak = 0;
    await updateUser(user);
    bot.sendMessage(chatId, `❌ *Wrong!* – use /answer for the explanation.`, { parse_mode:"Markdown" });
  }
  db.data.last_questions[key] = last;
  await db.write();
});

bot.onText(/^\/leaderboard$/, async msg => {
  await db.read();
  const topUsers = db.data.users.filter(u=>u.points>0).sort((a,b)=>b.points-a.points).slice(0,10);
  if (!topUsers.length) return bot.sendMessage(msg.chat.id, "🏆 No scores yet. Use /quiz to begin!");
  const medals = ['🥇','🥈','🥉','🎖️','🎖️','🎖️','🔹','🔹','🔹','🔹'];
  const text = topUsers.map((u,i) =>
    `${medals[i]||'🔸'} ${prettyUsername(u,true)} – ${u.points} pts`
  ).join('\n');
  bot.sendMessage(msg.chat.id, `🏆 *Top Players:*\n\n${text}`, { parse_mode:"Markdown" });
});

bot.onText(/^\/points$/, async msg => {
  const user = await getUser(msg);
  const text = [
    `💰 *Points*: ${user.points}`,
    `🏅 *Rank*: ${getRank(user.points).emoji} ${getRank(user.points).name} ${prettyBadge(user.points,user.streak)}`,
    `🌟 *Level*: ${getLevel(user.points)}`,
    `🔥 *Streak*: ${user.streak}`,
    "",
    `🎖️ *Badges*: ${user.badges.length ? user.badges.join(", ") : "None yet"}`
  ].join('\n');
  bot.sendMessage(msg.chat.id, text, { parse_mode:"Markdown" });
});

bot.onText(/^\/profile$/, async msg => {
  const user = await getUser(msg);
  const text = [
    "👤 *Your Profile*",
    "",
    `🆔 *Username*: ${prettyUsername(user,true)} ${user.avatar||""}`,
    `🏅 *Rank*: ${getRank(user.points).emoji} ${getRank(user.points).name} ${prettyBadge(user.points,user.streak)}`,
    `🌟 *Level*: ${getLevel(user.points)}`,
    `💰 *Points*: ${user.points}`,
    `🔥 *Streak*: ${user.streak}`,
    `🎖️ *Badges*: ${user.badges.length ? user.badges.join(", ") : "None yet"}`,
    "",
    "✏️ Change Nickname: /setnick <your_name>",
    "🎨 Change Avatar: /setavatar <emoji>",
    "",
    "🏆 Keep playing to earn more! Use /quiz to start!",
    "─────────────────────"
  ].join('\n');
  bot.sendMessage(msg.chat.id, text, { parse_mode:"Markdown" });
});

bot.onText(/^\/setnick (.+)$/, async (msg, match) => {
  let user = await getUser(msg);
  user.nickname = match[1].trim().substring(0, 20);
  await updateUser(user);
  bot.sendMessage(msg.chat.id, `✏️ Nickname changed to: *${user.nickname}* — visible in leaderboard & stats!`, { parse_mode:"Markdown" });
});
bot.onText(/^\/setavatar (.+)$/, async (msg, match) => {
  let user = await getUser(msg);
  user.avatar = match[1].trim().substring(0, 2);
  await updateUser(user);
  bot.sendMessage(msg.chat.id, `🎨 Avatar changed to: ${user.avatar} — will show on leaderboard!`);
});

bot.onText(/^\/ranks$/, msg => {
  const txt = ["🏅 *Ranks & Level System*\n"];
  RANKS.forEach(r=>txt.push(`${r.emoji} *${r.name}* — _${r.points} pts_`));
  txt.push("\n🌟 Earn badges and level up at every stage!");
  txt.push("─────────────");
  bot.sendMessage(msg.chat.id, txt.join('\n'), { parse_mode:"Markdown" });
});
bot.onText(/^\/hint$/, async msg => {
  let user = await getUser(msg);
  const key = msg.chat.id + ":" + user.id;
  await db.read();
  const lastQuiz = db.data.last_questions[key];
  if (!lastQuiz) return bot.sendMessage(msg.chat.id, "💡 No quiz active. Use /quiz first!");
  db.data.hints[user.id] ||= { used: 0, lastReset: Date.now() };
  let hintData = db.data.hints[user.id];
  const now = new Date(), lastReset = new Date(hintData.lastReset);
  if (now.toDateString() !== lastReset.toDateString()) { hintData.used = 0; hintData.lastReset = Date.now(); }
  if (hintData.used >= 3) return bot.sendMessage(msg.chat.id, "🚫 All 3 hints used today! Try again tomorrow.");
  hintData.used++;
  await db.write();
  bot.sendMessage(msg.chat.id, `💡 *Hint*: ${lastQuiz.hint}`, { parse_mode:"Markdown" });
});

bot.onText(/^\/achievements$/, async msg => {
  const user = await getUser(msg);
  bot.sendMessage(msg.chat.id, `🎖️ *Badges*: ${user.badges.length ? user.badges.join(", ") : "None yet"}\nSpecial: ${prettyBadge(user.points, user.streak)}`, { parse_mode:"Markdown" });
});
bot.onText(/^\/stats$/, async msg => {
  const user = await getUser(msg);
  const info = [
    "🌟 *Your Quiz Progress* 🌟",
    "",`👤 *Username*: ${prettyUsername(user, true)} ${user.avatar||""}`,
    `🏅 *Rank*: ${getRank(user.points).emoji} ${getRank(user.points).name} ${prettyBadge(user.points, user.streak)}`,
    `🌟 *Level*: ${getLevel(user.points)}`,
    `💰 *Points*: ${user.points}`,
    `🔥 *Streak*: ${user.streak}`,
    `🎖️ *Badges*: ${user.badges.length ? user.badges.join(", ") : "None yet"}`,
    "",
    "🎯 Tip: Play /daily for secret achievements!",
    "───────────────"
  ].join("\n");
  bot.sendMessage(msg.chat.id, info, { parse_mode:"Markdown" });
});
bot.onText(/^\/answer$/, async msg => {
  let user = await getUser(msg);
  const key = msg.chat.id + ":" + user.id;
  const lastQuiz = db.data.last_questions[key];
  if (!lastQuiz) return bot.sendMessage(msg.chat.id, "ℹ️ No recent quiz. Try /quiz!");
  if (!lastQuiz.answered) return bot.sendMessage(msg.chat.id, "🚦 Solve the MCQ first! /answer unlocks only if you got it wrong.");
  if (!lastQuiz.wrong) return bot.sendMessage(msg.chat.id, "✅ You answered that correctly! Try another /quiz!");
  bot.sendMessage(msg.chat.id, lastQuiz.explanation, { parse_mode:"Markdown" });
});
bot.onText(/^\/daily$/, async msg => {
  let user = await getUser(msg);
  bot.sendMessage(msg.chat.id,"🌞 *Daily Challenge:*\nReady for your best?",{parse_mode:"Markdown"});
  await sendQuiz(msg.chat.id,user);
});
bot.onText(/^\/challenge$/, async msg => {
  bot.sendMessage(msg.chat.id, "🤝 1v1 challenge mode coming soon! For now, try a single /quiz.");
});

// === Admin Commands ===
bot.onText(/^\/broadcast (.+)$/i, async (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID))
    return bot.sendMessage(msg.chat.id, "🚫 Only admin can broadcast.");
  const txt = match[1];
  await db.read();
  let sent=0,failed=0;
  for (const user of db.data.users) {
    try { await bot.sendMessage(user.id, `📢 *Announcement:*\n${txt}`, {parse_mode:"Markdown"}); sent++; }
    catch { failed++; }
  }
  bot.sendMessage(msg.chat.id, `✅ Broadcast sent!\n📬 Delivered: *${sent}*\n❌ Failed: *${failed}*`, {parse_mode:"Markdown"});
});
bot.onText(/^\/subs$/, async msg => {
  if (String(msg.from.id)!==String(ADMIN_ID)) return;
  await db.read();
  bot.sendMessage(msg.chat.id, `👥 *Subscribers*: ${db.data.users.length}`, {parse_mode:"Markdown"});
});
bot.onText(/^\/users$/, async msg => {
  if (String(msg.from.id)!==String(ADMIN_ID)) return;
  await db.read();
  let text = "👥 *Users:*\n";
  text += db.data.users.slice(0,50).map((u,i) => {
    const clickable = prettyUsername(u,true);
    return `${i+1}. ${clickable} [${u.id}] points: ${u.points}`;
  }).join('\n');
  if (db.data.users.length>50) text += `\n...and more (${db.data.users.length} total).`;
  bot.sendMessage(msg.chat.id, text, {parse_mode:"Markdown"});
});

console.log("✅ Deb’s Quiz Bot is running, emoji-rich and professional!");
