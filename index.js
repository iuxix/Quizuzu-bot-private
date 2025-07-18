require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const path = require('path');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const ADMIN_ID = process.env.ADMIN_ID;
const GROUP_ID = -1002283571682; // @NextEra_Chat group
const GROUP_MENTION = '@NextEra_Chat';
const db = new Low(new JSONFile(path.join(__dirname, 'db.json')));
const broadcastWaiters = new Set();

(async () => {
  await db.read();
  db.data ||= { users: [], groupPoints: {}, groupStreak: {}, groupBadges: {}, hints: {}, last_questions: {} };
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
function getRank(points) { return RANKS.slice().reverse().find(r => points >= r.points); }
function getLevel(points) { return 1 + Math.floor(points / 25); }
function prettyBadge(pts, streak = 0) {
  if (pts >= 400) return "🏆";
  if (pts >= 200) return "🥇";
  if (pts >= 100) return "🥈";
  if (pts >= 50) return "🥉";
  if (streak >= 10) return "🔥";
  if (streak >= 5) return "🌟";
  return "";
}
function stripHtml(str) {
  return str?.replace(/&quot;/g, '"')
             .replace(/&#039;/g,"'")
             .replace(/&amp;/g,"&")
             .replace(/&lt;/g,"<")
             .replace(/&gt;/g,">")
             .replace(/<[^>]*>/g, '') || '';
}
function prettyUsername(u, md=false) {
  const name = u.nickname || u.first_name || u.username || "User";
  if(md && u.username) return `[${name}](https://t.me/${u.username})`;
  return u.username ? '@'+u.username : name;
}
function shuffle(array) {
  for (let i=array.length-1;i>0;i--) {
    const j=Math.floor(Math.random()*(i+1));
    [array[i],array[j]]=[array[j],array[i]];
  }
  return array;
}
function getGroupPoints(userId) { return db.data.groupPoints[userId] || 0; }
function setGroupPoints(userId, pts) { db.data.groupPoints[userId] = pts; }
function getGroupStreak(userId) { return db.data.groupStreak[userId] || 0; }
function setGroupStreak(userId, streak) { db.data.groupStreak[userId] = streak; }
function getGroupBadges(userId) { return db.data.groupBadges[userId] || []; }
function setGroupBadges(userId, badges) { db.data.groupBadges[userId] = badges; }

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
    if (ADMIN_ID && String(ADMIN_ID) !== String(user.id))
      bot.sendMessage(ADMIN_ID,`🆕 *New user:* ${prettyUsername(user,true)} (\`${user.id}\`)\n👥 Total: ${db.data.users.length}`,{ parse_mode: "Markdown" });
  }
  return user;
}
async function updateUser(u) {
  await db.read();
  const i = db.data.users.findIndex(x => x.id === u.id);
  if (i !== -1) db.data.users[i] = u;
  await db.write();
}
function rejectOtherGroups(msg) {
  if (msg.chat.id !== GROUP_ID) {
    bot.sendMessage(msg.chat.id, `❌ Deb's Quiz only works in ${GROUP_MENTION}.`);
    return true;
  }
  return false;
}
async function fetchQuiz() {
  const url = 'https://opentdb.com/api.php?amount=1&type=multiple&category=19&difficulty=easy';
  const { data } = await axios.get(url);
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

// ---- Start Menu ----
const startMenu = `
🤖 *Welcome to Deb’s Quiz!*

✨ _The ultimate MCQ challenge for Math!_

🎮 *Main Commands:*

/quiz – 🧠 _Start a quiz_
/fight – ⚔️ _Group quiz battle_
/leaderboard – 🏆 _Group top_
/profile – 👤 _Your stats & edit_
/setnick <name> – ✏️ _Nickname_
/setavatar <emoji> – 🎨 _Avatar_
/points – 💰 _Your coins, badges, streak_
/daily – 🌞 _Today's challenge_
/achievements – 🏅 _Your badges_
/hint – 💡 _Get a hint (3/day)_
/answer – ℹ️ _Get explanation_
/ranks – 🏅 _Rank system_
/stats – 📊 _Full progress_

👑 *Admin:*
/broadcast – 📢 _Admin message_
/users – 👥 _All users_
/subs – 👥 _Subscriber count_

📣 _Fastest answers earn +2 points!_
`;

bot.onText(/^\/start$/, async msg => {
  await getUser(msg);
  bot.sendMessage(msg.chat.id, startMenu, { parse_mode: "Markdown" });
});
bot.onText(/^\/quiz$/, async msg => {
  const user = await getUser(msg);
  if (msg.chat.type.endsWith("group")) { if (rejectOtherGroups(msg)) return; await sendGroupQuiz(msg, user);
  } else { await sendPrivateQuiz(msg, user); }
});
bot.onText(/^\/fight$/, async msg => {
  if (!msg.chat.type.endsWith("group")) return bot.sendMessage(msg.chat.id, "⚔️ Use /fight in a group!");
  if (rejectOtherGroups(msg)) return;
  const user = await getUser(msg); await sendGroupQuiz(msg, user);
});
async function sendPrivateQuiz(msg, user) {
  const quiz = await fetchQuiz();
  db.data.last_questions[`${msg.chat.id}:${user.id}`] = {
    ...quiz, time: Date.now(), chatId: msg.chat.id, userId: user.id, answered: false, isGroup: false
  };
  await db.write();
  await bot.sendPoll(msg.chat.id, quiz.question, quiz.answers, {
    type: "quiz", correct_option_id: quiz.correctIndex, is_anonymous: false,
    explanation: "🎯 Answer fast for bonus. Use /hint if stuck."
  });
}
async function sendGroupQuiz(msg, user) {
  const quiz = await fetchQuiz();
  db.data.last_questions[`${msg.chat.id}:${user.id}`] = {
    ...quiz, time: Date.now(), chatId: msg.chat.id, userId: user.id, answered: false, isGroup: true
  };
  await db.write();
  await bot.sendPoll(msg.chat.id, quiz.question, quiz.answers, {
    type: "quiz", correct_option_id: quiz.correctIndex, is_anonymous: false,
    explanation: "🎯 Fast answer: +2 pts! Use /hint if stuck."
  });
}

// --- POLL ANSWER HANDLER WITH DEBUG MESSAGE TO GROUP! ---
bot.on('poll_answer', async answer => {
  await db.read();
  // DEBUG: show poll_answer in main group and log
  if (answer.user) {
    bot.sendMessage(GROUP_ID,
      `🐞 [DEBUG] poll_answer received!\nUser: ${answer.user.first_name||answer.user.username||answer.user.id}\nOption: [${answer.option_ids}]\nPoll ID: ${answer.poll_id}`
    );
  }
  const user = db.data.users.find(u => u.id === answer.user.id);
  if (!user) return;
  const keys = Object.keys(db.data.last_questions);
  let entryKey = keys.find(k => k.endsWith(":" + user.id) && !db.data.last_questions[k].answered);
  if (!entryKey) return;
  const last = db.data.last_questions[entryKey];
  last.answered = true;
  const chatId = last.chatId;
  const now = Date.now();
  const correct = answer.option_ids.includes(last.correctIndex);
  if (last.isGroup && chatId !== GROUP_ID) return;
  if (!last.isGroup) {
    let bonus = correct && ((now - last.time) < 30000) ? 2 : 1;
    if (correct) {
      user.points += bonus; user.streak++; user.level = getLevel(user.points); await updateUser(user);
      bot.sendMessage(chatId, `✅ *Correct!* (+${bonus} pts)\n${prettyUsername(user, true)}\n🔥 *Streak:* ${user.streak}`, { parse_mode: "Markdown" });
      setTimeout(() => sendPrivateQuiz({chat:{id:chatId}}, user), 1000);
    } else {
      user.streak = 0; await updateUser(user); last.wrong = true;
      bot.sendMessage(chatId, `❌ *Wrong!* ${prettyUsername(user, true)}\nType /answer for explanation.`, { parse_mode: "Markdown" });
    }
  } else {
    let pts = getGroupPoints(user.id);
    let streak = getGroupStreak(user.id);
    let bonus = correct && ((now - last.time) < 30000) ? 2 : 1;
    if (correct) {
      pts += bonus; streak += 1;
      setGroupPoints(user.id, pts);
      setGroupStreak(user.id, streak);
      bot.sendMessage(chatId, `✅ *Correct!* (+${bonus} pts)\n👤 ${prettyUsername(user, true)}\n🔥 *Group Streak:* ${streak}`, { parse_mode: "Markdown" });
      setTimeout(() => sendGroupQuiz({chat:{id:chatId}}, user), 1000);
    } else {
      streak = 0; setGroupStreak(user.id, streak); last.wrong = true;
      bot.sendMessage(chatId, `❌ *Wrong!* ${prettyUsername(user, true)}\nTry /answer for explanation.`, { parse_mode: "Markdown" });
    }
    await db.write();
  }
  db.data.last_questions[entryKey] = last;
  await db.write();
});

bot.onText(/^\/points$/, async msg => {
  const user = await getUser(msg);
  if (msg.chat.type.endsWith("group")) {
    if (rejectOtherGroups(msg)) return;
    const pts = getGroupPoints(user.id);
    const streak = getGroupStreak(user.id);
    const badge = prettyBadge(pts, streak);
    bot.sendMessage(msg.chat.id,
      `💰 *Your Group Points:* ${pts}\n🏅 *Rank:* ${getRank(pts).emoji} ${getRank(pts).name} ${badge}\n🔥 *Streak:* ${streak}`,
      { parse_mode:"Markdown" });
  } else {
    bot.sendMessage(msg.chat.id,
      `💰 *Your Points:* ${user.points}\n🏅 *Rank:* ${getRank(user.points).emoji} ${getRank(user.points).name}\n🔥 *Streak:* ${user.streak}`,
      { parse_mode:"Markdown" });
  }
});
bot.onText(/^\/profile$/, async msg => {
  const user = await getUser(msg);
  let ptext =
    `👤 *Profile*\n`+
    `🆔 ${prettyUsername(user, true)} ${user.avatar||''}\n`+
    (msg.chat.type.endsWith("group") && msg.chat.id===GROUP_ID ?
      `🏅 *Group Rank:* ${getRank(getGroupPoints(user.id)).emoji} ${getRank(getGroupPoints(user.id)).name}\n`
      + `💰 Points: ${getGroupPoints(user.id)}\n🔥 Streak: ${getGroupStreak(user.id)}\n`
      : `🏅 *DM Rank:* ${getRank(user.points).emoji} ${getRank(user.points).name}\n`
      + `💰 Points: ${user.points}\n🔥 Streak: ${user.streak}\n`)+
    `🎖️ *Badges*: ${(msg.chat.type.endsWith("group")&&msg.chat.id===GROUP_ID) ? (getGroupBadges(user.id).join(", ")||"None") : (user.badges.join(", ")||"None")}`;
  bot.sendMessage(msg.chat.id, ptext, { parse_mode:"Markdown" });
});
bot.onText(/^\/setnick (.+)$/i, async (msg, m) => {
  const user = await getUser(msg);
  user.nickname = m[1].slice(0, 30);
  await updateUser(user);
  bot.sendMessage(msg.chat.id, `✅ Nickname set to *${user.nickname}*`, { parse_mode:"Markdown" });
});
bot.onText(/^\/setavatar (.+)$/i, async (msg, m) => {
  const user = await getUser(msg);
  user.avatar = m[1].slice(0, 2);
  await updateUser(user);
  bot.sendMessage(msg.chat.id, `🎨 Avatar set to ${user.avatar}`);
});
bot.onText(/^\/leaderboard$/, async msg => {
  if (!msg.chat.type.endsWith('group')) return bot.sendMessage(msg.chat.id, '🏆 *Leaderboard only in groups!*', { parse_mode:"Markdown" });
  if (rejectOtherGroups(msg)) return;
  await db.read();
  const all = db.data.users.map(u => ({ ...u, _points: getGroupPoints(u.id) }))
    .filter(u => u._points > 0)
    .sort((a, b) => b._points - a._points)
    .slice(0, 10);
  if (!all.length) return bot.sendMessage(msg.chat.id, 'No points earned here yet. Play /quiz!', { parse_mode:"Markdown" });
  const txt = all.map((u, i) =>
    `${i+1}. ${prettyUsername(u,true)}\n${u.avatar || ''} Rank: ${getRank(u._points).emoji} ${getRank(u._points).name}\nPoints: ${u._points}`
  ).join('\n\n');
  bot.sendMessage(msg.chat.id, `🏆 *${GROUP_MENTION}: Top Players*\n\n${txt}`, { parse_mode: "Markdown" });
});
bot.onText(/^\/answer/, async msg => {
  const user = await getUser(msg);
  const key = msg.chat.id+":"+user.id;
  const last = db.data.last_questions[key];
  if (!last) return bot.sendMessage(msg.chat.id, "ℹ️ No quiz to explain. Try /quiz.");
  if (!last.answered) return bot.sendMessage(msg.chat.id, "🕐 First answer it.");
  if (!last.wrong) return bot.sendMessage(msg.chat.id, "✅ You were right. Try /quiz again!");
  bot.sendMessage(msg.chat.id, last.explanation, { parse_mode: "Markdown" });
});
bot.onText(/^\/hint$/, async msg => {
  const user = await getUser(msg);
  const key = msg.chat.id + ":" + user.id;
  const last = db.data.last_questions[key];
  if (!last) return bot.sendMessage(msg.chat.id, "ℹ️ No quiz to hint. Use /quiz first!");
  db.data.hints[user.id] ||= { used: 0, lastReset: Date.now() };
  let hintRef = db.data.hints[user.id];
  const now = new Date(), lastReset = new Date(hintRef.lastReset);
  if (now.toDateString() !== lastReset.toDateString()) {
    hintRef.used = 0;
    hintRef.lastReset = Date.now();
  }
  if (hintRef.used >= 3) return bot.sendMessage(msg.chat.id, "🚫 All 3 hints used today!");
  hintRef.used++;
  await db.write();
  bot.sendMessage(msg.chat.id, `💡 *Hint:* ${last.hint}`, { parse_mode: "Markdown" });
});
bot.onText(/^\/daily$/, async msg => {
  const user = await getUser(msg);
  if (msg.chat.type.endsWith('group') && rejectOtherGroups(msg)) return;
  bot.sendMessage(msg.chat.id, "🌞 *Today's Math Challenge!*",{parse_mode:"Markdown"});
  if (msg.chat.type.endsWith("group")) await sendGroupQuiz(msg, user);
  else await sendPrivateQuiz(msg, user);
});
bot.onText(/^\/stats$/, async msg => {
  const user = await getUser(msg);
  if (msg.chat.type.endsWith("group") && msg.chat.id===GROUP_ID) {
    bot.sendMessage(msg.chat.id, `📊 *Your Group Progress*\n${prettyUsername(user, true)}\nRank: ${getRank(getGroupPoints(user.id)).emoji} ${getRank(getGroupPoints(user.id)).name}\nPoints: ${getGroupPoints(user.id)}\nStreak: ${getGroupStreak(user.id)}\nBadges: ${(getGroupBadges(user.id).join(', ')||"None")}`,
    { parse_mode: "Markdown" });
  } else {
    bot.sendMessage(msg.chat.id, `📊 *Your Progress*\n${prettyUsername(user, true)}\nRank: ${getRank(user.points).emoji} ${getRank(user.points).name}\nPoints: ${user.points}\nStreak: ${user.streak}\nBadges: ${(user.badges.join(', ')||"None")}`, { parse_mode: "Markdown" });
  }
});
bot.onText(/^\/achievements$/, async msg => {
  const user = await getUser(msg);
  if (msg.chat.type.endsWith('group') && msg.chat.id===GROUP_ID) {
    bot.sendMessage(msg.chat.id, `🎖️ *Badges*: ${(getGroupBadges(user.id).join(", ")||"None yet")}\nSpecial: ${prettyBadge(getGroupPoints(user.id), getGroupStreak(user.id))}`, { parse_mode: "Markdown" });
  } else {
    bot.sendMessage(msg.chat.id, `🎖️ *Badges*: ${(user.badges.join(", ")||"None yet")}\nSpecial: ${prettyBadge(user.points, user.streak)}`, { parse_mode: "Markdown" });
  }
});
bot.onText(/^\/ranks$/, msg => {
  const text = ["🏅 *Rank Levels:*"];
  RANKS.forEach(r => text.push(`${r.emoji} ${r.name} – ${r.points} pts`));
  bot.sendMessage(msg.chat.id, text.join('\n'), { parse_mode: "Markdown" });
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
  bot.sendMessage(msg.chat.id, "📨 *Send message/media to broadcast everywhere.*", { parse_mode: "Markdown" });
  broadcastWaiters.add(msg.from.id);
});
bot.on('message', async msg => {
  if (!broadcastWaiters.has(msg.from.id) || String(msg.from.id)!==String(ADMIN_ID)) return;
  await db.read();
  broadcastWaiters.delete(msg.from.id);
  let sent=0, failed=0;
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
  bot.sendMessage(msg.chat.id, `✅ Broadcast complete!\n📬 Sent: ${sent}\n❌ Failed: ${failed}`);
});

console.log("✅ Deb’s Quiz Bot FULL (with group debug for every poll answer) is running—every command, feature, leaderboard, points, and admin tools included.");
