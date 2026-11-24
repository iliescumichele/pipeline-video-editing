// Pezzi in comune tra le notizie per gli short (news.ts) e il video lungo (long.ts).
import { join } from 'node:path';
import { DATA } from '../dashboard/db';
import { ROOT } from '../lib/env';

export interface NewsConfig {
  require: string[];
  sources: { id: string; name: string; url: string; filter: boolean }[];
  embedding_model: string;
  same_story_similarity: number;
  story_window_hours: number;
  max_age_days: number;
  score_half_life_hours: number;
}

export interface Item {
  id: number;
  source: string;
  url: string;
  title: string;
  summary: string | null;
  published_at: string | null;
  story_id: number | null;
  embedding: Uint8Array | null;
}

export interface Story {
  id: number;
  title: string;
  first_seen: string;
  last_seen: string;
  items: number;
  centroid: Uint8Array | null;
  triage: string | null;
  score: number | null;
  status: string;
}

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
export const LLM_DIR = join(DATA, 'news', 'llm');
export const config = (await Bun.file(join(ROOT, 'config', 'news.json')).json()) as NewsConfig;

export function cleanText(s: string): string {
  return decode(decode(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decode(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—' };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return named[e.toLowerCase()] ?? all;
  });
}

/** Testo principale di un articolo: i paragrafi lunghi, senza script, menu e piè di pagina. */
export async function articleText(url: string, max = 6000): Promise<string> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return '';
    const html = (await res.text()).replace(/<(script|style|nav|footer|aside|header|form)\b[\s\S]*?<\/\1>/gi, ' ');
    return [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => cleanText(m[1]!))
      .filter((p) => p.length > 60)
      .join('\n')
      .slice(0, max);
  } catch {
    return '';
  }
}

/** Google News e YouTube non portano all'articolo: per il testo servono i link diretti. */
export const isDirect = (url: string) => !url.includes('news.google.com') && !url.includes('youtube.com');

export function sourceName(id: string): string {
  return config.sources.find((s) => s.id === id)?.name ?? id;
}

/** Google News mette la testata in fondo al titolo: "Titolo - Testata". */
export function outletFromTitle(it: Item): string {
  if (it.source !== 'google-news') return '';
  const m = it.title.match(/ - ([^-]+)$/);
  return m ? ` (${m[1]!.trim()})` : '';
}
