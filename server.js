// How to Davut çok oyunculu sunucusu
// Evde (aynı Wi-Fi) ya da internette (Render gibi bir bulut sunucusunda) çalışır.
// Çalıştırmak için: node server.js   (varsayılan port 8765; Render PORT ortam değişkenini kendisi verir)
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { networkInterfaces } from 'node:os';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 8080 sık kullanılır (Steam vb.), bu yüzden 8765
const PORT = Number(process.env.PORT) || 8765;
const MAX_PLAYERS = 16;
const here = dirname(fileURLToPath(import.meta.url));

// ---------- Dosyada saklanan veriler ----------
// Not: Render'ın ücretsiz planında sunucu yeniden başlayınca bu dosyalar sıfırlanabilir.
function store(file, fallback) {
  const path = join(here, file);
  let data = fallback;
  try {
    if (existsSync(path)) data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    data = fallback;
  }
  let dirty = false;
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    try {
      writeFileSync(path, JSON.stringify(data, null, 1));
    } catch (e) {
      console.error(`${file} kaydedilemedi:`, e.message);
    }
  }, 10000);
  return { get: () => data, set: (d) => { data = d; dirty = true; }, touch: () => (dirty = true) };
}

/** Liderlik: isim -> en iyi değerler */
const board = store('liderlik.json', {});
/** Kullanıcı adları: ad (küçük harf) -> cihaz anahtarı. Böylece başkası senin adınla giremez. */
const users = store('kullanicilar.json', {});
/** Birlikte oynanan hikaye ilerlemesi */
const story = store('hikaye.json', { ch: 0, step: 0, count: 0, intro: false, done: false });

/** Oyuncu pazarı: satıştaki balıklar ve satıcıların toplanmamış kazançları */
const market = store('pazar.json', { listings: [], payouts: {}, nextId: 1 });

/** id -> oyuncu */
const players = new Map();

// ---------- Ortak dünya: saat, gün, hava ve etkinlikler herkes için aynı ----------
const DAY_SECONDS = 18 * 60; // oyundaki gibi: bir gün 18 dakika
const WEATHERS = [['acik', 50], ['bulutlu', 25], ['yagmur', 17], ['firtina', 8]];
const worldState = { t0: Date.now(), hour0: 8, day0: 0, weather: 'acik' };
function worldClock() {
  const h = worldState.hour0 + ((Date.now() - worldState.t0) / 1000) * (24 / DAY_SECONDS);
  return { hour: h % 24, day: worldState.day0 + Math.floor(h / 24) };
}
const worldMsg = () => ({ t: 'world', ...worldClock(), weather: worldState.weather });
function rollWeather() {
  let r = Math.random() * 100;
  for (const [w, p] of WEATHERS) { r -= p; if (r <= 0) return w; }
  return 'acik';
}
(function weatherLoop() {
  setTimeout(() => {
    const w = rollWeather();
    if (w !== worldState.weather) {
      worldState.weather = w;
      broadcast(worldMsg());
    }
    weatherLoop();
  }, (150 + Math.random() * 210) * 1000);
})();
// her 15 saniyede saat düzeltmesi
setInterval(() => { if (players.size) broadcast(worldMsg()); }, 15000);
// ortak etkinlikler: boss ve korsan baskını herkes için aynı anda olur
const BOSS_ZONES = ['liman', 'sisli', 'buz', 'volkan', 'derin', 'akinti', 'mercan', 'burun'];
(function eventLoop() {
  setTimeout(() => {
    const zones = [...new Set([...players.values()].map((p) => p.zone))];
    if (zones.length) {
      const liman = zones.includes('liman');
      const bossZones = zones.filter((z) => BOSS_ZONES.includes(z));
      if (liman && Math.random() < 0.4) {
        broadcast({ t: 'event', kind: 'raid', zone: 'liman' }, undefined, 'liman');
        botAll('🏴‍☠️ Kara Korsan Liman Köyü\'ne saldırıyor! Herkes iskeleye!');
      } else if (bossZones.length) {
        const z = bossZones[Math.floor(Math.random() * bossZones.length)];
        broadcast({ t: 'event', kind: 'boss', zone: z }, undefined, z);
        botAll(`🌊 ${ZONE_NAMES[z] || z} sularında dev bir gölge görüldü!`);
      }
    }
    eventLoop();
  }, (8 + Math.random() * 6) * 60 * 1000);
})();

