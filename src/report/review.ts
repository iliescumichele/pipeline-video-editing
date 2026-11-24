/** Dati di uno short per review.html (gli stessi del suo .json). */
export interface ReviewShort {
  id: string;
  rank: number;
  file: string;
  thumb: string;
  duration: number;
  source: { s: number; e: number; turn: number; peak: number; segments?: { s: number; e: number }[] };
  layout: string;
  layoutWhy: string;
  hook: string;
  score: number;
  score_reason: string;
  reason: string;
  what?: string;
  warnings: string[];
  signals: Record<string, number>;
  missing: string[];
  labels: string[];
  copy: Record<'youtube' | 'instagram' | 'tiktok', { title: string; description: string; hashtags: string[] }>;
  measures: { lufs: number; truePeak: number; width: number; height: number; fps: number };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Pagina statica, senza risorse esterne: si apre da Finder accanto ai video. */
export function reviewHtml(title: string, shorts: ReviewShort[]): string {
  const data = JSON.stringify(shorts).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review shorts</title>
<style>
  :root { --amber:#FFB547; --teal:#3FD0C9; --ink:#17141F; --panel:#211D2C; --line:#332D42; --text:#F3F0F7; --muted:#A39DB0; --warn:#FF7A6B; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--ink); color:var(--text); font:15px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
  header { position:sticky; top:0; z-index:5; display:flex; gap:16px; align-items:center; justify-content:space-between; padding:14px 24px; background:rgba(23,20,31,.92); backdrop-filter:blur(10px); border-bottom:1px solid var(--line); }
  header h1 { font-size:17px; margin:0; font-weight:700; }
  header .sub { color:var(--muted); font-size:13px; }
  .btn { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:9px; padding:7px 12px; font:inherit; font-size:13px; cursor:pointer; }
  .btn:hover { border-color:var(--teal); }
  .btn.primary { background:var(--amber); color:var(--ink); border-color:var(--amber); font-weight:700; }
  main { max-width:1180px; margin:0 auto; padding:24px 16px 80px; display:grid; gap:24px; }
  .card { display:grid; grid-template-columns: minmax(240px, 330px) 1fr; gap:24px; background:var(--panel); border:1px solid var(--line); border-radius:18px; padding:20px; }
  @media (max-width: 760px) { .card { grid-template-columns: 1fr; } }
  video { width:100%; aspect-ratio:9/16; background:#000; border-radius:12px; display:block; }
  .head { display:flex; align-items:flex-start; gap:14px; }
  .score { min-width:58px; text-align:center; border-radius:12px; padding:6px 8px; background:var(--ink); border:1px solid var(--line); }
  .score b { display:block; font-size:24px; line-height:1.1; color:var(--amber); }
  .score span { font-size:11px; color:var(--muted); }
  h2 { margin:0; font-size:20px; line-height:1.25; }
  .meta { color:var(--muted); font-size:13px; margin-top:4px; }
  .reason { margin:14px 0 0; }
  .muted { color:var(--muted); }
  .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; }
  .chip { font-size:12px; padding:3px 9px; border-radius:999px; background:var(--ink); border:1px solid var(--line); color:var(--muted); }
  .chip.warn { color:var(--warn); border-color:rgba(255,122,107,.45); }
  .chip.ok { color:var(--teal); border-color:rgba(63,208,201,.4); }
  .bars { display:grid; grid-template-columns: 90px 1fr 38px; gap:6px 10px; align-items:center; margin-top:14px; font-size:13px; }
  .bar { height:7px; border-radius:4px; background:var(--ink); overflow:hidden; }
  .bar i { display:block; height:100%; background:linear-gradient(90deg, var(--teal), var(--amber)); }
  .tabs { display:flex; gap:6px; margin-top:18px; border-bottom:1px solid var(--line); }
  .tab { background:none; border:0; color:var(--muted); font:inherit; padding:8px 12px; cursor:pointer; border-bottom:2px solid transparent; }
  .tab[aria-selected="true"] { color:var(--text); border-bottom-color:var(--amber); }
  .fields { display:grid; gap:10px; margin-top:14px; }
  label { display:grid; gap:4px; font-size:12px; color:var(--muted); }
  label .count { justify-self:end; }
  input, textarea { width:100%; background:var(--ink); color:var(--text); border:1px solid var(--line); border-radius:10px; padding:9px 11px; font:inherit; }
  textarea { min-height:84px; resize:vertical; }
  input:focus, textarea:focus { outline:none; border-color:var(--teal); }
  .row { display:flex; gap:8px; flex-wrap:wrap; }
  .saved { font-size:12px; color:var(--teal); opacity:0; transition:opacity .3s; }
  .saved.on { opacity:1; }
</style>
</head>
<body>
<header>
  <div><h1>Review shorts</h1><div class="sub">${esc(title)}</div></div>
  <div class="row">
    <button class="btn" id="reset">Ripristina testi originali</button>
    <button class="btn primary" id="export">Esporta JSON</button>
  </div>
</header>
<main id="list"></main>
<script>
const SHORTS = ${data};
const KEY = 'review:' + ${JSON.stringify(title)};
const PLATFORMS = [['youtube','YouTube Shorts'],['instagram','Instagram Reels'],['tiktok','TikTok']];
const LIMITS = { title: 100, description: 500 };
let edits = {};
try { edits = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
const get = (s, p) => (edits[s.id] && edits[s.id][p]) || s.copy[p];
function save() { try { localStorage.setItem(KEY, JSON.stringify(edits)); } catch {} }
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const k of kids) e.append(k); return e; };
const fmt = (t) => Math.floor(t / 60) + ':' + (t % 60).toFixed(1).padStart(4, '0');

function card(s) {
  const right = el('div');
  const head = el('div', { class: 'head' },
    el('div', { class: 'score' }, el('b', {}, String(s.score)), el('span', {}, '/10')),
    el('div', {}, el('h2', {}, s.hook), el('div', { class: 'meta' }, '#' + s.rank + ' · ' + s.id + ' · ' + s.duration.toFixed(1) + ' s · sorgente ' + fmt(s.source.s) + '–' + fmt(s.source.e) + (s.source.segments && s.source.segments.length > 1 ? ' in ' + s.source.segments.length + ' pezzi' : '') + ' · ' + s.layout)));
  right.append(head);
  right.append(el('p', { class: 'reason' }, s.score_reason));
  right.append(el('p', { class: 'muted' }, 'Perché è stato scelto: ' + s.reason));
  const chips = el('div', { class: 'chips' });
  if (s.warnings.length) for (const w of s.warnings) chips.append(el('span', { class: 'chip warn' }, '⚠ ' + w));
  else chips.append(el('span', { class: 'chip ok' }, 'Nessun avviso di policy'));
  for (const l of s.labels.slice(0, 8)) chips.append(el('span', { class: 'chip' }, l));
  right.append(chips);
  const bars = el('div', { class: 'bars' });
  for (const [k, v] of Object.entries(s.signals)) {
    const missing = s.missing.includes(k);
    bars.append(el('span', { class: 'muted' }, k), missing ? el('span', { class: 'muted' }, 'non disponibile') : el('div', { class: 'bar' }, el('i', { style: 'width:' + Math.round(v * 100) + '%' })), el('span', { class: 'muted' }, missing ? '' : v.toFixed(2)));
  }
  right.append(bars);
  right.append(el('div', { class: 'meta' }, s.layoutWhy + ' · ' + s.measures.width + '×' + s.measures.height + ' ' + s.measures.fps + ' fps · ' + s.measures.lufs + ' LUFS · ' + s.measures.truePeak + ' dBTP'));

  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  const fields = el('div', { class: 'fields' });
  const saved = el('span', { class: 'saved' }, 'Salvato');
  function show(p) {
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.p === p));
    fields.replaceChildren();
    const c = get(s, p);
    const update = (patch) => { edits[s.id] = edits[s.id] || {}; edits[s.id][p] = { ...get(s, p), ...patch }; save(); saved.classList.add('on'); clearTimeout(saved.t); saved.t = setTimeout(() => saved.classList.remove('on'), 900); };
    const field = (name, value, multi) => {
      const count = el('span', { class: 'count' }, value.length + '/' + LIMITS[name]);
      const input = multi ? el('textarea', {}) : el('input', {});
      input.value = value;
      input.addEventListener('input', () => { count.textContent = input.value.length + '/' + LIMITS[name]; update({ [name]: input.value }); });
      return el('label', {}, name === 'title' ? 'Titolo' : 'Descrizione', input, count);
    };
    fields.append(field('title', c.title, false), field('description', c.description, true));
    const tags = el('input', {}); tags.value = c.hashtags.join(' ');
    tags.addEventListener('input', () => update({ hashtags: tags.value.split(/\\s+/).filter(Boolean) }));
    const copyBtn = el('button', { class: 'btn', onclick: () => { const x = get(s, p); navigator.clipboard?.writeText(x.title + '\\n\\n' + x.description + '\\n\\n' + x.hashtags.join(' ')); copyBtn.textContent = 'Copiato'; setTimeout(() => (copyBtn.textContent = 'Copia testi'), 1000); } }, 'Copia testi');
    fields.append(el('label', {}, 'Hashtag (separati da spazio)', tags), el('div', { class: 'row' }, copyBtn, saved));
  }
  for (const [p, name] of PLATFORMS) tabs.append(el('button', { class: 'tab', role: 'tab', 'data-p': p, onclick: () => show(p) }, name));
  right.append(tabs, fields);
  show('youtube');

  const video = el('video', { src: s.file, poster: s.thumb, controls: '', loop: '', playsinline: '', preload: 'metadata' });
  return el('section', { class: 'card', id: s.id }, el('div', {}, video), right);
}

const list = document.getElementById('list');
for (const s of SHORTS) list.append(card(s));
document.getElementById('export').addEventListener('click', () => {
  const out = SHORTS.map((s) => ({ id: s.id, file: s.file, hook: s.hook, youtube: get(s, 'youtube'), instagram: get(s, 'instagram'), tiktok: get(s, 'tiktok') }));
  const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' })), download: 'testi-review.json' });
  a.click();
});
document.getElementById('reset').addEventListener('click', () => { edits = {}; save(); location.reload(); });
</script>
</body>
</html>
`;
}
