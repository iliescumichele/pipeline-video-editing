import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/env';

/** Dati della dashboard: lavori, revisioni degli short, voti del banco di prova, notizie e script. */
export const DATA = join(ROOT, 'data');
mkdirSync(DATA, { recursive: true });

// Il dev server della dashboard (Vite) può rivalutare questo modulo: la connessione resta una sola.
const g = globalThis as { __lucioDb?: Database };
export const db = (g.__lucioDb ??= new Database(join(DATA, 'lucio.db'), { create: true }));
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    argv TEXT NOT NULL,
    status TEXT NOT NULL,          -- in coda, in corso, finito, fallito, interrotto
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    exit_code INTEGER
  );
  CREATE TABLE IF NOT EXISTS short_reviews (
    run_id TEXT NOT NULL,
    short_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'da rivedere',   -- da rivedere, approvato, scartato
    copy TEXT,                                    -- JSON dei testi modificati per piattaforma
    hook TEXT,
    note TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, short_id)
  );
  CREATE TABLE IF NOT EXISTS bench_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bench_id TEXT NOT NULL,
    task TEXT NOT NULL,
    sample TEXT NOT NULL,
    a TEXT NOT NULL,
    b TEXT NOT NULL,
    winner TEXT NOT NULL,          -- a, b, pari
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS news_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    guid TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    published_at TEXT,
    fetched_at TEXT NOT NULL,
    story_id INTEGER,
    embedding BLOB
  );
  CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    items INTEGER NOT NULL DEFAULT 0,
    centroid BLOB,
    triage TEXT,                   -- JSON delle risposte dello smistamento
    score REAL,                    -- 0–1, per ordinare
    status TEXT NOT NULL DEFAULT 'nuova'   -- nuova, scartata, da scrivere, scritta
  );
  CREATE TABLE IF NOT EXISTS scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    story_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    route TEXT NOT NULL,
    content TEXT NOT NULL,         -- JSON prodotto dal modello
    edited TEXT,                   -- JSON modificato a mano
    status TEXT NOT NULL DEFAULT 'bozza',  -- bozza, approvato, scartato
    cost_usd REAL,
    kind TEXT NOT NULL DEFAULT 'short',    -- short (30–60 s) o long (video da 8+ minuti)
    checks TEXT                    -- JSON: lunghezza, problemi e controllo dei fatti (solo long)
  );
  CREATE TABLE IF NOT EXISTS media_videos (
    id TEXT PRIMARY KEY,           -- id YouTube
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    duration REAL,
    width INTEGER,
    height INTEGER,
    fps REAL,
    path TEXT,                     -- originale, solo video (data/media/official/)
    proxy TEXT,                    -- copia leggera 640 px per guardarlo (data/media/proxy/)
    status TEXT NOT NULL,          -- scaricato, diviso, etichettato, saltato
    note TEXT,
    added_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS media_shots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    s REAL NOT NULL,
    e REAL NOT NULL,
    frame TEXT NOT NULL,           -- fotogramma a metà inquadratura (data/media/frames/)
    tags TEXT,                     -- JSON: chi, dove, cosa, inquadratura, momento, usabile
    UNIQUE (video_id, idx)
  );
  CREATE TABLE IF NOT EXISTS extra_videos (
    path TEXT PRIMARY KEY,
    added_at TEXT NOT NULL
  );
`);

// Colonne aggiunte dopo la prima versione: i database già creati le ricevono qui.
const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
if (!columns('scripts').includes('kind')) db.exec(`ALTER TABLE scripts ADD COLUMN kind TEXT NOT NULL DEFAULT 'short'`);
if (!columns('scripts').includes('checks')) db.exec(`ALTER TABLE scripts ADD COLUMN checks TEXT`);
if (!columns('media_videos').includes('source')) db.exec(`ALTER TABLE media_videos ADD COLUMN source TEXT NOT NULL DEFAULT 'official'`); // official o leak
if (!columns('media_videos').includes('query')) db.exec(`ALTER TABLE media_videos ADD COLUMN query TEXT`); // la ricerca che ha trovato un leak

export const now = () => new Date().toISOString();