// ---------- Davut Adası ziyareti ----------
const BUILD_IDS = ['kulube', 'balikci', 'dukkan', 'meyve', 'fener', 'ates'];
function cleanIsland(d) {
  if (!d || typeof d !== 'object') return null;
  const plots = Array.isArray(d.plots) ? d.plots.slice(0, 6) : [];
  return {
    owned: !!d.owned,
    plots: plots.map((p) => (p && BUILD_IDS.includes(p.type) ? { type: p.type, lv: Math.max(1, Math.min(3, num(p.lv, 1))), t0: 0, workers: Math.max(0, Math.min(3, num(p.workers))) } : null)),
  };
}

// ---------- Oyuncu pazarı ----------
const MARKET_MAX = 120;
const MARKET_PER_SELLER = 6;
const marketList = () => market.get().listings.slice(-MARKET_MAX).map((l) => ({ id: l.id, seller: l.seller, fish: l.fish, price: l.price, t: l.t }));
let nextId = 1;

// Çocuk dostu sohbet: kaba kelimeleri yıldızla
const BAD = ['aptal', 'salak', 'gerizekalı', 'mal', 'öküz', 'şerefsiz', 'lan'];
/** @returns { text, bad } bad: kaç kaba kelime yıldızlandı */
function clean(text) {
  let t = String(text).slice(0, 80).replace(/[<>]/g, '');
  let bad = 0;
  // \b Türkçe harflerde çalışmadığı için boşluk/noktalama sınırı kullanılır
  for (const w of BAD) t = t.replace(new RegExp(`(^|[\\s.,!?])${w}(?=$|[\\s.,!?])`, 'gi'), (_, pre) => { bad++; return pre + '*'.repeat(w.length); });
  return { text: t.trim(), bad };
}

// ---------- 🤖 Admin bot: sohbeti yönetir ----------
const BOT = '🤖 Admin';
const ZONE_NAMES = { liman: 'Liman Köyü', sisli: 'Sisli Göl', buz: 'Buz Koyu', volkan: 'Volkan Adası', derin: 'Derin Deniz', kayip: 'Kayıp Ada', ada: 'Davut Adası', akinti: 'Karanlık Akıntı', acik: 'Açık Deniz', mercan: 'Mercan Resifi', burun: 'Fırtına Burnu' };
const RULES = [
  '1) Herkese saygılı ol, kaba konuşma yok.',
  '2) Sohbeti mesaj yağmuruna tutma (spam = susturma).',
  '3) Kaba kelime: önce uyarı, sonra susturma, en son atılma.',
  '4) Birbirinize yardım edin, hikayeyi birlikte bitirin! ⚓',
];
const TIPS = [
  '💡 İpucu: Balık yere düşünce basılı tutarak sürekli vurabilirsin.',
  '💡 İpucu: Tekne Seviye 4\'te açılır. Adalar uzak, pusulayı takip et! 🧭',
  '💡 İpucu: Yeşil alanda vurursan 2 kat hasar verirsin.',
  '💡 İpucu: Davut\'un evindeki yatakta uyuyunca canın dolar. 😴',
  '💡 İpucu: Silahçı Cemal\'de silahlarına skin alabilirsin. 🎨',
  '💡 İpucu: 🎤 düğmesiyle sesli sohbeti açabilirsin.',
  '💡 İpucu: M tuşu ya da mini haritaya dokunmak büyük haritayı açar. 🗺️',
];

/**
 * Admin bot oyunda da görünür: Liman Köyü iskelesinde dolaşır, arada olta atar.
 * Böylece sunucu hiç boş görünmez. (id 0, oyuncu sayısına/limite dahil değil)
 */
