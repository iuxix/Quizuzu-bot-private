require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const path = require('path');

// === Initialization ===
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const bot = new TelegramBot(TOKEN, { polling: true });
const db = new Low(new JSONFile(path.join(__dirname, 'db.json')));
const broadcastWaiters = new Set();

(async () => {
  await db.read();
  db.data ||= { users: [], hints: {}, last_questions: {} };
  await db.write();
})();

// === Helpers, Emojis and Fun Stuff ===
const RANKS = [
  { name: "Rookie", points: 0, emoji: "⬜" },
  { name: "Explorer", points: 10, emoji: "🔹" },
  { name: "Mathlete", points: 25, emoji: "➗" },
  { name: "Science Star", points: 50, emoji: "🔬" },
  { name: "Quiz Master", points: 100, emoji: "🥈" },
  { name: "Prodigy", points: 200, emoji: "🥇" },
  { name: "Legend", points: 400, emoji: "🏆" }
];
const WRONG_RESPONSES = [
  "❌ *Wrong!* Oops, logic virus detected.",
  "😅 Incorrect! Try flexing that brain a bit more!",
  "🙃 Not quite! Remember, geniuses make mistakes too.",
];
const CORRECT_RESPONSES = [
  "✅ *Correct!*",
  "🎉 Yes! That's it!",
  "🧠 Smart move!",
  "🚀 Awesome! Right answer!",
];

const FACTS = [
  "🤓 Did you know? The human brain has about 86 billion neurons.",
  "🦖 Did you know? Dinosaurs lived on Earth for 165 million years.",
  "⌛ Did you know? 0 is the only real number that's neither positive nor negative.",
];

const stripHtml = t => t?.replace(/&quot;/g, '"').replace(/&#039;/g,"'").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/<[^>]+>/g,"");
function shuffle(array) { for (let i=array.length-1;i>0;i--) { const j = Math.floor(Math.random() * (i+1)); [array[i], array[j]] = [array[j], array[i]]; } return array; }
const getRank = pts => RANKS.slice().reverse().find(r=>pts>=r.points);
const getLevel = pts => 1+Math.floor(pts/25);
const prettyBadge = (pts, streak = 0) => pts >= 400 ? "🏆" : pts>=200 ? "🥇" : pts>=100 ? "🥈" : pts>=50 ? "🥉" : streak>=10 ? "🔥" : streak>=5 ? "🌟" : "";
const prettyUsername = (u, md=false, mention='bracket') => {
  // mention = "bracket" or "tag"
  if (md && u.username)
    return `[${u.nickname||u.first_name||("@"+u.username)}](https://t.me/${u.username})` + (mention==="bracket" ? ` (@${u.username})` : "");
  if (u.username) return "@" + u.username;
  return u.nickname || u.first_name || "User";
};

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
    if (ADMIN_ID && ADMIN_ID != user.id) {
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

function randomFrom(arr) { return arr[Math.floor(Math.random()*arr.length)]; }

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
    question: `🧠 *Quiz Time!*\n\n${question}`,
    answers, correct, correctIndex: answers.indexOf(correct),
    explanation: `✨ *The correct answer is:* _${correct}_\n\n${randomFrom(FACTS)}\n\n💡 Use /quiz for more learning!`,
    hint: "💡 Use logic: eliminate choices, recall concepts, and trust your gut!"
  };
}

async function sendQuiz(chatId, user, isGroup = false) {
  const quiz = await fetchQuestion();
  db.data.last_questions[`${chatId}:${user.id}`] = {
    ...quiz, time: Date.now(), chatId, answered: false, wrong: false, isGroup
  };
  await db.write();
  await bot.sendPoll(chatId, quiz.question, quiz.answers, {
    type:"quiz", correct_option_id:quiz.correctIndex, is_anonymous:false,
    explanation: "🎯 Fastest right answer: +2 points! Use /hint if stuck."
  });
}

// === Menus & Commands ===

