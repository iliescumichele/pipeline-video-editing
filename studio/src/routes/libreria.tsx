import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { SegmentPreview, type Shot, ShotGrid, useShotFilter } from '../components/shots';
import { q } from '../lib/queries';
import { useStartJob } from '../lib/jobs';
import { useToast } from '../lib/toast';
import { clock, mins } from '../lib/util';

export const Route = createFileRoute('/libreria')({
  loader: ({ context }) => context.queryClient.ensureQueryData(q.media()),
  component: Media,
});

const STATUS: Record<string, string> = { scaricato: 'amber', diviso: 'amber', etichettato: 'ok', saltato: 'warn' };

function Media() {
  const { data: lib } = useSuspenseQuery(q.media());
  const show = useToast();
  const startChecked = useStartJob();
  const { shots, controls } = useShotFilter(lib);
  const [sel, setSel] = useState<Shot | null>(null);
  const video = sel && lib.videos.find((v) => v.id === sel.video_id);
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Video</h2>
          <span className="small muted">ufficiali dal canale di Rockstar, leak trovati dalla ricerca automatica; solo immagine</span>
          <span className="spacer" />
          <button
            className="btn primary"
            onClick={async () => {
              if (!(await startChecked({ kind: 'media' }))) return;
              show('Aggiornamento della libreria in coda');
            }}
          >
            Aggiorna libreria
          </button>
        </div>
        {lib.videos.length === 0 && <div className="empty">Libreria vuota: premi Aggiorna libreria.</div>}
        {lib.videos.map((v) => {
          const n = lib.shots.filter((x) => x.video_id === v.id);
          return (
            <div key={v.id} className="row small" style={{ marginTop: 6 }}>
              <span className={`chip ${STATUS[v.status] ?? ''}`}>{v.status}</span>
              {v.source === 'leak' && <span className="chip warn">leak</span>}
              <a href={v.url} target="_blank" rel="noreferrer">
                {v.title}
              </a>
              <span className="muted">
                {v.duration ? mins(v.duration) : ''} {v.height ? `· ${v.height}p` : ''} {n.length ? `· ${n.length} inquadrature, ${n.filter((x) => x.tags).length} etichettate` : ''}
              </span>
              {v.query && <span className="muted">da “{v.query}”</span>}
              {v.note && <span className="chip warn">{v.note}</span>}
            </div>
          );
        })}
      </div>
      {sel && video?.proxy_url && (
        <SegmentPreview src={video.proxy_url} s={sel.s} e={sel.e} caption={`${video.title} · ${clock(sel.s)}–${clock(sel.e)} · ${sel.tags?.description ?? ''}`} />
      )}
      <div className="card">
        {controls}
        <div style={{ marginTop: 12 }}>
          <ShotGrid shots={shots} selected={sel?.id} onPick={setSel} />
        </div>
      </div>
    </div>
  );
}
