// Video lungo di notizie (8+ minuti): ricerca allargata → script a capitoli → controllo dei fatti.
//   bun run news research <storia>   testo completo degli articoli, storie collegate, pagine di Wikipedia
//   bun run news long <storia>       script a capitoli (routing news_script) e controllo dei fatti
//                                    (routing news_factcheck); fa la ricerca se manca
// La ricerca sta in data/news/research/, gli script in data/lucio.db (kind 'long') e in data/scripts/.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { db, DATA, now } from '../dashboard/db';
import { ROOT } from '../lib/env';
import { loadPrompt, runTask } from '../lib/llm';
import { route, routeLabel, toLlmTask } from '../lib/routing';
import { articleText, isDirect, type Item, LLM_DIR, outletFromTitle, sourceName, type Story } from './common';

export interface Source {
  url: string;
  title: string;
  kind: 'article' | 'related' | 'background';
  outlet: string;
  date: string | null;
  /** testo dell'articolo se il sito lo dà, altrimenti il sommario del feed */
  text: string;
  full: boolean;
}

export interface Research {
  story_id: number;
  title: string;
  last_seen: string;
  created_at: string;
  sources: Source[];
}

export interface Beat {
  at: string;
  kind: 'trailer' | 'image' | 'photo' | 'card' | 'gameplay' | 'lucio' | 'leak';
  show: string;
  source: string;
  card_text: string;
}

export interface LongScript {
  notes: string;
  angle: string;
  status_of_info: 'confirmed' | 'mixed' | 'rumor';
  titles: string[];
  thumbnails: { text: string; image: string }[];
  chapters: { title: string; voice: string; beats: Beat[] }[];
  facts: { claim: string; source: string }[];
  youtube: { description: string; tags: string[] };
}

export interface FactCheck {
  checks: { i: number; verdict: 'supported' | 'partial' | 'unsupported' | 'no_text'; evidence: string; fix: string }[];
  uncovered: { sentence: string; note: string }[];
}

export interface LongChecks {
  words: number;
  minutes: number;
  problems: string[];
  factcheck: FactCheck;
  factcheck_route: string;
}

/** Parole al minuto della voce: misurate sul video d'esempio (748 parole in 4:40). */
export const WORDS_PER_MIN = 160;
/** Sotto questa soglia lo script si fa riscrivere: dopo i tagli il video scenderebbe sotto gli 8 minuti. */
const MIN_WORDS = 1300;

const RESEARCH_DIR = join(DATA, 'news', 'research');
const WIKI = 'https://en.wikipedia.org/w/api.php';
const WIKI_UA = 'lucio-pipeline/1.0 (local news research script)';
/** Pagina di sfondo sempre presente: il canale parla solo di GTA 6. */
const WIKI_ALWAYS = 'Grand Theft Auto VI';

// ───────── ricerca ─────────