const botP = { id: 0, name: BOT, title: 'Sunucu Yöneticisi', zone: 'liman', color: 7, x: 0, y: 0.85, z: 32, ry: 0, anim: 'idle', level: 99, rebirths: 9 };
const botAI = { tx: 0, tz: 32, wait: 3 };
setInterval(() => {
  const dt = 0.1;
  const dx = botAI.tx - botP.x, dz = botAI.tz - botP.z;
  const d = Math.hypot(dx, dz);
  if (d > 0.1) {
    const step = Math.min(d, 1.6 * dt);
    botP.x += (dx / d) * step;
    botP.z += (dz / d) * step;
    botP.ry = Math.atan2(dx, dz);
    botP.anim = 'walk';
  } else {
    botAI.wait -= dt;
    // iskelenin ucunda denize dönüp olta atar
    botP.ry = 0;
    botP.anim = botP.z > 36 ? 'fish' : 'rod';
    if (botAI.wait <= 0) {
      botAI.tx = -0.8 + Math.random() * 1.6;
      botAI.tz = 29 + Math.random() * 12;
      botAI.wait = 6 + Math.random() * 10;
    }
  }
}, 100);

function botTo(ws, text) {
  send(ws, { t: 'chat', id: 0, name: BOT, text, bot: true });
}
function botAll(text) {
  broadcast({ t: 'chat', id: 0, name: BOT, text, bot: true });
}

/** Spam ve küfür denetimi. @returns mesaj geçebilir mi */
function moderate(p, bad) {
  const now = Date.now();
  if (p.mutedUntil > now) {
    botTo(p.ws, `🔇 Susturuldun. ${Math.ceil((p.mutedUntil - now) / 1000)} saniye sonra yazabilirsin.`);
    return false;
  }
  p.msgTimes = (p.msgTimes || []).filter((t) => now - t < 8000);
  p.msgTimes.push(now);
  if (p.msgTimes.length > 5) {
    p.mutedUntil = now + 30000;
    p.msgTimes = [];
    botAll(`🔇 ${p.name} çok hızlı yazdığı için 30 saniye susturuldu.`);
    return false;
  }
  if (bad) {
    p.strikes = (p.strikes || 0) + 1;
    if (p.strikes >= 5) {
      botAll(`⛔ ${p.name} kurallara uymadığı için oyundan atıldı.`);
      send(p.ws, { t: 'kicked', reason: 'Kaba konuşma yüzünden sunucudan atıldın.' });
      setTimeout(() => p.ws.close(), 200);
      return false;
    }
    if (p.strikes >= 3) {
      p.mutedUntil = now + 60000;
      botAll(`🔇 ${p.name} kaba konuştuğu için 1 dakika susturuldu.`);
      return false;
    }
    botTo(p.ws, `⚠️ Lütfen kaba konuşma! (Uyarı ${p.strikes}/3)`);
  }
  return true;
}

/** Sohbet komutları: /yardim, /oyuncular, /kurallar, /zar, /saat, /hikaye */
function command(p, text) {
  const cmd = text.slice(1).split(/\s+/)[0].toLocaleLowerCase('tr');
  switch (cmd) {
    case 'yardim':
    case 'yardım':
      botTo(p.ws, 'Komutlar: /oyuncular · /kurallar · /zar · /saat · /hikaye');
      break;
    case 'oyuncular': {
      const list = [...players.values()].map((o) => `${o.name} (${ZONE_NAMES[o.zone] || o.zone}, Sv ${o.level})`);
      list.unshift(`${BOT} (Liman Köyü iskelesi)`);
      botTo(p.ws, `🌍 Çevrimiçi ${list.length}: ${list.join(', ')}`);
      break;
    }
    case 'kurallar':
      for (const r of RULES) botTo(p.ws, r);
      break;
    case 'zar':
      botAll(`🎲 ${p.name} zar attı: ${1 + Math.floor(Math.random() * 6)}`);
      break;
    case 'saat':
      botTo(p.ws, `🕒 Saat ${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' })}`);
      break;
    case 'hikaye': {
      const s = story.get();
      botTo(p.ws, s.done ? '📜 Ekip hikayeyi bitirdi! Kral Hamsi yakalandı. 👑' : `📜 Ekip hikayesi: Bölüm ${s.ch + 1}, adım ${s.step + 1}`);
      break;
    }
    default:
      botTo(p.ws, `❓ "/${cmd}" diye bir komut yok. /yardim yaz.`);
  }
}

