import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

/** <nome del file in minuscolo>-<8 caratteri di hash su dimensione e primi 4 MB>: stabile se il file si sposta. */
export function videoId(path: string): string {
  const slug = basename(path, extname(path))
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  const size = statSync(path).size;
  const head = Buffer.alloc(Math.min(size, 4 << 20));
  const fd = openSync(path, 'r');
  readSync(fd, head, 0, head.length, 0);
  closeSync(fd);
  const hash = new Bun.CryptoHasher('sha256').update(String(size)).update(head).digest('hex').slice(0, 8);
  return `${slug || 'video'}-${hash}`;
}
