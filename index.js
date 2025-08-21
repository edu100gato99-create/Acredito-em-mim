const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const io = require("socket.io-client");

/* ====== ENV ====== */
const TOKEN   = process.env.TELEGRAM_TOKEN;       // token do @BotFather
const CHAT_ID = Number(process.env.CHAT_ID || 0); // seu chat id
const TZ_OFFSET = Number(process.env.TZ_OFFSET || -180); // Brasil = -180
const USE_ARRIVAL_TIME = String(process.env.USE_ARRIVAL_TIME || "1") === "1"; // 1 = usa hora de chegada do tick
const PORT = process.env.PORT || 10000;

if (!TOKEN || !CHAT_ID) { console.error("❌ Faltam TELEGRAM_TOKEN e/ou CHAT_ID"); process.exit(1); }

/* ====== HTTP mínimo (Render Web Service) ====== */
const app = express();
app.get("/", (_req, res) => res.send("OK - bot rodando"));
app.listen(PORT, () => console.log("🌐 HTTP on", PORT));

/* ====== Telegram ====== */
const bot = new TelegramBot(TOKEN, { polling: true });
bot.on("polling_error", e => console.log("polling_error:", e?.message || e));

let running = false, DEBUG = false;
const sent = [];
const AUTODELETE_SEC = 3600;

const keyboard = {
  reply_markup: {
    keyboard: [[{text:"▶️ Iniciar"},{text:"⏹ Parar"}],[{text:"🧹 Limpar"}]],
    resize_keyboard: true
  }
};

const pad2 = n => n.toString().padStart(2,"0");
const withOffset = (d) => new Date(d.getTime() + TZ_OFFSET*60000);
const isWhite = (roll, color) => {
  const c = (color !== undefined && color !== null) ? String(color).toLowerCase() : "";
  return Number(roll) === 0 || c === "2" || c === "white" || c === "branco";
};

async function send(text) {
  try {
    const m = await bot.sendMessage(CHAT_ID, text, keyboard);
    sent.push({ id: m.message_id, ts: Math.floor(Date.now()/1000) });
  } catch (e) { console.log("send err:", e?.message || e); }
}
setInterval(() => {
  const now = Math.floor(Date.now()/1000);
  for (let i=sent.length-1;i>=0;i--) {
    if (now - sent[i].ts >= AUTODELETE_SEC) {
      bot.deleteMessage(CHAT_ID, sent[i].id).catch(()=>{});
      sent.splice(i,1);
    }
  }
}, 30000);

const isText = (msg, s) => (msg.text||"").trim().toLowerCase() === s.toLowerCase();
const startsWithEmoji = (msg, emoji) => (msg.text||"").trim().startsWith(emoji);

/* ====== Estrutura da estratégia ====== */
const fortesSet = new Set([5,7,8,9,12]);
const HISTORY_MAX = 400;
const history = [];       // [{roll,color,ts}]
const pendingWhites = []; // {id, idx, hour, minute, completed, pred[]}
const minutePredMap = new Map(); // minute -> Set(whiteIds)
let whiteSeq = 0;

function combosFromFour(minute, nums) {
  const v = nums.filter(n => n !== 0 && Number.isFinite(n));
  const out = [];
  const push = arr => {
    const sum = arr.reduce((a,b)=>a+b,0);
    out.push({ label: `${minute}+${arr.join("+")}`, minute: (minute + sum) % 60 });
  };
  for (let i=0;i<v.length;i++) push([v[i]]);
  for (let i=0;i<v.length;i++) for (let j=i+1;j<v.length;j++) push([v[i], v[j]]);
  for (let i=0;i<v.length;i++) for (let j=i+1;j<v.length;j++) for (let k=j+1;k<v.length;k++) push([v[i], v[j], v[k]]);
  if (v.length === 4) push(v);
  const seen = new Set();
  return out.filter(c => !seen.has(`${c.minute}:${c.label}`) && (seen.add(`${c.minute}:${c.label}`), true));
}
function strength(distance, minute) {
  const base = fortesSet.has(distance) ? "🔥 Forte" : "Sinal";
  const set = minutePredMap.get(minute);
  if (set && set.size >= 2) return "⚡ Muito Forte";
  return base;
}

/* ====== Núcleo de processamento ====== */
function onTick(roll, color, at) {
  const raw = USE_ARRIVAL_TIME ? new Date() : new Date(at || Date.now());
  const ts = withOffset(raw);
  history.unshift({ roll, color, ts });
  if (history.length > HISTORY_MAX) history.pop();

  if (DEBUG && history.length % 10 === 0) {
    send(`🛰️ Tick ${history.length} — roll=${roll} color=${color} ${pad2(ts.getHours())}:${pad2(ts.getMinutes())}`);
  }

  // completar janela (2 após)
  for (const w of pendingWhites) {
    if (!w.completed) {
      const a1 = history[w.idx - 1];
      const a2 = history[w.idx - 2];
      if (a1 && a2) {
        w.completed = true;
        const b1 = history[w.idx + 1]?.roll ?? null;
        const b2 = history[w.idx + 2]?.roll ?? null;
        const win = [b2, b1, a1.roll, a2.roll].filter(x=>x!==null);
        w.pred = combosFromFour(w.minute, win);
        for (const p of w.pred) {
          if (!minutePredMap.has(p.minute)) minutePredMap.set(p.minute, new Set());
          minutePredMap.get(p.minute).add(w.id);
        }
      }
    }
  }

  // validar minuto atual
  checkSignalsForMinute(ts.getMinutes());

  // novo branco
  if (isWhite(roll, color)) {
    const h = ts.getHours(), m = ts.getMinutes();
    pendingWhites.push({ id: ++whiteSeq, idx: 0, hour: h, minute: m, completed: false, pred: [] });
    if (running) send(`⚪ Branco detectado ${pad2(h)}:${pad2(m)}. Montando (2 antes + 2 depois)…`);
    else if (DEBUG) send(`⚪ (DEBUG) Branco detectado ${pad2(h)}:${pad2(m)} — bot parado.`);
  }

  // reindex & limpeza
  for (const w of pendingWhites) w.idx++;
  while (pendingWhites.length && pendingWhites[0].idx > 200) {
    const old = pendingWhites.shift();
    if (old?.pred) for (const p of old.pred) {
      const set = minutePredMap.get(p.minute);
      if (set) { set.delete(old.id); if (!set.size) minutePredMap.delete(p.minute); }
    }
  }
}