/** Dolap görünüşü: sadece bilinen alanlar, doğru türlerde */
function cleanLook(l) {
  if (!l || typeof l !== 'object') return null;
  const out = {};
  for (const k of ['shirt', 'pants', 'skin', 'hair', 'eyes', 'glasses', 'beardColor']) if (Number.isFinite(l[k])) out[k] = l[k] | 0;
  if (l.hat === null || Number.isFinite(l.hat)) out.hat = l.hat === null ? null : l.hat | 0;
  if (['bere', 'sapka', 'kaptan'].includes(l.hatType)) out.hatType = l.hatType;
  if (l.mustache === true || l.mustache === false || l.mustache === 'kalin') out.mustache = l.mustache;
  if ([true, false, 'full', 'keci', 'kirli'].includes(l.beard)) out.beard = l.beard;
  if (typeof l.thickBrows === 'boolean') out.thickBrows = l.thickBrows;
  return out;
}

const validName = (n) => /^[A-Za-z0-9_ÇĞİÖŞÜçğıöşü]{3,16}$/.test(String(n || ''));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const progress = (s) => (s.done ? 1e9 : num(s.ch) * 10000 + num(s.step) * 100 + Math.min(99, num(s.count)));

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(msg, exceptId, zone) {
  const s = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    if (zone && p.zone !== zone) continue;
    if (p.ws.readyState === 1) p.ws.send(s);
  }
}

const pub = (p) => ({ id: p.id, name: p.name, zone: p.zone, color: p.color, x: p.x, y: p.y, z: p.z, ry: p.ry, anim: p.anim, level: p.level, rebirths: p.rebirths, title: p.title || '', look: p.look || null });

function boardList() {
  return Object.entries(board.get())
    .map(([name, b]) => ({ name, ...b, online: [...players.values()].some((p) => p.name === name) }))
    .sort((a, b) => b.money - a.money)
    .slice(0, 20);
}

// ---------- HTTP (Render sağlık kontrolü ve tarayıcıdan bakınca bilgi) ----------
const http = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(`⚓ How to Davut sunucusu çalışıyor! Çevrimiçi: ${players.size} oyuncu + 🤖 Admin.\n`);
});
const wss = new WebSocketServer({ server: http });