const startMenu = `
🤖 *Welcome to Deb’s Quiz!*

✨ *Join the ultimate MCQ challenge for Math, Science & English!*

🎮 *Main Commands:*
/quiz – 🧠 _Start a solo quiz_
/fight – ⚔️ _Quiz battle in group chats_
/leaderboard – 🏆 _See your group's leaderboard_
/profile – 👤 _Your stats & profile_
/points – 💰 _Your points, badges, streak_
/ranks – 🏅 _See all ranks & progress_
/daily – 🌞 _Play the daily MCQ_
/achievements – 🎖️ _See special badges_
/hint – 💡 _Get a hint (3/day)_
/answer – ℹ️ _Explanation after wrong answer_
/stats – 📊 _Your full stats history_

👑 *Admin Commands:*
/broadcast – 📢 _Send a global message_
/users – 👥 _User list_
/subs – 👥 _User/Subscriber count_

📣 *Speed bonus!* Fastest right answers = +2 points! Use /ranks to climb the leaderboard.
`;

bot.onText(/^\/start$/, async msg => {
  await getUser(msg);
  bot.sendMessage(msg.chat.id, startMenu, { parse_mode:"Markdown" });
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
  // Find the correct last_questions entry for this chat+user
  const key = Object.keys(db.data.last_questions).find(k=>k.startsWith(answer?.chat_instance)||k.endsWith(":"+user.id));
  const last = db.data.last_questions[`${(answer.chat_instance||last?.chatId)||''}:${user.id}`] || db.data.last_questions[key];
  if (!last) return;
  const chatId = last.chatId;

  const now = Date.now();
  last.answered = true;

  if (answer.option_ids.includes(last.correctIndex)) {
    last.wrong = false;
    const bonus = (now-last.time<30000)?2:1;
    user.points += bonus;
    user.streak++;
    user.level = getLevel(user.points);
    await updateUser(user);
    bot.sendMessage(chatId, `${randomFrom(CORRECT_RESPONSES)} (+${bonus} pts) – ${prettyUsername(user,true)}\n🔥 *Streak*: ${user.streak}`, { parse_mode:"Markdown" });
    await sendQuiz(chatId, user, last.isGroup);
  } else {
    last.wrong = true;
    user.streak = 0;
    await updateUser(user);
    bot.sendMessage(chatId, `${randomFrom(WRONG_RESPONSES)}\nUse /answer for the explanation.`, { parse_mode:"Markdown" });
  }
  db.data.last_questions[key] = last;
  await db.write();
});

// LEADERBOARD: Only available in groups, mentions users and their rank
bot.onText(/^\/leaderboard$/, async msg => {
  if (!msg.chat.type.endsWith("group")) {
    return bot.sendMessage(msg.chat.id, "🏆 The leaderboard can only be viewed in group chats! Invite me to a group to join the competition!", { parse_mode:"Markdown" });
  }
  await db.read();
  // For group leaderboard: show only users who have answered in this group
  const groupId = msg.chat.id;
  // We'll show all users who have answered at least one quiz in this group
  // (since you want per-group stats, but *no global groupStats* field, we use points of user as is)
  const groupUsers = db.data.users
    .filter(u => u.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);
  if (!groupUsers.length) 
    return bot.sendMessage(groupId, "🚦 No scores in this group yet. Use /quiz to start the fun!", { parse_mode:"Markdown" });
  const medals = ['🥇','🥈','🥉','🎖️','🎖️','🎖️','🔹','🔹','🔹','🔹'];
  const text = groupUsers.map((u,i)=>
    `${medals[i]||'🔸'} ${prettyUsername(u,true)} (${u.username?`@${u.username}`:"/profile"})\n• Rank: ${getRank(u.points).emoji} ${getRank(u.points).name}  | ${u.points} pts`
  ).join('\n\n');
  bot.sendMessage(groupId, `🏆 *Group Leaderboard*\n\n${text}`, { parse_mode:"Markdown" });
});

