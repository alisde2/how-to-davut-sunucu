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

/** id -> oyuncu */
const players = new Map();
let nextId = 1;

// Çocuk dostu sohbet: kaba kelimeleri yıldızla
const BAD = ['aptal', 'salak', 'gerizekalı', 'mal', 'öküz', 'şerefsiz', 'lan'];
function clean(text) {
  let t = String(text).slice(0, 80).replace(/[<>]/g, '');
  // \b Türkçe harflerde çalışmadığı için boşluk/noktalama sınırı kullanılır
  for (const w of BAD) t = t.replace(new RegExp(`(^|[\\s.,!?])${w}(?=$|[\\s.,!?])`, 'gi'), (_, pre) => pre + '*'.repeat(w.length));
  return t.trim();
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

const pub = (p) => ({ id: p.id, name: p.name, zone: p.zone, color: p.color, x: p.x, y: p.y, z: p.z, ry: p.ry, anim: p.anim, level: p.level, rebirths: p.rebirths });

function boardList() {
  return Object.entries(board.get())
    .map(([name, b]) => ({ name, ...b, online: [...players.values()].some((p) => p.name === name) }))
    .sort((a, b) => b.money - a.money)
    .slice(0, 20);
}

// ---------- HTTP (Render sağlık kontrolü ve tarayıcıdan bakınca bilgi) ----------
const http = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(`⚓ How to Davut sunucusu çalışıyor! Çevrimiçi: ${players.size} oyuncu.\n`);
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
        p.joined = true;
        players.set(id, p);
        send(ws, { t: 'welcome', id, players: [...players.values()].filter((o) => o.id !== id).map(pub), board: boardList(), story: story.get() });
        broadcast({ t: 'join', p: pub(p) }, id);
        broadcast({ t: 'announce', text: `🌍 ${p.name} oyuna katıldı!` }, id);
        console.log(`+ ${p.name} katıldı (${players.size} oyuncu) [${req.socket.remoteAddress}]`);
        break;
      }
      case 'state':
        p.x = num(m.x); p.y = num(m.y); p.z = num(m.z); p.ry = num(m.ry);
        p.anim = String(m.anim || 'idle').slice(0, 8);
        break;
      case 'zone':
        p.zone = String(m.zone || 'liman');
        broadcast({ t: 'zone', id, zone: p.zone }, id);
        break;
      case 'chat': {
        const text = clean(m.text);
        if (!text) return;
        broadcast({ t: 'chat', id, name: p.name, text }, id);
        send(ws, { t: 'chat', id, name: p.name, text });
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
  for (const [zone, list] of byZone) broadcast({ t: 'states', list }, undefined, zone);
}, 100);

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
