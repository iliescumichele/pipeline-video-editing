// File multimediali per la dashboard: solo da out/, work/ e data/, le sorgenti delle corse e le
// miniature dei video noti. Il server di Vite non gestisce Range da solo: senza, nei video non ci si
// sposta, quindi le richieste parziali si servono qui.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inside, knownVideoPaths, runs } from '../../../src/dashboard/data';
import { DATA } from '../../../src/dashboard/db';
import { PATHS } from '../../../src/lib/env';
import { outroPaths } from './pipeline.server';

const THUMBS = join(DATA, 'thumbs');
const notFound = (msg = 'non trovato') => new Response(msg, { status: 404 });

export function serveMedia(request: Request): Response {
  const u = new URL(request.url);
  const path = decodeURIComponent(u.pathname);
  if (path.startsWith('/media/out/')) {
    const p = join(PATHS.out, path.slice('/media/out/'.length));
    return inside(p, PATHS.out) && existsSync(p) ? fileResponse(p, request) : notFound();
  }
  if (path === '/media/file') {
    const p = resolve(u.searchParams.get('path') ?? '');
    return inside(p, PATHS.work, DATA, PATHS.out) && existsSync(p) ? fileResponse(p, request) : notFound();
  }
  // Video sorgente di una corsa (per guardare i tratti durante il voto): solo sorgenti note.
  if (path.startsWith('/media/source/')) {
    const src = runs().find((r) => r.id === path.slice('/media/source/'.length))?.source;
    return src && existsSync(src) ? fileResponse(src, request) : notFound();
  }
  // Registrazione originale (e il suo Lucianus, o il pezzo finale) per l'anteprima del gameplay, che la riproduce senza render.
  if (path === '/media/recording') {
    const p = resolve(u.searchParams.get('path') ?? '');
    return (knownVideoPaths().includes(p) || outroPaths().includes(p)) && existsSync(p) ? fileResponse(p, request) : notFound();
  }
  if (path === '/media/thumb') {
    const p = u.searchParams.get('path') ?? '';
    if (!knownVideoPaths().includes(p)) return notFound();
    mkdirSync(THUMBS, { recursive: true });
    const t = join(THUMBS, `${createHash('sha1').update(p).digest('hex')}.jpg`);
    if (!existsSync(t)) {
      Bun.spawnSync(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', '30', '-i', p, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', t]);
      if (!existsSync(t)) Bun.spawnSync(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', p, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', t]);
    }
    return existsSync(t) ? fileResponse(t, request) : notFound('niente miniatura');
  }
  return notFound();
}

function fileResponse(p: string, request: Request): Response {
  const f = Bun.file(p);
  const size = f.size;
  const headers = { 'Content-Type': f.type || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const m = request.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return new Response(f, { headers: { ...headers, 'Content-Length': String(size) } });
  // "bytes=-500" sono gli ultimi 500 byte
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] && m[2] ? Number(m[2]) : size - 1;
  end = Math.min(end, size - 1);
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  start = Math.max(0, start);
  return new Response(f.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` },
  });
}
