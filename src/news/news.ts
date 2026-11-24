// bun run news fetch | cluster | triage | script <storia> | research <storia> | long <storia> | media sync | media add <file> <id> | assets <script> | leaks "<descrizione>" | all
//
// Notizie su GTA 6 → script per short di notizie e per video lunghi (long.ts).
//   fetch    legge i feed di config/news.json e salva le notizie nuove (senza doppioni)
//   cluster  raggruppa la stessa notizia ripresa da più siti in una storia (embedding di LM Studio)
//   triage   smista le storie (routing news_triage, di solito Clef): riguarda GTA 6? ufficiale o rumor?
//            quanto interessa? è acchiappaclic? serve materiale protetto?
//   script   scrive lo script di una storia (routing news_script, di solito Claude)
//   research raccoglie le fonti per il video lungo (articoli interi, storie collegate, Wikipedia)
//   long     scrive lo script del video lungo e ne controlla i fatti
//   media    libreria dei video ufficiali di GTA VI (media.ts): `media sync` scarica e cataloga
//   assets   sceglie i materiali per ogni scena di uno script lungo (assets.ts), leak compresi
//   leaks    cerca, scarica e cataloga i leak per una descrizione (leaks.ts)
//   montage  renderizza il video del montaggio in 4K per OBS (montage.ts); --frames a-b per una prova
// I dati stanno in data/lucio.db, gli script anche in data/scripts/.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { db, DATA, now } from '../dashboard/db';
import { ROOT } from '../lib/env';
import { llm, loadPrompt, runTask } from '../lib/llm';
import { route, routeLabel, toLlmTask } from '../lib/routing';
import { articleText, cleanText, config, isDirect, type Item, LLM_DIR, outletFromTitle, sourceName, type Story, UA } from './common';
import { buildAssets } from './assets';
import { findLeaks } from './leaks';
import { buildMontage } from './montage';
import { research, writeLongScript } from './long';
import { addLocalVideo, syncMedia, upgradeMedia } from './media';

// ───────── fetch ─────────