wss.on('connection', (ws, req) => {
  if (players.size >= MAX_PLAYERS) {
    send(ws, { t: 'full' });
    ws.close();
    return;
  }
  const id = nextId++;
  const p = { id, ws, name: '', zone: 'liman', color: id % 8, x: 0, y: 0, z: 16, ry: 0, anim: 'idle', level: 1, rebirths: 0, alive: true, joined: false };
  ws.on('pong', () => (p.alive = true));

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.t !== 'hello' && !p.joined) return;
    switch (m.t) {
      case 'hello': {
        const name = String(m.name || '').trim();
        const token = String(m.token || '');
        if (!validName(name)) {
          send(ws, { t: 'nametaken', reason: 'Kullanıcı adı 3-16 harf/rakam olmalı.' });
          ws.close();
          return;
        }
        const key = name.toLocaleLowerCase('tr');
        const u = users.get();
        // ad başka bir cihaza ayrılmışsa ya da şu an oyundaysa giremez
        if ((u[key] && u[key] !== token) || [...players.values()].some((o) => o.name.toLocaleLowerCase('tr') === key)) {
          send(ws, { t: 'nametaken', reason: `"${name}" adı başka bir oyuncuya ait. Başka bir ad seç.` });
          ws.close();
          return;
        }
        if (!u[key] && token) {
          u[key] = token;
          users.touch();
        }
        p.name = name;
        p.zone = String(m.zone || 'liman');
        p.color = num(m.color, id) % 8;
        p.title = clean(m.title || '').text.slice(0, 24);
        p.look = cleanLook(m.look);
        p.joined = true;
        players.set(id, p);
        send(ws, { t: 'welcome', id, players: [pub(botP), ...[...players.values()].filter((o) => o.id !== id).map(pub)], board: boardList(), story: story.get(), world: worldMsg() });
        const owed = market.get().payouts[p.name];
        if (owed) setTimeout(() => botTo(ws, `💰 Pazarda balıkların satıldı! Toplanacak kazanç: ${owed} ₺ (Pazar > Kazançlar)`), 2500);
        broadcast({ t: 'join', p: pub(p) }, id);
        broadcast({ t: 'announce', text: `🌍 ${p.name} oyuna katıldı!` }, id);
        setTimeout(() => botTo(ws, `Hoş geldin ${p.name}! ⚓ Komutlar için /yardim yaz. Kurallar: /kurallar`), 1500);
        console.log(`+ ${p.name} katıldı (${players.size} oyuncu) [${req.socket.remoteAddress}]`);
        break;
      }
      case 'state':
        p.x = num(m.x); p.y = num(m.y); p.z = num(m.z); p.ry = num(m.ry);
        p.anim = String(m.anim || 'idle').slice(0, 8);
        break;
      case 'look':
        p.look = cleanLook(m.look);
        broadcast({ t: 'look', id, look: p.look }, id);
        break;
      case 'title':
        p.title = clean(m.title || '').text.slice(0, 24);
        broadcast({ t: 'title', id, title: p.title }, id);
        break;
      case 'zone':
        p.zone = String(m.zone || 'liman');
        broadcast({ t: 'zone', id, zone: p.zone }, id);
        // Davut Adası'na gelene oradaki oyuncuların adalarını gönder
        if (p.zone === 'ada') for (const o of players.values()) if (o.id !== id && o.zone === 'ada' && o.island) send(ws, { t: 'island', id: o.id, name: o.name, data: o.island });
        break;
      case 'island': {
        p.island = cleanIsland(m.data);
        if (p.island && p.zone === 'ada') broadcast({ t: 'island', id, name: p.name, data: p.island }, id, 'ada');
        break;
      }
      case 'coop': {
        // birlikte büyük balık: savaşılan dev balığın canı ve yeri aynı adadakilere
        const fish = String(m.fish || '').slice(0, 24);
        if (!fish) return;
        broadcast({ t: 'coop', id, name: p.name, fish, hp: Math.max(0, num(m.hp)), max: Math.max(1, num(m.max, 1)), x: num(m.x), y: num(m.y), z: num(m.z) }, id, p.zone);
        break;
      }
      case 'coop_end':
        broadcast({ t: 'coop_end', id, name: p.name, fish: String(m.fish || '').slice(0, 24), caught: !!m.caught, value: Math.max(0, Math.min(1e9, num(m.value))) }, id, p.zone);
        if (m.caught) botAll(`🤝 ${p.name} dev balığı yakaladı!`);
        break;
      case 'coop_hit': {
        const to = players.get(num(m.to));
        if (!to || to.zone !== p.zone) return;
        send(to.ws, { t: 'coop_hit', from: id, name: p.name, dmg: Math.max(1, Math.min(1e6, num(m.dmg, 1))) });
        break;
      }
      case 'boat': {
        // birlikte tekne: yolcu biner/iner, kaptan başka adaya yanaşınca yolcusunu da götürür
        const to = players.get(num(m.to));
        const kind = String(m.kind || '');
        if (!to || !['join', 'leave', 'travel'].includes(kind)) return;
        if (kind !== 'travel' && to.zone !== p.zone) return;
        send(to.ws, { t: 'boat', from: id, name: p.name, kind, zone: kind === 'travel' ? String(m.zone || '').slice(0, 16) : undefined });
        if (kind === 'join') botAll(`⛵ ${p.name}, ${to.name} oyuncusunun teknesine bindi!`);
        break;
      }
      case 'market_list':
        send(ws, { t: 'market', list: marketList(), payout: market.get().payouts[p.name] || 0 });
        break;
      case 'market_sell': {
        const f = m.fish || {};
        const price = Math.round(num(m.price));
        const M = market.get();
        if (typeof f.id !== 'string' || f.id.length > 24 || price < 1 || price > 1e9) return;
        if (M.listings.filter((l) => l.seller === p.name).length >= MARKET_PER_SELLER) {
          send(ws, { t: 'market_err', text: `En fazla ${MARKET_PER_SELLER} balık satışa koyabilirsin.` });
          return;
        }
        if (M.listings.length >= MARKET_MAX) {
          send(ws, { t: 'market_err', text: 'Pazar dolu, biraz sonra dene.' });
          return;
        }
        const fish = { id: f.id, kg: Math.max(0, Math.min(5000, num(f.kg))), value: Math.max(1, Math.min(1e7, num(f.value, 1))), mutation: typeof f.mutation === 'string' ? f.mutation.slice(0, 12) : undefined };
        M.listings.push({ id: M.nextId++, seller: p.name, fish, price, t: Date.now() });
        market.touch();
        send(ws, { t: 'market_ok', text: 'Balığın pazara kondu!' });
        broadcast({ t: 'market', list: marketList() });
        break;
      }
      case 'market_buy': {
        const M = market.get();
        const i = M.listings.findIndex((l) => l.id === num(m.id));
        if (i < 0) { send(ws, { t: 'market_err', text: 'Bu balık az önce satıldı.' }); return; }
        const l = M.listings[i];
        if (l.seller === p.name) return;
        M.listings.splice(i, 1);
        M.payouts[l.seller] = (M.payouts[l.seller] || 0) + l.price;
        market.touch();
        send(ws, { t: 'market_bought', fish: l.fish, price: l.price, seller: l.seller });
        const seller = [...players.values()].find((o) => o.name === l.seller);
        if (seller) send(seller.ws, { t: 'market_sold', fish: l.fish, price: l.price, buyer: p.name });
        broadcast({ t: 'market', list: marketList() });
        break;
      }
      case 'market_cancel': {
        const M = market.get();
        const i = M.listings.findIndex((l) => l.id === num(m.id) && l.seller === p.name);
        if (i < 0) return;
        const [l] = M.listings.splice(i, 1);
        market.touch();
        send(ws, { t: 'market_returned', fish: l.fish });
        broadcast({ t: 'market', list: marketList() });
        break;
      }
      case 'market_claim': {
        const M = market.get();
        const amount = M.payouts[p.name] || 0;
        if (!amount) return;
        delete M.payouts[p.name];
        market.touch();
        send(ws, { t: 'market_paid', amount });
        break;
      }
      case 'chat': {
        const { text, bad } = clean(m.text);
        if (!text) return;
        if (text.startsWith('/')) {
          command(p, text);
          return;
        }
        if (!moderate(p, bad)) return;
        broadcast({ t: 'chat', id, name: p.name, text }, id);
        send(ws, { t: 'chat', id, name: p.name, text });
        break;
      }
      case 'gift': {
        // balık hediyesi: aynı adadaki oyuncuya, alanları doğrulanarak
        const to = players.get(num(m.to));
        const f = m.fish || {};
        if (!to || to.zone !== p.zone || typeof f.id !== 'string' || f.id.length > 24) return;
        const fish = { id: f.id, kg: Math.max(0, Math.min(5000, num(f.kg))), value: Math.max(1, Math.min(1e7, num(f.value, 1))), mutation: typeof f.mutation === 'string' ? f.mutation.slice(0, 12) : undefined };
        send(to.ws, { t: 'gift', from: id, name: p.name, fish });
        botAll(`🎁 ${p.name}, ${to.name} oyuncusuna balık hediye etti!`);
        break;
      }
      case 'rtc': {
        // sesli sohbet: WebRTC sinyallerini aynı adadaki hedef oyuncuya ilet (ses sunucudan geçmez)
        const to = players.get(num(m.to));
        if (!to || to.zone !== p.zone) return;
        const data = JSON.stringify(m.data ?? null);
        if (data.length > 12000) return;
        send(to.ws, { t: 'rtc', from: id, data: m.data });
        break;
      }
      case 'catch':
        // nadir balıklar herkese duyurulur
        broadcast({ t: 'announce', text: `🎣 ${p.name} bir ${String(m.rarity).slice(0, 12)} ${String(m.fish).slice(0, 24)} yakaladı! (${num(m.kg).toFixed(1)} kg)` });
        break;
      case 'story': {
        // birlikte hikaye: en ileri giden ilerleme herkesin olur
        const s = m.s || {};
        const cur = story.get();
        if (progress(s) > progress(cur)) {
          const next = { ch: num(s.ch), step: num(s.step), count: num(s.count), intro: !!s.intro, done: !!s.done };
          story.set(next);
          broadcast({ t: 'story', s: next, by: p.name }, id);
          console.log(`📜 Hikaye ilerledi (${p.name}): bölüm ${next.ch + 1}, adım ${next.step + 1}`);
        }
        break;
      }
      case 'stats': {
        p.level = num(m.level, 1);
        p.rebirths = num(m.rebirths);
        const all = board.get();
        const b = all[p.name] || { money: 0, bestKg: 0, rebirths: 0, caught: 0 };
        all[p.name] = {
          money: Math.max(b.money, num(m.money)),
          bestKg: Math.max(b.bestKg, num(m.bestKg)),
          rebirths: Math.max(b.rebirths, num(m.rebirths)),
          caught: Math.max(b.caught, num(m.caught)),
        };
        board.touch();
        break;
      }
      case 'board':
        send(ws, { t: 'board', list: boardList() });
        break;
    }
  });

  ws.on('close', () => {
    if (!players.has(id)) return;
    players.delete(id);
    broadcast({ t: 'leave', id });
    broadcast({ t: 'announce', text: `👋 ${p.name} oyundan ayrıldı.` });
    console.log(`- ${p.name} ayrıldı (${players.size} oyuncu)`);
  });
});