/* ====== Verifica sinais para um minuto (usado no tick e no "Iniciar") ====== */
function checkSignalsForMinute(minuteNow) {
  for (const w of pendingWhites) {
    if (!w.completed || !w.pred) continue;
    const hits = w.pred.filter(p => p.minute === minuteNow);
    if (!hits.length) continue;

    const dist = w.idx;
    const labels = hits.map(h => h.label).slice(0,6).join(" | ");
    const text =
      `⚪ Sinal Detectado\n`+
      `🕐 Branco às ${pad2(w.hour)}:${pad2(w.minute)} (offset ${TZ_OFFSET}min)\n`+
      `🔢 Combinações: ${labels}\n`+
      `🎯 Minuto alvo: ${pad2(minuteNow)}\n`+
      `📏 Distância: ${dist} casas\n`+
      `⭐ Força: ${strength(dist, minuteNow)}`;
    if (running) send(text);
    else if (DEBUG) send("👀 (DEBUG) Sinal encontrado, mas o bot está parado.");
  }
}

/* ====== Conexão Socket.IO v2 – Blaze (com fallback) ====== */
const HOSTS = [
  "https://api-v2.blaze.com",
  "https://api2.blaze.com",
  "https://api.blaze.com"
];
let socket = null, hostIdx = 0, ticks = 0;

function connect() {
  const base = HOSTS[hostIdx % HOSTS.length];
  console.log("🔌 Conectando:", base, "…");

  socket = io.connect(base, {
    path: "/replication/socket.io/",
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    timeout: 10000
  });

  socket.on("connect", () => console.log("✅ Conectado em", base));

  const handle = (msg) => {
    const roll  = Number(msg && (msg.roll ?? msg.number));
    const color = (msg && (msg.color ?? msg.colour ?? msg.result_color));
    const at = (msg && (msg.created_at || msg.rolled_at || msg.updated_at)) || undefined;
    ticks++;
    if (ticks % 30 === 0) console.log("ticks:", ticks);
    if (Number.isFinite(roll)) onTick(roll, color, at);
    else if (DEBUG) send(`🛰️ (DEBUG) tick sem roll válido: ${JSON.stringify(msg).slice(0,180)}...`);
  };

  socket.on("double.tick", handle);
  socket.on("doubles:tick", handle);

  socket.on("connect_error", (err) => { console.log("⚠️ connect_error:", err?.message || err); fallback(); });
  socket.on("error", (err) => console.log("⚠️ error:", err?.message || err));
  socket.on("disconnect", (reason) => { console.log("🔌 disconnect:", reason); fallback(); });
}
function fallback() {
  try { socket && socket.close(); } catch {}
  hostIdx++;
  const wait = Math.min(15000, 2000 * hostIdx);
  console.log(`⏳ Tentando próximo host em ${Math.floor(wait/1000)}s…`);
  setTimeout(connect, wait);
}

/* ====== Controles do bot (inclui backfill ao Iniciar) ====== */
bot.on("message", async (msg)=>{
  if (isText(msg,"/start")) return bot.sendMessage(CHAT_ID, "🤖 Pronto! Use os botões abaixo.", keyboard);
  if (isText(msg,"/debug on"))  { DEBUG = true;  return send("🔧 DEBUG ligado"); }
  if (isText(msg,"/debug off")) { DEBUG = false; return send("🔧 DEBUG desligado"); }
  if (isText(msg,"/ping")) {
    const now = new Date(), off = withOffset(now);
    return send(`🏓 ping ok • UTC=${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())} • off=${pad2(off.getHours())}:${pad2(off.getMinutes())}`);
  }

  if (startsWithEmoji(msg,"▶️") || isText(msg,"iniciar")) {
    running = true;
    await send("✅ Sinais INICIADOS");
    // 🔁 BACKFILL: se já havia brancos e previsões calculadas,
    // checa imediatamente para o minuto atual
    const minuteNow = withOffset(new Date()).getMinutes();
    checkSignalsForMinute(minuteNow);
    return;
  }
  if (startsWithEmoji(msg,"⏹") || isText(msg,"parar")) {
    running = false; return send("🛑 Sinais PARADOS");
  }
  if (startsWithEmoji(msg,"🧹") || isText(msg,"limpar")) {
    for (const s of [...sent]) await bot.deleteMessage(CHAT_ID, s.id).catch(()=>{});
    sent.length = 0; return send("🧽 Limpeza concluída.");
  }
});

connect();
send("🤖 Bot pronto. Use ▶️ Iniciar / ⏹ Parar / 🧹 Limpar — /debug on para ver ticks.").catch(()=>{});
