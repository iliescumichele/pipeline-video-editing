// Qualità del video finale e della copia per rivedere (config/export.json): riassunto in una riga, si apre
// per cambiarla. Vale per gli export che partono dopo il salvataggio.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ExportSettings } from '../../../src/lib/export-settings';
import { q } from '../lib/queries';
import { useToast } from '../lib/toast';
import { saveExportSettings } from '../server/api.functions';

const perHour = (videoMbps: number, audioKbps: number) => ((videoMbps * 1e6 + audioKbps * 1e3) / 8) * 3600;
const gbText = (b: number) => `${(b / 1e9).toFixed(1).replace('.', ',')} GB`;
const num = (n: number) => String(n).replace('.', ',');

/** `seconds`: durata del video finale, per dire quanto peserà questo export. */
export function ExportQuality({ seconds }: { seconds?: number }) {
  const { data } = useQuery(q.exportSettings());
  const qc = useQueryClient();
  const show = useToast();
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<ExportSettings | null>(null);
  useEffect(() => {
    if (data && !open) setS(data.settings);
  }, [data, open]);
  if (!data || !s) return null;

  const cur = data.settings;
  const finalH = perHour(s.final.videoMbps, s.final.audioKbps);
  const reviewH = perHour(s.review.videoMbps, s.review.audioKbps);
  const dirty = JSON.stringify(s) !== JSON.stringify(cur);
  const set = <K extends keyof ExportSettings>(k: K, patch: Partial<ExportSettings[K]>) => setS({ ...s, [k]: { ...s[k], ...patch } });
  const save = async () => {
    try {
      const saved = await saveExportSettings({ data: s });
      setS(saved);
      await qc.invalidateQueries({ queryKey: ['export-settings'] });
      show('Qualità salvata: vale per i prossimi export');
      setOpen(false);
    } catch (e) {
      show((e as Error).message);
    }
  };

  return (
    <div className="quality">
      <div className="row small">
        <span className="muted">Qualità:</span>
        <span>
          video finale <b>{num(cur.final.videoMbps)} Mbit/s</b> HEVC · audio {cur.final.audioKbps}k · ≈ {gbText(perHour(cur.final.videoMbps, cur.final.audioKbps))} all’ora
          {seconds ? ` (questo ≈ ${gbText((perHour(cur.final.videoMbps, cur.final.audioKbps) / 3600) * seconds)})` : ''}
        </span>
        <span className="muted">
          · copia 720p {cur.review.fps} fps, {num(cur.review.videoMbps)} Mbit/s
        </span>
        <button className="btn" onClick={() => setOpen(!open)}>
          {open ? 'Chiudi' : 'Cambia'}
        </button>
      </div>
      {open && (
        <div className="quality-form">
          <fieldset>
            <legend>Video finale 4K (HEVC)</legend>
            <label>
              Video, Mbit/s
              <input type="number" min={10} max={200} step={5} value={s.final.videoMbps} onChange={(e) => set('final', { videoMbps: Number(e.target.value) })} />
            </label>
            <div className="seg">
              {[50, 70, 90, 120].map((v) => (
                <button key={v} aria-pressed={s.final.videoMbps === v} onClick={() => set('final', { videoMbps: v })}>
                  {v}
                </button>
              ))}
            </div>
            <label>
              Audio, kbit/s
              <select value={s.final.audioKbps} onChange={(e) => set('final', { audioKbps: Number(e.target.value) })}>
                {[192, 256, 320].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <div className="small muted">
              ≈ {gbText(finalH)} all’ora{seconds ? ` · questo video ≈ ${gbText((finalH / 3600) * seconds)}` : ''}. YouTube consiglia 53–68 Mbit/s per il 4K a 60 fps in H.264; l’HEVC ne chiede meno a parità di qualità.
            </div>
          </fieldset>
          <fieldset>
            <legend>Copia a 720p per rivedere (H.264)</legend>
            <label>
              Video, Mbit/s
              <input type="number" min={0.5} max={20} step={0.5} value={s.review.videoMbps} onChange={(e) => set('review', { videoMbps: Number(e.target.value) })} />
            </label>
            <div className="seg">
              {([30, 60] as const).map((v) => (
                <button key={v} aria-pressed={s.review.fps === v} onClick={() => set('review', { fps: v })}>
                  {v} fps
                </button>
              ))}
            </div>
            <label>
              Audio, kbit/s
              <select value={s.review.audioKbps} onChange={(e) => set('review', { audioKbps: Number(e.target.value) })}>
                {[96, 128, 160, 192].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <div className="small muted">
              ≈ {gbText(reviewH)} all’ora{seconds ? ` · questo video ≈ ${gbText((reviewH / 3600) * seconds)}` : ''}. Resta quando cancelli registrazione e 4K.
            </div>
          </fieldset>
          <div className="row" style={{ gridColumn: '1 / -1' }}>
            <span className="small muted">Vale per gli export che partono dopo. La registrazione la imposti in OBS (90 Mbit/s con 3 tracce PCM ≈ 44 GB all’ora).</span>
            <span className="spacer" />
            <button className="btn" onClick={() => setS(data.defaults)}>
              Valori di base
            </button>
            <button className="btn primary" disabled={!dirty} onClick={save}>
              Salva
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
