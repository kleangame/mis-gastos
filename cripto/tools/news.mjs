// Genera news.json: titulares en español por moneda (Google Noticias es-419) y conteo diario de noticias (Google News en inglés).
import fs from 'fs';
const OUT = process.argv[2] || 'news.json';
const COINS = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', DOGE: 'Dogecoin', BNB: '"BNB" Binance', XRP: 'XRP Ripple', ADA: 'Cardano', AVAX: 'Avalanche AVAX', LINK: 'Chainlink', LTC: 'Litecoin', DOT: 'Polkadot', TRX: 'TRON TRX' };
const MARKET = 'criptomonedas bitcoin mercado';
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { coins: {} };
const dec = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? dec(m[1]) : ''; };
async function rss(q, lang) {
  const loc = lang === 'es' ? 'hl=es-419&gl=US&ceid=US:es-419' : 'hl=en-US&gl=US&ceid=US:en';
  const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${loc}`, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(q + ' ' + r.status);
  const x = await r.text();
  return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const it = m[1], src = tag(it, 'source'); let title = tag(it, 'title');
    if (src && title.endsWith(' - ' + src)) title = title.slice(0, -(src.length + 3));
    return { title, src, link: tag(it, 'link'), ts: Date.parse(tag(it, 'pubDate')) };
  }).filter(i => i.ts && i.title);
}
const day = ts => new Date(ts).toISOString().slice(0, 10);
const now = Date.now(), out = { updated: new Date(now).toISOString(), coins: {} };
for (const [k, q] of Object.entries({ ...COINS, MARKET })) {
  const P = prev.coins[k] || {};
  let items = P.items || [], counts = P.counts || {}, seen = P.seen || {};
  try {
    const es = await rss(`${q} ${k === 'MARKET' ? '' : 'cripto'} when:3d`, 'es');
    const byLink = new Map(items.map(i => [i.link, i]));
    es.forEach(i => byLink.set(i.link, i));
    items = [...byLink.values()].filter(i => now - i.ts < 30 * 864e5).sort((a, b) => b.ts - a.ts).slice(0, 60);
    if (k !== 'MARKET') {
      const en = await rss(`${q} crypto when:1d`, 'en');
      for (const i of en) { const d = day(i.ts), h = i.link.slice(-40); (seen[d] ||= []); if (!seen[d].includes(h)) { seen[d].push(h); counts[d] = (counts[d] || 0) + 1; } }
      for (const d of Object.keys(seen)) if (now - Date.parse(d) > 3 * 864e5) delete seen[d];
      for (const d of Object.keys(counts)) if (now - Date.parse(d) > 400 * 864e5) delete counts[d];
    }
  } catch (e) { console.error(e.message); }
  out.coins[k] = { items, counts, seen };
  await new Promise(r => setTimeout(r, 800));
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('ok', Object.entries(out.coins).map(([k, v]) => `${k}:${v.items.length}/${Object.values(v.counts).reduce((a, b) => a + b, 0)}`).join(' '));