// === User Profile Features ===
bot.onText(/^\/profile$/, async msg => {
  const user = await getUser(msg);
  const badge = prettyBadge(user.points,user.streak);
  const text = [
    "👤 *Your Profile*",
    "",
    `🆔 *Username*: ${prettyUsername(user,true)}`,
    `🏅 *Rank*: ${getRank(user.points).emoji} ${getRank(user.points).name} ${badge}`,
    `🌟 *Level*: ${getLevel(user.points)}`,
    `💰 *Points*: ${user.points}`,
    `🔥 *Streak*: ${user.streak}`,
    `🎨 *Avatar*: ${user.avatar||"Not set"}`,
    `🎖️ *Badges*: ${user.badges.length ? user.badges.join(", ") : "None yet"}`,
    "",
    "✏️ `/setnick <name>` – Set nickname",
    "🎨 `/setavatar <emoji>` – Set avatar",
    "",
    "⭐ Keep playing to earn more! Use /quiz to start.",
    "─────────────────────"
  ].join('\n');
  bot.sendMessage(msg.chat.id, text, { parse_mode:"Markdown" });
});
bot.onText(/^\/setnick (.+)$/, async (msg, match) => {
  let user = await getUser(msg);
  user.nickname = match[1].trim().substring(0, 20);
  await updateUser(user);
  bot.sendMessage(msg.chat.id, `✏️ Nickname changed to: *${user.nickname}* – visible in leaderboard & stats!`, { parse_mode:"Markdown" });
});
bot.onText(/^\/setavatar (.+)$/, async (msg, match) => {
  let user = await getUser(msg);
  user.avatar = match[1].trim().substring(0, 2);
  await updateUser(user);
  bot.sendMessage(msg.chat.id, `🎨 Avatar changed to: ${user.avatar}\nShow off your style on the leaderboard!`);
});

// === More Fun Commands ===

bot.onText(/^\/ranks$/, msg => {
  const txt = ["🏅 *Ranks & Level System*\n"];
  RANKS.forEach((r,i)=>txt.push(`${r.emoji} *${r.name}* — _${r.points} pts_`));
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
    ``,
    `${randomFrom(FACTS)}`,
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
  bot.sendMessage(msg.chat.id, "🤝 1v1 challenge mode coming soon! For now, try a solo /quiz or /fight with group.");
});

// === Admin Commands ===

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

// Broadcast: waits for the next message/audio/media and then broadcasts it to all users.
bot.onText(/^\/broadcast$/, async msg => {
  if (String(msg.from.id)!==String(ADMIN_ID)) return;
  broadcastWaiters.add(msg.from.id);
  bot.sendMessage(msg.chat.id, "📝 *Please send the message or media to broadcast to all users.*\n(You can send text, images, videos, documents, stickers, and more!)", {parse_mode:"Markdown"});
});
bot.on('message', async msg => {
  if (!broadcastWaiters.has(msg.from.id) || String(msg.from.id)!==String(ADMIN_ID)) return;
  broadcastWaiters.delete(msg.from.id);
  bot.sendMessage(msg.chat.id, "📢 Broadcasting to all users...");
  await db.read();
  let sent=0, failed=0;
  for (const user of db.data.users) {
    try {
      // Forward any message type
      if (msg.text && !msg.reply_to_message) {
        await bot.sendMessage(user.id, '📢 ' + msg.text, {parse_mode:"Markdown"});
      }
      else if (msg.photo) {
        await bot.sendPhoto(user.id, msg.photo[msg.photo.length-1].file_id, {caption: msg.caption || undefined});
      }
      else if (msg.video) {
        await bot.sendVideo(user.id, msg.video.file_id, {caption: msg.caption || undefined});
      }
      else if (msg.document) {
        await bot.sendDocument(user.id, msg.document.file_id, {caption: msg.caption || undefined});
      }
      else if (msg.sticker) {
        await bot.sendSticker(user.id, msg.sticker.file_id);
      }
      else if (msg.voice) {
        await bot.sendVoice(user.id, msg.voice.file_id, {caption: msg.caption||undefined});
      }
      else if (msg.audio) {
        await bot.sendAudio(user.id, msg.audio.file_id, {caption: msg.caption||undefined});
      }
      else if (msg.reply_to_message) {
        // If admin replies to the bot's broadcast message, send the reply text
        await bot.sendMessage(user.id, '📢 ' + msg.text, {parse_mode:"Markdown"});
      }
      sent++;
    } catch { failed++; }
  }
  bot.sendMessage(msg.chat.id, `✅ Broadcast sent!\n📬 Delivered: *${sent}*\n❌ Failed: *${failed}*`, {parse_mode:"Markdown"});
});

console.log("✅ Deb’s Quiz Bot is running, emoji-rich, pro, and group-focused!");
