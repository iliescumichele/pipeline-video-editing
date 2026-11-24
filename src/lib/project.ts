// Ogni video ha la sua cartella in out/<id>/, con tutto quello che ne esce:
//
//   out/<id>/<Titolo>.mp4          video finale 4K (gameplay)
//   out/<id>/<Titolo>.tracce.m4a   gioco e voce separati, per gli short
//   out/<id>/copia-720p.mp4        copia per rivedere, resta quando cancelli registrazione e 4K
//   out/<id>/short/                short, miniature, review.html, REPORT.md
//   out/<id>/da-pubblicare/        short approvati con i loro testi, da trascinare nel browser
//
// Per un gameplay l'id è quello della registrazione di OBS, anche per gli short fatti dal video finale.
import { join } from 'node:path';
import { PATHS } from './env';

export const projectDir = (id: string) => join(PATHS.out, id);
export const shortsDir = (id: string) => join(projectDir(id), 'short');
export const publishDir = (id: string) => join(projectDir(id), 'da-pubblicare');