// Saniyede 10 kez herkesin konumunu aynı adadakilere gönder
setInterval(() => {
  const byZone = new Map();
  for (const p of players.values()) {
    if (!byZone.has(p.zone)) byZone.set(p.zone, []);
    byZone.get(p.zone).push([p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.ry.toFixed(2), p.anim]);
  }
  const bot = [0, +botP.x.toFixed(2), botP.y, +botP.z.toFixed(2), +botP.ry.toFixed(2), botP.anim];
  if (!byZone.has('liman')) byZone.set('liman', []);
  byZone.get('liman').push(bot);
  for (const [zone, list] of byZone) broadcast({ t: 'states', list }, undefined, zone);
}, 100);

// Admin bot ara ara ipucu verir
let tipI = 0;
setInterval(() => {
  if (players.size) botAll(TIPS[tipI++ % TIPS.length]);
}, 4 * 60 * 1000);

// Kopan bağlantıları temizle
setInterval(() => {
  for (const p of players.values()) {
    if (!p.alive) {
      p.ws.terminate();
      continue;
    }
    p.alive = false;
    p.ws.ping();
  }
}, 15000);

// Render'ın ücretsiz planı 15 dakika istek gelmezse sunucuyu uyutur.
// Sunucu kendi adresine 10 dakikada bir uğrar: hep açık kalır, Admin bot hep oyunda olur.
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => {
    fetch(SELF_URL).catch(() => {});
  }, 10 * 60 * 1000);
}

http.listen(PORT, () => {
  const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('');
  console.log('  ⚓ How to Davut sunucusu çalışıyor!');
  console.log(`  Port: ${PORT}`);
  console.log('  Aynı Wi-Fi\'den bağlanmak için oyunda "Çok Oyunculu" > Sunucu adresine şunlardan birini yaz:');
  for (const ip of ips) console.log(`     ${ip}`);
  console.log('');
  console.log('  (Kapatmak için bu pencereyi kapat ya da Ctrl+C)');
});
