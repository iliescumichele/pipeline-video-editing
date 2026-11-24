// Inquadrature della libreria: filtri, griglia e anteprima del tratto.
import { useMemo, useState } from 'react';
import type { getMedia } from '../server/api.functions';
import { clock } from '../lib/util';

export type Library = Awaited<ReturnType<typeof getMedia>>;
export type Shot = Library['shots'][number];

const WHO = [
  ['', 'tutti'],
  ['lucia', 'Lucia'],
  ['jason', 'Jason'],
  ['both', 'Lucia e Jason'],
  ['nobody', 'senza persone'],
] as const;

export function useShotFilter(lib: Library) {
  const [who, setWho] = useState('');
  const [text, setText] = useState('');
  const [video, setVideo] = useState('');
  const [source, setSource] = useState('');
  const [all, setAll] = useState(false);
  const shots = useMemo(() => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const origin = new Map(lib.videos.map((v) => [v.id, v.source]));
    return lib.shots.filter((x) => {
      const t = x.tags;
      if (source && origin.get(x.video_id) !== source) return false;
      if (!t) return all;
      if (!all && (!t.usable || t.text_on_screen)) return false;
      if (video && x.video_id !== video) return false;
      if (who === 'both' && !(t.who.includes('lucia') && t.who.includes('jason'))) return false;
      if (who && who !== 'both' && !t.who.includes(who as never)) return false;
      const hay = `${t.place} ${t.action} ${t.description} ${t.time} ${t.framing}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [lib, who, text, video, source, all]);
  const controls = (
    <div className="row small">
      <input style={{ maxWidth: 260 }} placeholder="cerca: spiaggia, notte, auto…" value={text} onChange={(e) => setText(e.target.value)} />
      <select style={{ maxWidth: 160 }} value={who} onChange={(e) => setWho(e.target.value)}>
        {WHO.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
      <select style={{ maxWidth: 140 }} value={source} onChange={(e) => setSource(e.target.value)}>
        <option value="">ufficiali e leak</option>
        <option value="official">solo ufficiali</option>
        <option value="leak">solo leak</option>
      </select>
      <select style={{ maxWidth: 280 }} value={video} onChange={(e) => setVideo(e.target.value)}>
        <option value="">tutti i video</option>
        {lib.videos
          .filter((v) => v.status !== 'saltato')
          .map((v) => (
            <option key={v.id} value={v.id}>
              {v.source === 'leak' ? '[leak] ' : ''}
              {v.title}
            </option>
          ))}
      </select>
      <label className="row" style={{ display: 'flex', width: 'auto' }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={all} onChange={(e) => setAll(e.target.checked)} /> anche loghi e transizioni
      </label>
      <span className="muted">{shots.length} inquadrature</span>
    </div>
  );
  return { shots, controls };
}

export function ShotGrid({ shots, selected, onPick, dimmed }: { shots: Shot[]; selected?: number | null; onPick: (s: Shot) => void; dimmed?: Set<number> }) {
  return (
    <div className="shots">
      {shots.map((x) => (
        <div key={x.id} className={`shot ${x.id === selected ? 'sel' : ''} ${dimmed?.has(x.id) ? 'dim' : ''}`} onClick={() => onPick(x)} title={x.tags?.description}>
          <img src={x.frame_url} alt="" loading="lazy" />
          <div className="row small" style={{ marginTop: 4, gap: 4 }}>
            <span className="muted">
              {clock(x.s)} · {(x.e - x.s).toFixed(1)} s
            </span>
            {x.tags?.who
              .filter((w) => w === 'lucia' || w === 'jason')
              .map((w) => (
                <span key={w} className="chip teal">
                  {w === 'lucia' ? 'Lucia' : 'Jason'}
                </span>
              ))}
          </div>
          <div className="small muted desc">{x.tags ? `${x.tags.place} · ${x.tags.action}` : 'da etichettare'}</div>
        </div>
      ))}
    </div>
  );
}

/** Riproduce solo il tratto dell'inquadratura sulla copia leggera del video. */
export function SegmentPreview({ src, s, e, caption }: { src: string; s: number; e: number; caption: string }) {
  return (
    <div className="card preview">
      <video key={`${src}#${s}`} src={`${src}#t=${s.toFixed(2)},${e.toFixed(2)}`} autoPlay muted controls playsInline />
      <div className="small muted">{caption}</div>
    </div>
  );
}