export async function fetchNews(): Promise<number> {
  const insert = db.query(
    `INSERT OR IGNORE INTO news_items (source, guid, url, title, summary, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const required = config.require.map((w) => w.toLowerCase());
  const oldest = Date.now() - config.max_age_days * 86_400_000;
  let added = 0;
  for (const src of config.sources) {
    try {
      const res = await fetch(src.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseFeed(await res.text());
      let n = 0;
      for (const it of items) {
        if (src.filter && !required.some((w) => `${it.title} ${it.summary}`.toLowerCase().includes(w.toLowerCase()))) continue;
        // I feed (YouTube soprattutto) ripropongono anche cose vecchie di mesi.
        if (it.date && Date.parse(it.date) < oldest) continue;
        n += insert.run(src.id, it.guid, it.link, it.title, it.summary.slice(0, 2000), it.date, now()).changes;
      }
      added += n;
      console.log(`  ${src.name}: ${items.length} nel feed, ${n} nuove`);
    } catch (e) {
      console.log(`  ${src.name}: non raggiungibile (${(e as Error).message})`);
    }
  }
  return added;
}

/** RSS 2.0 e Atom, quanto basta per titolo, link, id, data e sommario. */
export function parseFeed(xml: string) {
  return [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)].map((m) => {
    const b = m[0];
    const link = tag(b, 'link') || b.match(/<link\b[^>]*rel="alternate"[^>]*href="([^"]+)"/)?.[1] || b.match(/<link\b[^>]*href="([^"]+)"/)?.[1] || '';
    const date = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const parsed = date ? new Date(date) : null;
    return {
      title: tag(b, 'title'),
      link,
      guid: tag(b, 'guid') || tag(b, 'id') || link,
      date: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
      summary: tag(b, 'description') || tag(b, 'summary') || tag(b, 'media:description') || tag(b, 'content:encoded') || tag(b, 'content'),
    };
  }).filter((x) => x.title && x.link);
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? cleanText(m[1]!) : '';
}

/** Toglie le notizie più vecchie di max_age_days e le storie rimaste vuote. */
export function pruneNews(): number {
  const oldest = new Date(Date.now() - config.max_age_days * 86_400_000).toISOString();
  const n = db.run(`DELETE FROM news_items WHERE published_at IS NOT NULL AND published_at < ?`, [oldest]).changes;
  db.run(`DELETE FROM stories WHERE id NOT IN (SELECT DISTINCT story_id FROM news_items WHERE story_id IS NOT NULL) AND id NOT IN (SELECT story_id FROM scripts)`);
  db.run(`UPDATE stories SET items = (SELECT COUNT(*) FROM news_items WHERE story_id = stories.id),
          last_seen = COALESCE((SELECT MAX(COALESCE(published_at, fetched_at)) FROM news_items WHERE story_id = stories.id), last_seen)`);
  return n;
}

// ───────── cluster ─────────

export async function clusterNews(): Promise<{ items: number; stories: number }> {
  const pending = db.query(`SELECT * FROM news_items WHERE story_id IS NULL ORDER BY COALESCE(published_at, fetched_at)`).all() as Item[];
  if (!pending.length) return { items: 0, stories: 0 };
  // nomic-embed vuole il prefisso del compito.
  const texts = pending.map((it) => `clustering: ${it.title}. ${(it.summary ?? '').slice(0, 300)}`);
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const dir = join(LLM_DIR, `embed-${Date.now()}-${i}`);
    const out = await runTask<{ vectors: number[][] }>(dir, { backend: 'embed', model: config.embedding_model }, '', JSON.stringify(texts.slice(i, i + 64)), {});
    vectors.push(...out.vectors.map(normalize));
  }
  // Collegamento completo: una notizia entra in una storia solo se somiglia a TUTTE le sue notizie.
  // Con la media (centroide) i titoli su GTA 6, tutti simili tra loro, finivano in un'unica storia.
  const since = new Date(Date.now() - config.story_window_hours * 3600_000).toISOString();
  const stories = (db.query(`SELECT * FROM stories WHERE last_seen >= ?`).all(since) as Story[]).map((s) => ({
    ...s,
    members: (db.query(`SELECT embedding FROM news_items WHERE story_id = ? AND embedding IS NOT NULL`).all(s.id) as { embedding: Uint8Array }[]).map((r) => toVec(r.embedding)),
  }));
  let created = 0;
  for (const [i, it] of pending.entries()) {
    const v = vectors[i]!;
    let best: (typeof stories)[number] | undefined;
    let sim = 0;
    for (const s of stories) {
      if (!s.members.length) continue;
      const x = Math.min(...s.members.map((m) => dot(m, v)));
      if (x > sim) [best, sim] = [s, x];
    }
    const seen = it.published_at ?? now();
    if (best && sim >= config.same_story_similarity) {
      best.members.push(v);
      best.items += 1;
      best.last_seen = seen > best.last_seen ? seen : best.last_seen;
      db.run(`UPDATE stories SET items = ?, last_seen = ? WHERE id = ?`, [best.items, best.last_seen, best.id]);
      db.run(`UPDATE news_items SET story_id = ?, embedding = ? WHERE id = ?`, [best.id, toBlob(v), it.id]);
    } else {
      const s = db.query(`INSERT INTO stories (title, first_seen, last_seen, items) VALUES (?, ?, ?, 1) RETURNING *`).get(it.title, seen, seen) as Story;
      stories.push({ ...s, members: [v] });
      db.run(`UPDATE news_items SET story_id = ?, embedding = ? WHERE id = ?`, [s.id, toBlob(v), it.id]);
      created++;
    }
  }
  return { items: pending.length, stories: created };
}

const normalize = (v: number[]) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const toBlob = (v: number[]) => new Uint8Array(new Float32Array(v).buffer);
const toVec = (b: Uint8Array) => [...new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))];

// ───────── triage ─────────

const TRIAGE_Q = {
  about_gta6: { type: 'noul', instructions: 'Is this story about GTA 6 (Grand Theft Auto VI) or directly about its release?' },
  kind: {
    type: 'choice',
    instructions: 'What kind of story is it?',
    criteria: {
      official: 'Official announcement or information from Rockstar or Take-Two',
      leak: 'Leaked material or insider claims',
      rumor: 'Rumor or speculation',
      analysis: 'Analysis, theory, review or discussion',
      community: 'Community content: fan art, mods, memes, creators',
      business: 'Sales, stock, business or industry news',
      other: 'Something else',
    },
  },
  interest: { type: 'score', instructions: 'How interesting is this story for GTA fans today?', criteria: ['no one cares', 'niche', 'interesting for fans', 'big news for fans', 'huge, everyone will talk about it'] },
  clickbait: { type: 'noul', instructions: 'Are the headlines clickbait or exaggerated compared to what is actually known?' },
  copyright_risk: { type: 'noul', instructions: 'Would covering this story require showing leaked footage or other material that could get a video taken down?' },
};

export async function triageNews(force = false): Promise<number> {
  const r = await route('news_triage');
  const stories = db.query(`SELECT * FROM stories WHERE status != 'scartata'`).all() as Story[];
  let n = 0;
  for (const s of stories) {
    const prev = s.triage ? (JSON.parse(s.triage) as { items_at?: number; route?: string }) : null;
    if (!force && prev && prev.items_at === s.items && prev.route === routeLabel(r)) continue;
    const items = db.query(`SELECT * FROM news_items WHERE story_id = ? ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT 8`).all(s.id) as Item[];
    const state = `A news story with ${s.items} articles:\n${items.map((it) => `- [${sourceName(it.source)}, ${it.published_at?.slice(0, 10) ?? 'no date'}] ${it.title}${it.summary ? ` — ${it.summary.slice(0, 300)}` : ''}`).join('\n')}`;
    const dir = join(LLM_DIR, `triage-${s.id}-${s.items}`);
    const t = await decideOrAsk(dir, r, state);
    const score = t.about_gta6 * (t.interest / 4) * (1 - 0.4 * t.clickbait) * freshness(s.last_seen);
    db.run(`UPDATE stories SET triage = ?, score = ? WHERE id = ?`, [JSON.stringify({ ...t, items_at: s.items, route: routeLabel(r) }), Math.round(score * 1000) / 1000, s.id]);
    n++;
  }
  return n;
}

/** 1 per una notizia di adesso, 0,5 dopo score_half_life_hours, e così via. */
function freshness(lastSeen: string): number {
  const hours = Math.max(0, (Date.now() - Date.parse(lastSeen)) / 3_600_000);
  return 0.5 ** (hours / config.score_half_life_hours);
}

/** Ricalcola solo la freschezza dei punteggi, senza rifare lo smistamento. */
export function refreshScores(): void {
  for (const s of db.query(`SELECT id, last_seen, triage FROM stories WHERE triage IS NOT NULL`).all() as Story[]) {
    const t = JSON.parse(s.triage!) as Triage;
    db.run(`UPDATE stories SET score = ? WHERE id = ?`, [Math.round(t.about_gta6 * (t.interest / 4) * (1 - 0.4 * t.clickbait) * freshness(s.last_seen) * 1000) / 1000, s.id]);
  }
}

interface Triage {
  about_gta6: number;
  kind: string;
  kind_probs?: Record<string, number>;
  interest: number;
  clickbait: number;
  copyright_risk: number;
}

/**
 * Con Clef si ottengono probabilità; con un modello che scrive (Claude o locale) le stesse domande
 * diventano un JSON Schema e le risposte valgono 0 o 1.
 */
async function decideOrAsk(dir: string, r: Awaited<ReturnType<typeof route>>, state: string): Promise<Triage> {
  if (r.provider === 'clef') {
    type A = Record<string, { noul?: number; choice?: string; probabilities?: Record<string, number>; score?: number }>;
    const a = await runTask<A>(dir, toLlmTask(r), '', state, TRIAGE_Q);
    return {
      about_gta6: a.about_gta6!.noul!,
      kind: a.kind!.choice!,
      kind_probs: a.kind!.probabilities,
      interest: a.interest!.score!,
      clickbait: a.clickbait!.noul!,
      copyright_risk: a.copyright_risk!.noul!,
    };
  }
  const schema = {
    type: 'object',
    properties: {
      about_gta6: { type: 'boolean' },
      kind: { type: 'string', enum: Object.keys(TRIAGE_Q.kind.criteria) },
      interest: { type: 'integer', minimum: 0, maximum: 4 },
      clickbait: { type: 'boolean' },
      copyright_risk: { type: 'boolean' },
    },
    required: ['about_gta6', 'kind', 'interest', 'clickbait', 'copyright_risk'],
    additionalProperties: false,
  };
  const system = `You triage news stories for a GTA 6 channel. Answer each question about the story.\n${Object.entries(TRIAGE_Q)
    .map(([k, q]) => `- ${k}: ${q.instructions}${'criteria' in q ? ` Options: ${JSON.stringify(q.criteria)}` : ''}`)
    .join('\n')}\ninterest is the index of the option (0 = no one cares … 4 = huge).`;
  const a = await runTask<{ about_gta6: boolean; kind: string; interest: number; clickbait: boolean; copyright_risk: boolean }>(dir, toLlmTask(r, { think: false, temperature: 0.1 }), system, state, schema);
  return { about_gta6: Number(a.about_gta6), kind: a.kind, interest: a.interest, clickbait: Number(a.clickbait), copyright_risk: Number(a.copyright_risk) };
}

// ───────── script ─────────

export async function writeScript(storyId: number): Promise<number> {
  const s = db.query(`SELECT * FROM stories WHERE id = ?`).get(storyId) as Story | null;
  if (!s) throw new Error(`storia ${storyId} non trovata`);
  const items = db.query(`SELECT * FROM news_items WHERE story_id = ? ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT 10`).all(storyId) as Item[];
  // Testo degli articoli: solo link diretti (Google News e YouTube non danno l'articolo), al massimo 3.
  const direct = items.filter((it) => isDirect(it.url)).slice(0, 3);
  const texts = new Map<number, string>();
  for (const it of direct) {
    const t = await articleText(it.url);
    if (t) texts.set(it.id, t);
  }
  const input = [
    `Story: ${s.title}`,
    `Articles (${items.length}):`,
    ...items.map((it) => {
      const head = `### ${it.title}\nOutlet: ${sourceName(it.source)}${outletFromTitle(it)} · ${it.published_at?.slice(0, 10) ?? 'no date'} · ${it.url}`;
      const body = texts.get(it.id) ?? it.summary ?? '';
      return `${head}\n${body.slice(0, 5000)}`;
    }),
  ].join('\n\n');

  const r = await route('news_script');
  const { system, schema } = await loadPrompt('news-script');
  const guide = await Bun.file(join(ROOT, 'style', 'CHANNEL.md')).text();
  const n = (db.query(`SELECT COUNT(*) AS n FROM scripts WHERE story_id = ?`).get(storyId) as { n: number }).n + 1;
  const dir = join(LLM_DIR, `script-${storyId}-v${n}`);
  const out = await runTask<Record<string, unknown>>(dir, toLlmTask(r, { think: false, temperature: 0.6, timeout_s: 600 }), `${system}\n\n---\n\n# Channel voice guide\n\n${guide}`, input, schema);
  const meta = (await Bun.file(join(dir, 'meta.json')).json()) as { cost_usd?: number };
  const row = db.query(`INSERT INTO scripts (story_id, created_at, route, content, cost_usd) VALUES (?, ?, ?, ?, ?) RETURNING id`).get(storyId, now(), routeLabel(r), JSON.stringify(out), meta.cost_usd ?? null) as { id: number };
  db.run(`UPDATE stories SET status = 'scritta' WHERE id = ?`, [storyId]);
  mkdirSync(join(DATA, 'scripts'), { recursive: true });
  await Bun.write(join(DATA, 'scripts', `story-${storyId}-v${n}.md`), scriptMarkdown(s.title, out));
  return row.id;
}

