// bun scripts/factcheck-ab.ts
//
// Prova A/B del controllo dei fatti: Clef-Flash in locale (src/news/verify.ts) contro Haiku (prompt
// news-factcheck), sullo script lungo della storia 91 (riga 3 di scripts in data/lucio.db).
//   1. Clef sui 41 fatti veri, contro i verdetti di Haiku già salvati con lo script (tutti "supported")
//   2. 10 copie dei fatti con un errore messo apposta (numero, data, nome, testata, voce data per certa):
//      Clef su ognuna; Haiku in una sola chiamata con le 10 copie mescolate ai 31 fatti veri rimasti, come
//      nel controllo vero (gli originali delle copie restano fuori, se no Haiku li confronta tra loro)
//   3. fonti lunghe: le affermazioni sulla pagina di Wikipedia rifatte a finestre da 8.000 caratteri
// Stampa il confronto e salva tutto in data/news/factcheck-ab/story-91.json. Clef si accende all'inizio
// e si spegne alla fine; le risposte restano nelle cartelle dei compiti e si riusano.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/lib/env';
import { llm, loadPrompt, runTask } from '../src/lib/llm';
import { type Route, routeLabel, toLlmTask } from '../src/lib/routing';
import type { FactCheck, LongChecks, LongScript, Research, Source } from '../src/news/long';
import { type ClaimToVerify, type Verification, verifyClaims } from '../src/news/verify';

const STORY = 91;
const SCRIPT_ID = 3;
const HAIKU: Route = { provider: 'claude', model: 'haiku' };
const OUT = join(ROOT, 'data', 'news', 'factcheck-ab');
const LLM = join(OUT, 'llm');

/** Copie sbagliate di fatti veri: of = numero del fatto originale (da 1). */
const CORRUPTED: { of: number; kind: string; claim: string }[] = [
  { of: 41, kind: 'numero', claim: 'GTA 6 has sold approximately 25 million copies before release.' },
  { of: 35, kind: 'numero', claim: 'Public voting is already open before GTA 6 is out; winners are decided by a 70/30 jury/public split.' },
  { of: 33, kind: 'data', claim: 'The TGA eligibility cutoff is November 14, five days before GTA 6 launches.' },
  { of: 7, kind: 'data', claim: 'Fans identified Perez as Lucia back in 2021.' },
  { of: 31, kind: 'nome', claim: 'Capcom is the most-nominated publisher with 12, followed by Nintendo with 11.' },
  { of: 6, kind: 'nome', claim: "Other Best Performance nominees: Patrick Gibson (007 First Light), Angela Sant'Albano (Resident Evil Requiem), Troy Baker (Marvel's Wolverine), Rahul Kohli (Saros)." },
  { of: 20, kind: 'nome, fonte lunga', claim: "Lucia is the series' first non-optional female protagonist; the duo's dynamic is inspired by Thelma and Louise." },
  { of: 10, kind: 'testata', claim: "Eurogamer remarked on how strict Rockstar's NDAs must be." },
  { of: 39, kind: 'voce come fatto', claim: 'Rockstar has officially confirmed a PC release for early 2027.' },
  { of: 24, kind: 'voce come fatto', claim: 'Dylan Rourke is officially confirmed as the voice of Jason.' },
];

const research = (await Bun.file(join(ROOT, 'data', 'news', 'research', `story-${STORY}.json`)).json()) as Research;
const sqlite = new Database(join(ROOT, 'data', 'lucio.db'), { readonly: true });
const row = sqlite.query(`SELECT content, checks FROM scripts WHERE id = ?`).get(SCRIPT_ID) as { content: string; checks: string };
sqlite.close();
const script = JSON.parse(row.content) as LongScript;
const stored = (JSON.parse(row.checks) as LongChecks).factcheck;
const facts = script.facts;
const sourceOf = (url: string) => {
  const s = research.sources.find((x) => x.url === url);
  if (!s) throw new Error(`fonte non trovata nella ricerca: ${url}`);
  return s;
};
const toVerify = (claim: string, url: string): ClaimToVerify => {
  const s = sourceOf(url);
  return { claim, evidence: s.text, source: `${s.outlet} · ${s.title} · ${s.url}${s.full ? '' : ' (feed summary only)'}` };
};

