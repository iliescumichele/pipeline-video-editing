// Uno short da rivedere: video, gancio, testi per piattaforma, approva o scarta. Gli scartati si mostrano
// compressi, con DiscardedRow.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '../lib/toast';
import { mins } from '../lib/util';
import { type getRun, revealInFinder, saveShortReview } from '../server/api.functions';

const PLATFORMS = [
  ['youtube', 'YouTube Shorts'],
  ['instagram', 'Instagram Reels'],
  ['tiktok', 'TikTok'],
] as const;

export type Short = Awaited<ReturnType<typeof getRun>>['shorts'][number];

function useSave(runId: string, sid: string) {
  const qc = useQueryClient();
  const show = useToast();
  return async (patch: Parameters<typeof saveShortReview>[0]['data']['patch'], msg = 'Salvato') => {
    try {
      await saveShortReview({ data: { run: runId, short: sid, patch } });
      show(msg);
    } catch (e) {
      show((e as Error).message);
    }
    await qc.invalidateQueries({ queryKey: ['run', runId] });
    await qc.invalidateQueries({ queryKey: ['project', runId] });
  };
}

export function DiscardedRow({ runId, s }: { runId: string; s: Short }) {
  const save = useSave(runId, s.id);
  return (
    <div className="discarded">
      <img src={s.thumb_url} alt="" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{s.review.hook ?? s.hook}</b>
        <div className="small muted">
          #{s.rank} · {s.id} · {s.duration} s · voto {s.score}/10
        </div>
      </div>
      <button className="btn" onClick={() => save({ status: 'da rivedere' }, 'Ripristinato: torna da rivedere')}>
        Ripristina
      </button>
    </div>
  );
}

export function ShortCard({ runId, s }: { runId: string; s: Short }) {
  const show = useToast();
  const [p, setP] = useState<(typeof PLATFORMS)[number][0]>('youtube');
  const [copy, setCopy] = useState(() => s.review.copy ?? s.copy);
  const [hook, setHook] = useState<string>(s.review.hook ?? s.hook);
  const save = useSave(runId, s.id);
  const c = copy[p];
  const st = s.review.status;
  return (
    <div className="card short">
      <video src={s.video_url} poster={s.thumb_url} controls loop playsInline preload="metadata" />
      <div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="score">
            <b>{s.score}</b>
            <span className="small muted">/10</span>
          </div>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <label>
              Gancio (cambiarlo rifà il render di questo short)
              <input
                value={hook}
                onChange={(e) => setHook(e.target.value)}
                onBlur={() =>
                  hook !== (s.review.hook ?? s.hook) &&
                  save({ hook: hook === s.hook ? null : hook }, st === 'approvato' ? 'Gancio salvato: torna da rivedere, premi "Rifai il render"' : 'Gancio salvato: premi "Rifai il render"')
                }
              />
            </label>
            <div className="small muted" style={{ marginTop: 4 }}>
              #{s.rank} · {s.id} · {s.duration} s · sorgente {mins(s.source.s)}–{mins(s.source.e)}{s.source.segments && s.source.segments.length > 1 ? ` in ${s.source.segments.length} pezzi` : ''} · {s.layout} · {s.measures.lufs} LUFS · {s.measures.truePeak} dBTP
            </div>
          </div>
          <span className={`chip ${st === 'approvato' ? 'ok' : st === 'scartato' ? 'warn' : ''}`}>{st}</span>
        </div>
        <p>{s.score_reason}</p>
        <p className="small muted">Perché è stato scelto: {s.reason}</p>
        <div className="row">
          {s.warnings.length ? (
            s.warnings.map((w) => (
              <span key={w} className="chip warn">
                ⚠ {w}
              </span>
            ))
          ) : (
            <span className="chip ok">nessun avviso</span>
          )}
          {s.labels.slice(0, 6).map((l) => (
            <span key={l} className="chip">
              {l}
            </span>
          ))}
        </div>
        {s.published && (
          <p className="small" style={{ color: 'var(--ok)', overflowWrap: 'anywhere' }}>
            ✓ In da-pubblicare: {s.published.split('/').slice(-2).join('/')}
          </p>
        )}
        <div className="tabs">
          {PLATFORMS.map(([k, name]) => (
            <button key={k} aria-selected={k === p} onClick={() => setP(k)}>
              {name}
            </button>
          ))}
        </div>
        <div className="grid" style={{ gap: 8 }}>
          <label>
            Titolo ({c.title.length}/100)
            <input value={c.title} onChange={(e) => setCopy({ ...copy, [p]: { ...c, title: e.target.value } })} />
          </label>
          <label>
            Descrizione ({c.description.length}/500)
            <textarea value={c.description} onChange={(e) => setCopy({ ...copy, [p]: { ...c, description: e.target.value } })} />
          </label>
          <label>
            Hashtag
            <input value={c.hashtags.join(' ')} onChange={(e) => setCopy({ ...copy, [p]: { ...c, hashtags: e.target.value.split(/\s+/).filter(Boolean) } })} />
          </label>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => save({ copy })}>
            Salva testi
          </button>
          <button className="btn" onClick={() => navigator.clipboard?.writeText(`${c.title}\n\n${c.description}\n\n${c.hashtags.join(' ')}`).then(() => show('Copiato'))}>
            Copia testi
          </button>
          <button
            className="btn"
            title={s.published ?? s.file}
            onClick={() => revealInFinder({ data: s.published ?? s.file }).catch((e: Error) => show(e.message))}
          >
            Mostra nel Finder
          </button>
          <span className="spacer" />
          <button className="btn ok" onClick={() => save({ status: 'approvato', copy }, 'Approvato: copiato in da-pubblicare con i testi')}>
            {st === 'approvato' ? 'Aggiorna approvato' : 'Approva'}
          </button>
          <button className="btn danger" onClick={() => save({ status: 'scartato' }, 'Scartato')}>
            Scarta
          </button>
        </div>
      </div>
    </div>
  );
}
