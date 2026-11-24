import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { Asset } from '../../../src/news/assets';
import { type Library, SegmentPreview, type Shot, ShotGrid, useShotFilter } from '../components/shots';
import { q } from '../lib/queries';
import { useStartJob } from '../lib/jobs';
import { useToast } from '../lib/toast';
import { clock, when } from '../lib/util';
import { type getManifest, setBeatAssets } from '../server/api.functions';

export const Route = createFileRoute('/montaggio/$id')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(q.manifest(Number(params.id))),
  component: Montaggio,
});

type Data = Awaited<ReturnType<typeof getManifest>>;
type Beat = NonNullable<Data['manifest']>['beats'][number];
type ViewAsset = Beat['assets'][number];

const KIND: Record<string, string> = { trailer: 'trailer', image: 'immagine', photo: 'foto', card: 'cartello', gameplay: 'gameplay', lucio: 'Lucianus', leak: 'leak' };

function Montaggio() {
  const id = Number(Route.useParams().id);
  const { data } = useSuspenseQuery(q.manifest(id));
  const show = useToast();
  const startChecked = useStartJob();
  const [preview, setPreview] = useState<{ src: string; s: number; e: number; caption: string } | null>(null);
  const [adding, setAdding] = useState<Beat | null>(null);
  const m = data.manifest;
  const used = new Set(m?.beats.flatMap((b) => b.assets.flatMap((a) => (a.type === 'shot' ? [a.shot_id] : []))) ?? []);
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Montaggio · {data.title}</h2>
          <span className="spacer" />
          <button
            className={`btn ${m ? '' : 'primary'}`}
            onClick={async () => {
              if (!(await startChecked({ kind: 'assets', script: id }))) return;
              show('Scelta dei materiali in coda: segui il lavoro in Stato');
            }}
          >
            {m ? 'Rifai la scelta dei materiali' : 'Scegli i materiali'}
          </button>
          {m && (
            <button
              className="btn primary"
              onClick={async () => {
                if (!(await startChecked({ kind: 'montage', script: id }))) return;
                show('Video del montaggio in coda (circa 10 minuti in 4K)');
              }}
            >
              {data.montage ? 'Rifai il video del montaggio' : 'Crea il video del montaggio'}
            </button>
          )}
          {data.montage && (
            <Link className="btn" to="/montaggio/$id/gobbo" params={{ id: String(id) }}>
              Apri il gobbo
            </Link>
          )}
        </div>
        {data.montage && (
          <div className="row small" style={{ marginTop: 8 }}>
            <span className="chip ok">video del montaggio pronto</span>
            <a href={data.montage.url} target="_blank" rel="noreferrer">
              montaggio.mp4
            </a>
            <span className="muted">
              4K · {(data.montage.size / 1e9).toFixed(1)} GB · {when(data.montage.mtime)} · da usare come sorgente multimediale in OBS:
            </span>
            <code className="small">{data.montage.path}</code>
          </div>
        )}
        {m ? (
          <div className="row small muted" style={{ marginTop: 6 }}>
            <span>scelti il {when(m.created_at)}</span>
            <span>· {m.beats.length} scene</span>
            <span>· {used.size} inquadrature diverse</span>
            <span>· durata stimata {clock(m.beats.reduce((a, b) => a + b.seconds, 0))} (prima della registrazione)</span>
          </div>
        ) : (
          <div className="empty">Materiali non ancora scelti: premi “Scegli i materiali”. Serve la libreria dei video ufficiali (scheda Libreria).</div>
        )}
      </div>
      {preview && <SegmentPreview {...preview} />}
      {m &&
        data.chapters.map((title, ci) => (
          <div key={ci} className="card">
            <h3 style={{ marginTop: 0 }}>
              {ci + 1}. {title}
            </h3>
            {m.beats
              .filter((b) => b.chapter === ci + 1)
              .map((b) => (
                <BeatRow key={`${b.chapter}-${b.index}`} script={id} beat={b} onPreview={setPreview} onAdd={() => setAdding(b)} adding={adding === b || (adding?.chapter === b.chapter && adding.index === b.index)} />
              ))}
          </div>
        ))}
      {adding && <Picker script={id} beat={adding} used={used} onClose={() => setAdding(null)} />}
    </div>
  );
}

const toAsset = (a: ViewAsset): Asset => {
  const { url_preview: _p, url_video: _v, ...rest } = a;
  return rest;
};