export function scriptMarkdown(title: string, s: Record<string, unknown>): string {
  const facts = (s.facts as { claim: string; source: string }[] | undefined) ?? [];
  const beats = (s.on_screen as string[] | undefined) ?? [];
  const p = (k: string) => s[k] as { title: string; description: string; hashtags: string[] } | undefined;
  return [
    `# ${title}`,
    '',
    `**Gancio:** ${s.hook}  `,
    `**Stato delle informazioni:** ${s.status_of_info}  `,
    `**Perché ora:** ${s.angle}`,
    '',
    '## Voce',
    '',
    String(s.script ?? ''),
    '',
    '## A schermo',
    '',
    ...beats.map((b, i) => `${i + 1}. ${b}`),
    '',
    '## Fonti',
    '',
    ...facts.map((f) => `- ${f.claim} — ${f.source}`),
    '',
    '## Testi',
    '',
    ...['youtube', 'instagram', 'tiktok'].map((k) => `**${k}:** ${p(k)?.title}\n\n${p(k)?.description}\n\n${p(k)?.hashtags.join(' ')}\n`),
  ].join('\n');
}

// ───────── comando ─────────

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  const t0 = performance.now();
  if (cmd === 'fetch' || cmd === 'all') {
    console.log(`Notizie nuove: ${await fetchNews()}`);
    console.log(`Notizie troppo vecchie tolte: ${pruneNews()}`);
  }
  if (cmd === 'cluster' || cmd === 'all') {
    const c = await clusterNews();
    console.log(`Raggruppate ${c.items} notizie, ${c.stories} storie nuove`);
  }
  if (cmd === 'triage' || cmd === 'all') {
    console.log(`Storie smistate: ${await triageNews(arg === '--force')}`);
    refreshScores();
  }
  if (cmd === 'script') {
    if (!arg) throw new Error('uso: bun run news script <id storia>');
    console.log(`Script ${await writeScript(Number(arg))} scritto`);
  }
  if (cmd === 'research') {
    if (!arg) throw new Error('uso: bun run news research <id storia>');
    const r = await research(Number(arg), true);
    for (const x of r.sources) console.log(`  ${x.kind.padEnd(10)} ${x.full ? 'intero ' : 'sommario'} ${String(x.text.length).padStart(6)}  ${x.outlet}: ${x.title.slice(0, 80)}`);
    console.log(`Ricerca in data/news/research/story-${arg}.md`);
  }
  if (cmd === 'long') {
    if (!arg) throw new Error('uso: bun run news long <id storia>');
    console.log(`Script lungo ${await writeLongScript(Number(arg))} scritto`);
  }
  if (cmd === 'media') {
    const [, , file, id] = process.argv.slice(2);
    if (arg === 'sync') await syncMedia();
    else if (arg === 'upgrade') await upgradeMedia();
    else if (arg === 'add' && file && id) await addLocalVideo(file, id);
    else throw new Error('uso: bun run news media sync | media upgrade | media add <file> <id YouTube>');
  }
  if (cmd === 'leaks') {
    if (!arg) throw new Error('uso: bun run news leaks "<cosa deve vedersi>"');
    const [r] = await findLeaks(join(LLM_DIR, 'leaks', `${Date.now()}`), [{ show: arg, context: '' }]);
    console.log(r?.videos.length ? `Leak in libreria: ${r.videos.join(', ')}` : `Nessun leak trovato${r?.note ? `: ${r.note}` : ''}`);
  }
  if (cmd === 'montage') {
    if (!arg) throw new Error('uso: bun run news montage <id script> [--frames 0-899]');
    const i = process.argv.indexOf('--frames');
    const { video } = await buildMontage(Number(arg), { frames: i > 0 ? process.argv[i + 1] : undefined });
    console.log(`Montaggio: ${video}`);
  }
  if (cmd === 'assets') {
    if (!arg) throw new Error('uso: bun run news assets <id script>');
    await buildAssets(Number(arg));
  }
  // Libera la memoria: modello di embedding, Clef e modelli locali accesi da questo comando.
  if (['cluster', 'triage', 'script', 'long', 'all'].includes(cmd ?? '')) await llm(['down']);
  if (!['fetch', 'cluster', 'triage', 'script', 'research', 'long', 'media', 'assets', 'leaks', 'montage', 'all'].includes(cmd ?? '')) {
    console.error('uso: bun run news fetch | cluster | triage [--force] | script <id storia> | research <id storia> | long <id storia> | media sync | media add <file> <id YouTube> | assets <id script> | leaks "<descrizione>" | montage <id script> | all');
    process.exit(2);
  }
  console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}