const HAIKU_OK = 'supported';
type HaikuVerdict = FactCheck['checks'][number];

mkdirSync(LLM, { recursive: true });
await llm(['up', 'clef']);
try {
  // ─── 1. Clef sui fatti veri ───
  let t0 = performance.now();
  const realClef = await verifyClaims(join(LLM, 'clef-real'), facts.map((f) => toVerify(f.claim, f.source)));
  const realWall = (performance.now() - t0) / 1000;

  // ─── 2. fatti sbagliati: Clef uno per uno, Haiku in una chiamata sola ───
  t0 = performance.now();
  const badClef = await verifyClaims(join(LLM, 'clef-corrupted'), CORRUPTED.map((c) => toVerify(c.claim, facts[c.of - 1]!.source)));
  const badWall = (performance.now() - t0) / 1000;
  const haiku = await haikuMixed();

  // ─── 3. fonti lunghe: intere contro finestre ───
  const longReal = facts.map((f, i) => ({ i, f })).filter(({ f }) => sourceOf(f.source).text.length > 8000);
  const longBad = CORRUPTED.map((c, j) => ({ j, c })).filter(({ c }) => sourceOf(facts[c.of - 1]!.source).text.length > 8000);
  const winOpts = { maxChars: 8000, windowChars: 8000 };
  const winReal = await verifyClaims(join(LLM, 'clef-real-windows'), longReal.map(({ f }) => toVerify(f.claim, f.source)), winOpts);
  const winBad = await verifyClaims(join(LLM, 'clef-corrupted-windows'), longBad.map(({ c }) => toVerify(c.claim, facts[c.of - 1]!.source)), winOpts);

  // ─── stampa ───
  const storedOf = (i: number): HaikuVerdict | undefined => stored.checks.find((c) => c.i === i + 1);
  const clefOk = (v: Verification) => v.verdict === 'verified';
  const v = (x: Verification) => `${x.verdict} ${x.confidence.toFixed(2)}${x.review ? ' (da rivedere)' : ''}`;
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  console.log(`\n# Controllo dei fatti: Clef-Flash contro Haiku (storia ${STORY}, script ${SCRIPT_ID})\n`);
  const agree = realClef.filter((x, i) => clefOk(x) === (storedOf(i)?.verdict === HAIKU_OK)).length;
  console.log(`## 1. Fatti veri (${facts.length})\n`);
  console.log(`Accordo Clef/Haiku (confermato sì/no): ${agree}/${facts.length}`);
  console.log(`Verdetti di Clef: ${countBy(realClef.map((x) => x.verdict))}; da rivedere (confidenza < 0,8 o dubbi): ${realClef.filter((x) => x.review).length}`);
  console.log(`Verdetti di Haiku salvati: ${countBy(stored.checks.map((c) => c.verdict))}`);

  const rerun = haiku.real.filter((r) => r.haiku && r.haiku.verdict !== storedOf(r.i)?.verdict);
  console.log(`Haiku rifatto sui ${haiku.real.length} fatti veri della chiamata mista: ${countBy(haiku.real.map((r) => r.haiku?.verdict ?? 'mancante'))}${rerun.length ? `; diverso da prima su ${rerun.map((r) => r.i + 1).join(', ')}` : ', come prima'}`);

  console.log('\n## Disaccordi\n');
  console.log('| # | Affermazione | Clef | Haiku | Prova (Haiku) |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const [i, x] of realClef.entries()) {
    const h = storedOf(i);
    if (clefOk(x) !== (h?.verdict === HAIKU_OK)) console.log(`| ${i + 1} | ${cut(facts[i]!.claim, 90)} | ${v(x)} | ${h?.verdict ?? '—'} | ${cut(h?.evidence ?? '', 100)} |`);
  }
  for (const [j, c] of CORRUPTED.entries()) {
    const h = haiku.bad[j];
    const x = badClef[j]!;
    if (clefOk(x) !== (h?.verdict === HAIKU_OK)) console.log(`| E${j + 1} (${c.kind}) | ${cut(c.claim, 90)} | ${v(x)} | ${h?.verdict ?? '—'} | ${cut(h?.evidence ?? '', 100)} |`);
  }

  console.log(`\n## 2. Fatti sbagliati (${CORRUPTED.length})\n`);
  console.log('| # | Errore | Affermazione | Clef | Haiku |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const [j, c] of CORRUPTED.entries()) console.log(`| E${j + 1} | ${c.kind} | ${cut(c.claim, 80)} | ${v(badClef[j]!)} | ${haiku.bad[j]?.verdict ?? '—'} |`);
  const clefCaught = badClef.filter((x) => !clefOk(x)).length;
  const haikuCaught = haiku.bad.filter((h) => h && h.verdict !== HAIKU_OK).length;
  console.log(`\nErrori trovati: Clef ${clefCaught}/${CORRUPTED.length}, Haiku ${haikuCaught}/${CORRUPTED.length}`);

  // Clef prima: quello che Clef conferma senza dubbi resta; il resto (bocciato o incerto) passa a Haiku.
  const escalate = (x: Verification) => !clefOk(x) || x.review;
  const realEsc = realClef.filter(escalate).length;
  const badEsc = badClef.filter(escalate).length;
  const cascadeCaught = badClef.filter((x, j) => escalate(x) && haiku.bad[j]?.verdict !== HAIKU_OK).length;
  const cascadeFalse = realClef.filter((x, i) => escalate(x) && storedOf(i)?.verdict !== HAIKU_OK).length;
  console.log(`Clef prima e Haiku solo sui dubbi: ${realEsc}/${facts.length} fatti veri e ${badEsc}/${CORRUPTED.length} sbagliati passano a Haiku; errori trovati ${cascadeCaught}/${CORRUPTED.length}, falsi allarmi ${cascadeFalse}/${facts.length}`);

  console.log('\n## Tempi\n');
  const lat = [...realClef, ...badClef].map((x) => x.latency_ms).sort((a, b) => a - b);
  const tok = [...realClef, ...badClef].map((x) => x.tokens);
  console.log(`Clef per affermazione (tempo del modello): mediana ${(pct(lat, 0.5) / 1000).toFixed(2)} s, 90° percentile ${(pct(lat, 0.9) / 1000).toFixed(2)} s, massimo ${(lat.at(-1)! / 1000).toFixed(2)} s, totale ${(lat.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} s su ${lat.length}`);
  console.log(`Clef da capo a fondo in questa corsa (con llm.ts, ${realWall + badWall < 5 ? 'risposte riusate' : 'senza cache'}): ${realWall.toFixed(1)} s per i ${facts.length} veri, ${badWall.toFixed(1)} s per i ${CORRUPTED.length} sbagliati`);
  console.log(`Token in ingresso: da ${Math.min(...tok)} a ${Math.max(...tok)}`);
  console.log(`Haiku: ${haiku.meta.duration_s} s per la chiamata mista (${haiku.real.length + CORRUPTED.length} fatti); quella dello script ${stored.checks.length} fatti in ${haiku.prod.duration_s ?? '?'} s`);

  console.log('\n## 3. Fonti lunghe: intere o a finestre da 8.000 caratteri\n');
  console.log('| # | Affermazione | Intera | Finestre |');
  console.log('| --- | --- | --- | --- |');
  for (const [k, { i, f }] of longReal.entries()) console.log(`| ${i + 1} | ${cut(f.claim, 80)} | ${v(realClef[i]!)} (${realClef[i]!.tokens} token) | ${v(winReal[k]!)} (${winReal[k]!.windows} finestre) |`);
  for (const [k, { j, c }] of longBad.entries()) console.log(`| E${j + 1} | ${cut(c.claim, 80)} | ${v(badClef[j]!)} (${badClef[j]!.tokens} token) | ${v(winBad[k]!)} (${winBad[k]!.windows} finestre) |`);

  const file = join(OUT, `story-${STORY}.json`);
  await Bun.write(
    file,
    JSON.stringify(
      {
        story_id: STORY,
        script_id: SCRIPT_ID,
        created_at: new Date().toISOString(),
        haiku_route: routeLabel(HAIKU),
        real: facts.map((f, i) => ({ i: i + 1, claim: f.claim, source: f.source, evidence_chars: sourceOf(f.source).text.length, clef: realClef[i], haiku_stored: storedOf(i), haiku_rerun: haiku.real.find((r) => r.i === i)?.haiku })),
        corrupted: CORRUPTED.map((c, j) => ({ ...c, original: facts[c.of - 1]!.claim, source: facts[c.of - 1]!.source, clef: badClef[j], haiku: haiku.bad[j] })),
        windows_test: [
          ...longReal.map(({ i }, k) => ({ id: String(i + 1), whole: realClef[i], windows: winReal[k] })),
          ...longBad.map(({ j }, k) => ({ id: `E${j + 1}`, whole: badClef[j], windows: winBad[k] })),
        ],
        summary: {
          agreement_real: `${agree}/${facts.length}`,
          detected: { clef: `${clefCaught}/${CORRUPTED.length}`, haiku: `${haikuCaught}/${CORRUPTED.length}` },
          cascade: { escalated_real: realEsc, escalated_corrupted: badEsc, detected: cascadeCaught, false_alarms: cascadeFalse },
          clef_latency_ms: { median: pct(lat, 0.5), p90: pct(lat, 0.9), max: lat.at(-1), total: lat.reduce((a, b) => a + b, 0) },
          haiku_duration_s: { mixed: haiku.meta.duration_s, production: haiku.prod.duration_s },
        },
        haiku_mixed_order: haiku.order,
      },
      null,
      2,
    ),
  );
  console.log(`\n${file}`);
} finally {
  await llm(['down', 'clef']);
}

/**
 * Haiku con il prompt e il formato del controllo vero (long.ts): fatti numerati con la fonte, testi delle
 * fonti citate. Senza la voce fuori campo, che qui non serve (contiene gli originali giusti).
 */
async function haikuMixed() {
  const replaced = new Set(CORRUPTED.map((c) => c.of - 1));
  type Entry = { claim: string; source: string } & ({ real: number } | { bad: number });
  const entries: Entry[] = [
    ...facts.flatMap((f, i) => (replaced.has(i) ? [] : [{ claim: f.claim, source: f.source, real: i }])),
    ...CORRUPTED.map((c, j) => ({ claim: c.claim, source: facts[c.of - 1]!.source, bad: j })),
  ];
  // Ordine mescolato ma sempre lo stesso, così llm.ts riusa la risposta.
  entries.sort((a, b) => Bun.hash.crc32(a.claim) - Bun.hash.crc32(b.claim));
  const cited = new Set(entries.map((e) => e.source));
  const input = [
    '## Claims',
    ...entries.map((e, n) => `${n + 1}. ${e.claim}\n   Source: ${e.source}`),
    '',
    '## Sources',
    ...research.sources.filter((x) => cited.has(x.url)).flatMap((x: Source) => [`### ${x.url}`, `${x.title} (${x.full ? 'full text' : 'feed summary only'})`, x.text, '']),
    '## Voice-over',
    '(not included in this check)',
  ].join('\n');
  const { system, schema } = await loadPrompt('news-factcheck');
  const dir = join(LLM, 'haiku-mixed');
  const out = await runTask<FactCheck>(dir, toLlmTask(HAIKU, { think: false, temperature: 0, timeout_s: 900 }), system, input, schema);
  const at = (n: number) => out.checks.find((c) => c.i === n + 1);
  const meta = (await Bun.file(join(dir, 'meta.json')).json()) as { duration_s: number; cost_usd?: number };
  const prod = (await Bun.file(join(ROOT, 'data', 'news', 'llm', `long-${STORY}-v1`, 'factcheck', 'meta.json')).json().catch(() => ({}))) as { duration_s?: number };
  return {
    real: entries.flatMap((e, n) => ('real' in e ? [{ i: e.real, haiku: at(n) }] : [])),
    bad: CORRUPTED.map((_, j) => at(entries.findIndex((e) => 'bad' in e && e.bad === j))),
    order: entries.map((e) => ('real' in e ? e.real + 1 : `E${e.bad + 1}`)),
    meta,
    prod,
  };
}

function countBy(xs: string[]): string {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].map(([k, n]) => `${k} ${n}`).join(', ');
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}