/** Si rifà se la storia ha ricevuto articoli nuovi o con force. */
export async function research(storyId: number, force = false): Promise<Research> {
  const s = db.query(`SELECT * FROM stories WHERE id = ?`).get(storyId) as Story | null;
  if (!s) throw new Error(`storia ${storyId} non trovata`);
  const path = join(RESEARCH_DIR, `story-${storyId}.json`);
  if (!force && existsSync(path)) {
    const r = (await Bun.file(path).json()) as Research;
    if (r.last_seen === s.last_seen) return r;
  }

  const sources: Source[] = [];
  for (const it of withoutDuplicates(storyItems(storyId))) sources.push(await fromItem(it, 'article', 8000));
  for (const rel of relatedStories(s)) {
    // Delle storie collegate basta un articolo intero; gli altri restano col sommario.
    let full = false;
    for (const it of withoutDuplicates(storyItems(rel.id)).slice(0, 3)) {
      const src = await fromItem(it, 'related', full ? 0 : 4000);
      full ||= src.full;
      sources.push(src);
    }
  }
  const articles = sources.filter((x) => x.kind === 'article').map((x) => `${x.title}\n${x.text}`).join('\n');
  let pages = 0;
  for (const title of await wikiTitles(articles)) {
    if (pages >= 4) break;
    const page = await wikiText(title);
    // Un nome può portare a una pagina estranea (le serie TV del curriculum dell'attrice).
    if (!page || (title !== WIKI_ALWAYS && !/grand theft auto|rockstar games/i.test(page))) continue;
    pages++;
    const text = page.slice(0, title === WIKI_ALWAYS ? 30_000 : 8000);
    sources.push({ url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`, title: `Wikipedia: ${title}`, kind: 'background', outlet: 'Wikipedia', date: null, text, full: true });
  }

  const r: Research = { story_id: storyId, title: s.title, last_seen: s.last_seen, created_at: now(), sources };
  mkdirSync(RESEARCH_DIR, { recursive: true });
  await Bun.write(path, JSON.stringify(r, null, 2));
  await Bun.write(join(RESEARCH_DIR, `story-${storyId}.md`), researchMarkdown(r));
  return r;
}

function storyItems(storyId: number): Item[] {
  return db.query(`SELECT * FROM news_items WHERE story_id = ? ORDER BY COALESCE(published_at, fetched_at) DESC`).all(storyId) as Item[];
}

/** La stessa testata arriva sia dal suo feed sia da Google News: si tiene il link diretto. */
function withoutDuplicates(items: Item[]): Item[] {
  const direct = new Set(items.filter((it) => isDirect(it.url)).map((it) => outletKey(sourceName(it.source))));
  return items.filter((it) => isDirect(it.url) || !direct.has(outletKey(outletFromTitle(it))));
}

const outletKey = (s: string) => s.replace(/[()\s]/g, '').replace(/\.com$/i, '').toLowerCase();

async function fromItem(it: Item, kind: Source['kind'], max: number): Promise<Source> {
  const text = max > 0 && isDirect(it.url) ? await articleText(it.url, max) : '';
  const summary = it.summary ?? '';
  const full = text.length > summary.length;
  const outlet = it.source === 'google-news' ? outletFromTitle(it).replace(/[()]/g, '').trim() || 'Google News' : sourceName(it.source);
  return { url: it.url, title: it.title, kind, outlet, date: it.published_at, text: full ? text : summary, full };
}

/**
 * Storie che condividono con questa una parola rara del titolo (un nome, un luogo, un evento):
 * "Lucia" lega l'attrice al processo del leaker. Le parole presenti in molte storie su GTA 6 non
 * contano. Gli embedding qui non aiutano: per loro le notizie su GTA 6 si somigliano tutte.
 */
function relatedStories(s: Story, max = 4): Story[] {
  const all = db.query(`SELECT * FROM stories WHERE id != ? AND status != 'scartata'`).all(s.id) as Story[];
  const words = (t: string) => new Set(t.toLowerCase().match(/[a-z][a-z'’]{3,}/g) ?? []);
  const df = new Map<string, number>();
  for (const x of all) for (const w of words(x.title)) df.set(w, (df.get(w) ?? 0) + 1);
  const limit = Math.max(2, Math.round(all.length * 0.03));
  const rare = new Set([...words(s.title)].filter((w) => (df.get(w) ?? 0) > 0 && df.get(w)! <= limit));
  return all
    .map((x) => ({ x, n: [...words(x.title)].filter((w) => rare.has(w)).length }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n || b.x.last_seen.localeCompare(a.x.last_seen))
    .slice(0, max)
    .map((r) => r.x);
}

/** Nomi che hanno già una pagina di sfondo o che non servono a trovarne una. */
const GENERIC_NAMES = /^(the )?(gta|grand theft auto|rockstar|take-two|playstation|xbox|vice city|leonida|game of the year)/i;

/**
 * GTA VI sempre, più le pagine dei nomi propri che tornano negli articoli della storia
 * ("Manni L. Perez", "The Game Awards"). La ricerca di Wikipedia sul titolo intero restituisce
 * pagine a caso; il titolo esatto di un nome ripetuto è molto più affidabile. Una sola richiesta
 * risolve tutti i nomi (redirect compresi).
 */
async function wikiTitles(articles: string): Promise<string[]> {
  const counts = new Map<string, number>();
  for (const m of articles.matchAll(/\b(?:The )?[A-Z][a-z]+(?:\s+(?:[A-Z]\.|[A-Z][a-z]+)){1,3}\b/g)) {
    if (!GENERIC_NAMES.test(m[0])) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  const names = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name]) => name);
  const out = [WIKI_ALWAYS];
  if (!names.length) return out;
  type Q = { query?: { normalized?: { from: string; to: string }[]; redirects?: { from: string; to: string }[]; pages?: Record<string, { title: string; missing?: string }> } };
  const d = await wikiGet<Q>(`action=query&titles=${encodeURIComponent(names.join('|'))}&redirects=1&format=json`);
  const found = new Set(Object.values(d?.query?.pages ?? {}).filter((p) => p.missing === undefined).map((p) => p.title));
  const resolve = (t: string) => {
    for (const step of [d?.query?.normalized, d?.query?.redirects]) t = step?.find((x) => x.from === t)?.to ?? t;
    return t;
  };
  // nell'ordine di frequenza dei nomi
  for (const name of names) {
    const t = resolve(name);
    if (found.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

const WIKI_CACHE = join(DATA, 'news', 'wiki-cache');

async function wikiText(title: string): Promise<string> {
  // Le pagine cambiano poco: si rileggono dopo un giorno. Wikipedia limita le richieste anonime.
  const cache = join(WIKI_CACHE, `${title.replace(/[^\w.-]+/g, '_')}.txt`);
  const f = Bun.file(cache);
  if ((await f.exists()) && Date.now() - f.lastModified < 86_400_000) return f.text();
  const d = await wikiGet<{ query?: { pages?: Record<string, { extract?: string }> } }>(`action=query&prop=extracts&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}&format=json`);
  const text = (Object.values(d?.query?.pages ?? {})[0]?.extract ?? '')
    .split(/\n==\s*(?:Notes|References|External links|See also|Further reading|Citations|Sources)\s*==/)[0]!
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text) {
    mkdirSync(WIKI_CACHE, { recursive: true });
    await Bun.write(cache, text);
  }
  return text;
}

/** Una richiesta all'API di Wikipedia; dopo un 429 aspetta quanto chiede il server (al massimo 30 s) e riprova una volta. */
async function wikiGet<T>(query: string): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${WIKI}?${query}`, { headers: { 'User-Agent': WIKI_UA }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 && attempt === 0) {
        const wait = Math.min(30, Number(res.headers.get('retry-after')) || 10);
        console.log(`  Wikipedia: troppe richieste, riprovo tra ${wait} s`);
        await Bun.sleep(wait * 1000);
        continue;
      }
      if (!res.ok) {
        console.log(`  Wikipedia: HTTP ${res.status}, vado avanti senza`);
        return null;
      }
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
  return null;
}

export function researchMarkdown(r: Research): string {
  const section = (kind: Source['kind'], heading: string) => {
    const list = r.sources.filter((x) => x.kind === kind);
    if (!list.length) return [];
    return [
      `## ${heading}`,
      '',
      ...list.flatMap((x) => [`### ${x.title}`, `${x.outlet} · ${x.date?.slice(0, 10) ?? 'no date'} · ${x.url} · ${x.full ? 'full text' : 'feed summary only'}`, '', x.text || '(no text)', '']),
    ];
  };
  return [
    `# Research pack: ${r.title}`,
    '',
    `Today: ${r.created_at.slice(0, 10)}.`,
    '',
    ...section('article', 'Articles about this story'),
    ...section('related', 'Related stories from the last days'),
    ...section('background', 'Background'),
  ].join('\n');
}

// ───────── script ─────────

export async function writeLongScript(storyId: number): Promise<number> {
  const s = db.query(`SELECT * FROM stories WHERE id = ?`).get(storyId) as Story | null;
  if (!s) throw new Error(`storia ${storyId} non trovata`);
  const r = await research(storyId);
  const pack = researchMarkdown(r);
  console.log(`  ricerca: ${r.sources.length} fonti (${r.sources.filter((x) => x.full).length} con il testo intero), ${Math.round(pack.length / 1000)} mila caratteri`);

  const rt = await route('news_script');
  const { system, schema } = await loadPrompt('news-long');
  const guide = await Bun.file(join(ROOT, 'style', 'CHANNEL.md')).text();
  const sys = `${system}\n\n---\n\n# Channel voice guide\n\n${guide}`;
  const task = toLlmTask(rt, { think: false, temperature: 0.6, timeout_s: 1800 });
  const n = (db.query(`SELECT COUNT(*) AS n FROM scripts WHERE story_id = ? AND kind = 'long'`).get(storyId) as { n: number }).n + 1;
  const dir = join(LLM_DIR, `long-${storyId}-v${n}`);
  let out = await runTask<LongScript>(dir, task, sys, pack, schema);
  let cost = await costOf(dir);
  let words = countWords(out);
  // Troppo corto: un secondo giro che conosce il conteggio, invece di allungarlo a mano.
  if (words < MIN_WORDS) {
    console.log(`  script di ${words} parole, sotto le ${MIN_WORDS}: lo faccio riscrivere più lungo`);
    const again = `${dir}-longer`;
    out = await runTask<LongScript>(again, task, sys, `${pack}\n\n---\n\nA first draft had only ${words} words of voice-over. Write the whole script again with 1,500–1,700 words, adding substance from the pack, not filler.`, schema);
    cost += await costOf(again);
    words = countWords(out);
  }

  const frt = await route('news_factcheck');
  const factcheck = await factCheck(join(dir, 'factcheck'), frt, out, r);
  cost += await costOf(join(dir, 'factcheck'));
  const checks: LongChecks = { words, minutes: Math.round((words / WORDS_PER_MIN) * 10) / 10, problems: lint(out, r), factcheck, factcheck_route: routeLabel(frt) };

  const row = db
    .query(`INSERT INTO scripts (story_id, created_at, route, content, cost_usd, kind, checks) VALUES (?, ?, ?, ?, ?, 'long', ?) RETURNING id`)
    .get(storyId, now(), routeLabel(rt), JSON.stringify(out), cost || null, JSON.stringify(checks)) as { id: number };
  db.run(`UPDATE stories SET status = 'scritta' WHERE id = ?`, [storyId]);
  mkdirSync(join(DATA, 'scripts'), { recursive: true });
  await Bun.write(join(DATA, 'scripts', `story-${storyId}-long-v${n}.md`), longScriptMarkdown(s.title, out, checks));

  const bad = factcheck.checks.filter((c) => c.verdict !== 'supported').length;
  console.log(`  ${words} parole (circa ${checks.minutes} min), ${out.chapters.length} capitoli, ${out.chapters.reduce((a, c) => a + c.beats.length, 0)} scene, ${out.facts.length} fatti (${bad} da guardare), ${checks.problems.length} problemi`);
  return row.id;
}

async function costOf(dir: string): Promise<number> {
  const f = Bun.file(join(dir, 'meta.json'));
  return (await f.exists()) ? (((await f.json()) as { cost_usd?: number }).cost_usd ?? 0) : 0;
}

export const countWords = (s: Pick<LongScript, 'chapters'>) => s.chapters.reduce((a, c) => a + c.voice.split(/\s+/).filter(Boolean).length, 0);

const normText = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Controlli senza modello: ancoraggi delle scene, fonti fuori dalla ricerca, cartelli vuoti, capitoli sbilanciati. */
function lint(s: LongScript, r: Research): string[] {
  const out: string[] = [];
  const urls = new Set(r.sources.map((x) => x.url));
  for (const [ci, c] of s.chapters.entries()) {
    const voice = normText(c.voice);
    for (const b of c.beats) {
      if (!voice.includes(normText(b.at))) out.push(`capitolo ${ci + 1}: la scena "${b.at}" non si trova nel testo`);
      if (b.kind === 'card' && !b.card_text.trim()) out.push(`capitolo ${ci + 1}: cartello senza testo ("${b.at}")`);
    }
    const w = c.voice.split(/\s+/).filter(Boolean).length;
    if (ci > 0 && w > 400) out.push(`capitolo ${ci + 1} "${c.title}": ${w} parole, conviene dividerlo`);
  }
  for (const f of s.facts) if (!urls.has(f.source)) out.push(`fonte fuori dalla ricerca: ${f.source} ("${f.claim.slice(0, 60)}…")`);
  return out;
}

// ───────── controllo dei fatti ─────────

async function factCheck(dir: string, rt: Awaited<ReturnType<typeof route>>, s: LongScript, r: Research): Promise<FactCheck> {
  const { system, schema } = await loadPrompt('news-factcheck');
  const cited = new Set(s.facts.map((f) => f.source));
  const input = [
    '## Claims',
    ...s.facts.map((f, i) => `${i + 1}. ${f.claim}\n   Source: ${f.source}`),
    '',
    '## Sources',
    ...r.sources.filter((x) => cited.has(x.url)).flatMap((x) => [`### ${x.url}`, `${x.title} (${x.full ? 'full text' : 'feed summary only'})`, x.text, '']),
    '## Voice-over',
    s.chapters.map((c) => c.voice).join('\n\n'),
  ].join('\n');
  return runTask<FactCheck>(dir, toLlmTask(rt, { think: false, temperature: 0, timeout_s: 900 }), system, input, schema);
}

// ───────── markdown ─────────

const VERDICT: Record<string, string> = { supported: 'ok', partial: 'in parte', unsupported: 'NON CONFERMATO', no_text: 'fonte non leggibile' };

export function longScriptMarkdown(title: string, s: LongScript, checks?: LongChecks | null): string {
  const verdict = (i: number) => checks?.factcheck.checks.find((c) => c.i === i);
  return [
    `# ${title} (video lungo)`,
    '',
    `**Stato delle informazioni:** ${s.status_of_info}  `,
    `**Perché ora:** ${s.angle}  `,
    checks ? `**Lunghezza:** ${checks.words} parole, circa ${checks.minutes} minuti` : '',
    '',
    '## Titoli',
    '',
    ...s.titles.map((t) => `- ${t}`),
    '',
    '## Miniature',
    '',
    ...s.thumbnails.map((t) => `- **${t.text}** — ${t.image}`),
    '',
    ...s.chapters.flatMap((c, i) => [
      `## ${i + 1}. ${c.title}`,
      '',
      c.voice,
      '',
      ...c.beats.map((b) => `- *${b.at}…* → **${b.kind}**: ${b.show}${b.card_text ? ` — «${b.card_text}»` : ''}${b.source ? ` (${b.source})` : ''}`),
      '',
    ]),
    '## Fonti',
    '',
    ...s.facts.map((f, i) => {
      const v = verdict(i + 1);
      return `${i + 1}. ${f.claim} — ${f.source}${v ? ` — **${VERDICT[v.verdict] ?? v.verdict}**${v.fix ? `: ${v.fix}` : ''}` : ''}`;
    }),
    '',
    ...(checks?.factcheck.uncovered.length ? ['## Frasi senza fonte', '', ...checks.factcheck.uncovered.map((u) => `- "${u.sentence}" — ${u.note}`), ''] : []),
    ...(checks?.problems.length ? ['## Problemi', '', ...checks.problems.map((p) => `- ${p}`), ''] : []),
    '## YouTube',
    '',
    s.youtube.description,
    '',
    s.youtube.tags.join(', '),
    '',
  ].join('\n');
}
