// Qualità del video finale del gameplay e della copia per rivedere: config/export.json, si cambia dalla
// dashboard (Video → Video lungo, "Qualità dei video"). Valgono per gli export che partono dopo.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './env';

export interface ExportSettings {
  /** video finale 4K: HEVC (VideoToolbox) e AAC */
  final: { videoMbps: number; audioKbps: number };
  /** copia a 720p per rivedere: H.264 e AAC */
  review: { videoMbps: number; fps: 30 | 60; audioKbps: number };
}

export const DEFAULT_EXPORT: ExportSettings = {
  final: { videoMbps: 70, audioKbps: 320 },
  review: { videoMbps: 2.5, fps: 30, audioKbps: 128 },
};

export const EXPORT_PATH = join(ROOT, 'config', 'export.json');

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 10) / 10)) : fallback;
};

/** Valori sempre validi: fuori dai limiti si riportano dentro (l'AAC di Apple in stereo arriva a 320k). */
function clean(s: Partial<{ final: Partial<ExportSettings['final']>; review: Partial<ExportSettings['review']> }>): ExportSettings {
  const d = DEFAULT_EXPORT;
  return {
    final: {
      videoMbps: clamp(s.final?.videoMbps, 10, 200, d.final.videoMbps),
      audioKbps: clamp(s.final?.audioKbps, 128, 320, d.final.audioKbps),
    },
    review: {
      videoMbps: clamp(s.review?.videoMbps, 0.5, 20, d.review.videoMbps),
      fps: Number(s.review?.fps) === 60 ? 60 : 30,
      audioKbps: clamp(s.review?.audioKbps, 64, 320, d.review.audioKbps),
    },
  };
}

export function readExport(): ExportSettings {
  if (!existsSync(EXPORT_PATH)) return DEFAULT_EXPORT;
  try {
    return clean(JSON.parse(readFileSync(EXPORT_PATH, 'utf8')));
  } catch {
    return DEFAULT_EXPORT;
  }
}

export function writeExport(s: ExportSettings): ExportSettings {
  const c = clean(s);
  writeFileSync(EXPORT_PATH, `${JSON.stringify(c, null, 2)}\n`);
  return c;
}

/** Byte al secondo di un file con questi bitrate. */
export const bytesPerSecond = (videoMbps: number, audioKbps: number) => (videoMbps * 1e6 + audioKbps * 1e3) / 8;