function BeatRow({ script, beat: b, onPreview, onAdd, adding }: { script: number; beat: Beat; onPreview: (p: { src: string; s: number; e: number; caption: string }) => void; onAdd: () => void; adding: boolean }) {
  const qc = useQueryClient();
  const save = async (assets: Asset[]) => {
    await setBeatAssets({ data: { script, chapter: b.chapter, index: b.index, assets } });
    await qc.invalidateQueries({ queryKey: ['manifest', script] });
  };
  const assets = b.assets;
  return (
    <div className="beat">
      <div className="small">
        <div className="row" style={{ gap: 6 }}>
          <span className="chip teal">{KIND[b.kind] ?? b.kind}</span>
          <span className="muted">~{b.seconds.toFixed(0)} s</span>
        </div>
        <p style={{ margin: '6px 0' }}>
          <i>“{b.at}…”</i>
        </p>
        <div className="muted">{b.show}</div>
        {b.card_text && <b style={{ color: 'var(--amber)' }}>«{b.card_text}»</b>}
        {b.note && <div className="chip warn" style={{ marginTop: 6, whiteSpace: 'normal' }}>⚠ {b.note}</div>}
      </div>
      <div className="strip">
        {b.kind === 'card' && !assets.length && <div className="card-preview">{b.card_text || 'cartello'}</div>}
        {b.kind === 'lucio' && !assets.length && <div className="card-preview">Lucianus a tutto schermo (dalla registrazione)</div>}
        {assets.map((a, i) => (
          <div key={i} className="asset">
            <img
              src={a.url_preview}
              alt=""
              loading="lazy"
              onClick={() =>
                a.type === 'shot' && a.url_video
                  ? onPreview({ src: a.url_video, s: a.s, e: a.e, caption: `${a.video_title} · ${clock(a.s)}–${clock(a.e)}` })
                  : a.type === 'image' && window.open(a.page, '_blank')
              }
            />
            <button className="x" title="Togli" onClick={() => save(assets.filter((_, j) => j !== i).map(toAsset))}>
              ✕
            </button>
            <div className="small muted">{a.type === 'shot' ? `${(a.e - a.s).toFixed(1)} s` : a.from === 'wikipedia' ? 'Wikipedia' : 'articolo'}</div>
          </div>
        ))}
        {b.kind !== 'card' && b.kind !== 'lucio' && (
          <button className="add" style={adding ? { borderColor: 'var(--amber)', color: 'var(--amber)' } : undefined} onClick={onAdd}>
            + inquadratura
          </button>
        )}
      </div>
    </div>
  );
}

/** Libreria filtrabile: un clic aggiunge l'inquadratura alla scena scelta. */
function Picker({ script, beat, used, onClose }: { script: number; beat: Beat; used: Set<number>; onClose: () => void }) {
  const { data: lib } = useQuery(q.media());
  const qc = useQueryClient();
  const show = useToast();
  if (!lib) return null;
  return (
    <div className="card" style={{ position: 'sticky', bottom: 0, maxHeight: '45vh', overflow: 'auto', borderColor: 'var(--amber)' }}>
      <PickerBody
        lib={lib}
        used={used}
        title={`Aggiungi alla scena “${beat.at}…”`}
        onClose={onClose}
        onPick={async (x) => {
          await setBeatAssets({ data: { script, chapter: beat.chapter, index: beat.index, assets: [...beat.assets.map(toAsset), { type: 'shot', shot_id: x.id, video_id: x.video_id, video_title: '', s: x.s, e: x.e, frame: x.frame, proxy: '' }] } });
          await qc.invalidateQueries({ queryKey: ['manifest', script] });
          show('Aggiunta');
        }}
      />
    </div>
  );
}

function PickerBody({ lib, used, title, onClose, onPick }: { lib: Library; used: Set<number>; title: string; onClose: () => void; onPick: (x: Shot) => void }) {
  const { shots, controls } = useShotFilter(lib);
  return (
    <>
      <div className="row">
        <b>{title}</b>
        <span className="small muted">le inquadrature già usate sono sbiadite</span>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Chiudi
        </button>
      </div>
      <div style={{ margin: '8px 0' }}>{controls}</div>
      <ShotGrid shots={shots} onPick={onPick} dimmed={used} />
    </>
  );
}
