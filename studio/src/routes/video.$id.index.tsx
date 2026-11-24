import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudioMix, Cut, CutReason, Duck } from '../../../src/gameplay/edit';
import { VOICE_PRESETS, type VoicePreset } from '../../../src/lib/voice-eq';

/** I tipi di voce, nell'ordine dei tasti 1–7 del player */
const PRESET_KEYS = Object.keys(VOICE_PRESETS) as VoicePreset[];
import { ExportQuality } from '../components/export-quality';
import { RecordingPlayer } from '../components/recording-player';
import { q } from '../lib/queries';
import { useStartJob } from '../lib/jobs';
import { useToast } from '../lib/toast';
import { gb, hms, parseHms, when } from '../lib/util';
import { addReference, generateGameplayYoutube, removeReference, revealInFinder, saveGameplayCuts, saveGameplayMeta } from '../server/api.functions';

// Video → un gameplay → Video lungo: tagli, voce e gioco, titolo e miniatura, video finale 4K.
export const Route = createFileRoute('/video/$id/')({
  loader: async ({ context, params }) => {
    // un video che non è un gameplay ha solo gli short
    const p = await context.queryClient.ensureQueryData(q.project(params.id));
    if (p.kind !== 'gameplay') throw redirect({ to: '/video/$id/short', params });
    return context.queryClient.ensureQueryData(q.gameplay(params.id));
  },
  component: GameplayEditor,
});

const REASON: Record<CutReason, { label: string; color: string }> = {
  inizio: { label: 'inizio', color: '#a39db0' },
  fine: { label: 'fine', color: '#a39db0' },
  menu: { label: 'menu', color: '#ffb547' },
  lingua: { label: 'rumeno', color: '#ff7a6b' },
  manuale: { label: 'a mano', color: '#3fd0c9' },
};

const newId = () => Math.random().toString(36).slice(2, 10);

function GameplayEditor() {
  const { id } = Route.useParams();
  const { data } = useSuspenseQuery(q.gameplay(id));
  const qc = useQueryClient();
  const show = useToast();
  const startChecked = useStartJob();
  const video = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [skip, setSkip] = useState(true);
  const [cuts, setCuts] = useState<Cut[]>(() => data.edit?.cuts ?? []);
  const [pendingStart, setPendingStart] = useState<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dur = data.duration;

  // quando l'analisi sul server cambia i tagli (e qui non ci sono modifiche in sospeso) li riprendo
  const serverStamp = data.edit?.updated_at;
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current && data.edit) setCuts(data.edit.cuts);
  }, [serverStamp]); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = useCallback(
    (next: Cut[]) => {
      setCuts(next);
      dirty.current = true;
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        try {
          await saveGameplayCuts({ data: { id, cuts: next } });
          dirty.current = false;
          await qc.invalidateQueries({ queryKey: ['gameplay', id] });
        } catch (e) {
          show((e as Error).message);
        }
      }, 500);
    },
    [id, qc, show],
  );
  const update = (cid: string, patch: Partial<Cut>) => persist(cuts.map((c) => (c.id === cid ? { ...c, ...patch, edited: true } : c)));

  const active = useMemo(() => cuts.filter((c) => c.enabled).sort((a, b) => a.start - b.start), [cuts]);
  const removed = useMemo(() => {
    const out: [number, number][] = [];
    for (const c of active) {
      const last = out.at(-1);
      if (last && c.start <= last[1]) last[1] = Math.max(last[1], c.end);
      else out.push([c.start, c.end]);
    }
    return out;
  }, [active]);
  const finalDur = dur - removed.reduce((s, [a, b]) => s + b - a, 0);

  // riproduzione: con "salta i tagli" il player si comporta come il video finale
  const onTime = () => {
    const v = video.current;
    if (!v) return;
    setT(v.currentTime);
    if (!skip || v.paused) return;
    const r = removed.find(([a, b]) => v.currentTime >= a && v.currentTime < b - 0.05);
    if (r) v.currentTime = r[1];
  };
  const seek = (s: number, play = false) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(dur, s));
    setT(v.currentTime);
    if (play) void v.play();
  };

  const startCut = () => setPendingStart(t);
  const endCut = () => {
    if (pendingStart === null) return;
    const [a, b] = [Math.min(pendingStart, t), Math.max(pendingStart, t)];
    if (b - a < 0.3) return show('Il taglio è troppo corto');
    persist([...cuts, { id: newId(), start: a, end: b, reason: 'manuale', enabled: true, edited: true }]);
    setPendingStart(null);
    show(`Taglio aggiunto: ${hms(a)} – ${hms(b)}`);
  };

  // tastiera: spazio, frecce (5 s, con Maiusc 1 s), I e O per inizio e fine di un taglio nuovo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey) return;
      const v = video.current;
      if (!v) return;
      if (e.key === ' ') {
        e.preventDefault();
        if (v.paused) void v.play();
        else v.pause();
      } else if (e.key === 'ArrowRight') seek(v.currentTime + (e.shiftKey ? 1 : 5));
      else if (e.key === 'ArrowLeft') seek(v.currentTime - (e.shiftKey ? 1 : 5));
      else if (e.key.toLowerCase() === 'i') startCut();
      else if (e.key.toLowerCase() === 'o') endCut();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const job = async (step: 'analizza' | 'lingua' | 'anteprima' | 'esporta' | 'tracce', extra: { from?: number; duration?: number } = {}, msg = 'In coda: segui il lavoro qui sotto o in Stato') => {
    try {
      if (!(await startChecked({ kind: 'gameplay', step, video: data.video, ...extra }))) return;
      show(msg);
      await qc.invalidateQueries({ queryKey: ['gameplay', id] });
      await qc.invalidateQueries({ queryKey: ['project', id] });
    } catch (e) {
      show((e as Error).message);
    }
  };
  const saveMeta = async (patch: Parameters<typeof saveGameplayMeta>[0]['data']['patch']) => {
    try {
      await saveGameplayMeta({ data: { id, patch } });
      await qc.invalidateQueries({ queryKey: ['gameplay', id] });
      return true;
    } catch (e) {
      show((e as Error).message);
      return false;
    }
  };
  const running = data.jobs.filter((j) => j.status === 'in corso' || j.status === 'in coda');
  const busy = (step: string) => running.some((j) => j.step === step);

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="card">
        <div className="row">
          <TitleInput id={id} title={data.edit?.title ?? ''} placeholder={data.name.replace(/\.[^.]+$/, '')} disabled={!data.edit && !data.available} />
          <span className="spacer" />
          <span className="small muted">
            {hms(dur)} → <b style={{ color: 'var(--text)' }}>{hms(finalDur)}</b> · {active.length} tagli attivi
            {data.edit?.offsetMs != null && ` · Lucianus sincronizzato (${data.edit.offsetMs} ms)`}
          </span>
        </div>
        {!data.available && (
          <div className="small muted" style={{ marginTop: 10 }}>
            La registrazione originale non è più sul Mac (né in una cartella delle registrazioni collegata): qui puoi rivedere il lavoro fatto, ma non cambiarlo né esportarlo di nuovo.
          </div>
        )}
        <div className="row" style={{ marginTop: 10, display: data.available ? undefined : 'none' }}>
          <button className={`btn ${data.analyzed ? '' : 'primary'}`} disabled={busy('analizza')} onClick={() => job('analizza')}>
            {data.analyzed ? 'Rifai l’analisi dei menu' : '1 · Analizza menu e sincronia'}
          </button>
          <button className="btn" disabled={busy('lingua') || !data.analyzed} onClick={() => job('lingua', {}, 'Riconoscimento della lingua in coda (circa 20-30 minuti)')}>
            {data.language ? 'Rifai il rumeno' : '2 · Trova le parti in rumeno'}
          </button>
          <button
            className={`btn ${data.previewStale ? 'primary' : ''}`}
            disabled={busy('anteprima') || !data.analyzed}
            onClick={() => job('anteprima', {}, 'Mix finale da ascoltare in coda (pochi minuti)')}
            title="Facoltativo: l’anteprima ha già gioco e voce. Questo prepara il mix esatto del video finale (voce compressa, gioco abbassato mentre parli, −14 LUFS) per ascoltarlo nel player."
          >
            {data.preview ? (data.previewStale ? 'Rifai il mix finale da ascoltare (volumi cambiati)' : 'Rifai il mix finale da ascoltare') : 'Prepara il mix finale da ascoltare'}
          </button>
          <span className="spacer" />
          <button className="btn" disabled={busy('esporta') || !data.analyzed} onClick={() => job('esporta', { from: Math.floor(t), duration: 30 }, `Prova di 30 s da ${hms(t)} in coda`)}>
            Prova 4K di 30 s da {hms(t)}
          </button>
          <button className="btn primary" disabled={busy('esporta') || !data.analyzed} onClick={() => job('esporta', {}, 'Video finale 4K in coda (1-3 ore)')}>
            Esporta il video finale 4K
          </button>
        </div>
        {data.available && data.edit && (
          <div style={{ marginTop: 10 }}>
            <ExportQuality seconds={finalDur} />
          </div>
        )}
        {data.jobs.length > 0 && (
          <div className="row small" style={{ marginTop: 10, gap: 6 }}>
            {data.jobs.map((j) => (
              <span key={j.id} className={`chip ${j.status === 'finito' ? 'ok' : j.status === 'fallito' || j.status === 'interrotto' ? 'warn' : 'amber'}`} title={j.title}>
                {j.step}: {j.status}
                {j.finished_at ? ` · ${when(j.finished_at)}` : ''}
              </span>
            ))}
            <Link to="/" className="small">
              log in Stato
            </Link>
          </div>
        )}
      </div>

      {!data.analyzed && data.available && (
        <div className="small muted">Puoi già guardare la registrazione e segnare tagli. “Analizza menu e sincronia” trova le impostazioni da togliere e allinea Lucianus al millisecondo.</div>
      )}

      {data.edit && !data.available && <ReviewCard data={data} />}

      {data.available && (
        <div className="card">
          <RecordingPlayer
            video={video}
            src={data.recording}
            lucianus={data.lucianusUrl}
            offsetMs={data.edit?.offsetMs ?? 0}
            audio={data.preview?.url ?? null}
            clearVoice={data.mix.clear}
            onClearVoice={async (clear) => {
              try {
                await saveGameplayMeta({ data: { id, patch: { mix: { ...data.mix, clear } } } });
                await qc.invalidateQueries({ queryKey: ['gameplay', id] });
              } catch (e) {
                show((e as Error).message);
              }
            }}
            preset={data.mix.eq ?? 'chiara'}
            onPreset={(p) => void saveMeta({ mix: { ...data.mix, clear: p !== null, eq: p ?? data.mix.eq ?? 'chiara' } })}
            onTime={onTime}
            look={data.look}
            defaultLook={data.defaultLook}
            onLook={(look) => void saveMeta({ look })}
            facecam={data.facecam}
            outro={data.outro && !data.outro.missing ? { url: data.outro.url, start: Math.max(0, finalDur - data.outro.duration), duration: data.outro.duration } : null}
            removed={removed}
          />
          {data.previewStale && <div className="small" style={{ marginTop: 6, color: 'var(--amber, #ffb547)' }}>Hai cambiato i volumi di “Voce e gioco”: il mix finale da ascoltare è ancora quello di prima, rifallo per sentirli.</div>}
          <Timeline dur={dur} cuts={cuts} t={t} pendingStart={pendingStart} onSeek={(s) => seek(s)} />
          <Zoom dur={dur} cuts={cuts} t={t} pendingStart={pendingStart} onSeek={(s) => seek(s)} />
          <div className="row" style={{ marginTop: 10 }}>
            <label className="row small" style={{ width: 'auto', gap: 6 }}>
              <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} style={{ width: 'auto' }} />
              Salta i tagli (come nel video finale)
            </label>
            <span className="small muted">{hms(t)}</span>
            <span className="spacer" />
            {pendingStart === null ? (
              <button className="btn" onClick={startCut}>
                ✂ Inizio taglio qui (I)
              </button>
            ) : (
              <>
                <span className="chip teal">inizio {hms(pendingStart)}</span>
                <button className="btn primary" onClick={endCut}>
                  Fine taglio qui (O)
                </button>
                <button className="btn" onClick={() => setPendingStart(null)}>
                  Annulla
                </button>
              </>
            )}
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>
            Spazio: play/pausa · ← →: 5 s (con Maiusc 1 s) · I / O: inizio e fine di un taglio nuovo · G / V: muta gioco o voce · C: voce più chiara · clic sulle barre per spostarti
          </div>
        </div>
      )}

      {data.available && <FacecamCard data={data} finalDur={finalDur} save={saveMeta} />}

      {data.available && <MixCard id={id} mix={data.mix} />}

      {data.available && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Tagli</h3>
          {cuts.length === 0 && <div className="empty">Nessun taglio.</div>}
          <div className="grid" style={{ gap: 6 }}>
            {[...cuts]
              .sort((a, b) => a.start - b.start)
              .map((c) => (
                <CutRow
                  key={c.id}
                  c={c}
                  t={t}
                  canSeek
                  onGo={() => seek(Math.max(0, c.start - 3), true)}
                  onChange={(patch) => update(c.id, patch)}
                  onDelete={() => persist(cuts.filter((x) => x.id !== c.id))}
                />
              ))}
          </div>
        </div>
      )}

      {data.edit && <YoutubeCard id={id} data={data} />}

      {(data.export || data.test || data.archive || data.shorts.total > 0) && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Video pronti</h3>
          {data.archive ? (
            <div className="row small" style={{ marginBottom: 8 }}>
              <span className="chip">copia 720p per rivedere</span>
              <a href={data.archive.url} target="_blank" rel="noreferrer">
                apri
              </a>
              <span className="muted">
                {gb(data.archive.size)} · resta anche se cancelli registrazione e video finale
              </span>
            </div>
          ) : (
            data.export && (
              <div className="row small" style={{ marginBottom: 8 }}>
                <span className="muted">Questo video è stato esportato prima della copia a 720p: creala per poterlo rivedere anche dopo aver cancellato i file grandi.</span>
                <span className="spacer" />
                <button
                  className="btn"
                  disabled={busy('archivio')}
                  onClick={async () => {
                    try {
                      if (!(await startChecked({ kind: 'gameplay-archive', id }))) return;
                      show('Copia a 720p in coda (circa 25 minuti)');
                      await qc.invalidateQueries({ queryKey: ['gameplay', id] });
                    } catch (e) {
                      show((e as Error).message);
                    }
                  }}
                >
                  Crea la copia a 720p (circa 3 GB)
                </button>
              </div>
            )
          )}
          {data.export && !data.tracks && data.available && (
            <div className="row small" style={{ marginBottom: 8 }}>
              <span className="muted">Mancano gioco e voce separati: senza, gli short separano la voce con Demucs (circa 19 GB di spazio temporaneo per 2 ore e mezza, voce meno pulita).</span>
              <span className="spacer" />
              <button className="btn" disabled={busy('tracce')} onClick={() => job('tracce', {}, 'Gioco e voce separati in coda (circa un minuto)')}>
                Prepara gioco e voce per gli short
              </button>
            </div>
          )}
          {data.shorts.total > 0 && (
            <div className="row small" style={{ marginBottom: 8 }}>
              <span className="chip teal">short</span>
              <Link to="/video/$id/short" params={{ id }}>
                {data.shorts.total} short · {data.shorts.approvato} approvati
              </Link>
              {!data.export && <span className="muted">· per crearne di nuovi serve il video finale</span>}
            </div>
          )}
          {data.test && (
            <div className="row small" style={{ marginBottom: 8 }}>
              <span className="chip">prova 30 s</span>
              <a href={data.test.url} target="_blank" rel="noreferrer">
                apri la prova
              </a>
              <span className="muted">
                {gb(data.test.size)} · {when(data.test.mtime)}
              </span>
            </div>
          )}
          {data.export && (
            <>
              <div className="row small">
                <span className="chip ok">video finale 4K</span>
                <a href={data.export.url} target="_blank" rel="noreferrer">
                  apri
                </a>
                <span className="muted">
                  {gb(data.export.size)} · {when(data.export.mtime)}
                </span>
                <code className="small">{data.export.path}</code>
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <span className="small muted">
                  Caricalo da YouTube Studio. Gli short partono da questo video, già tagliato e con l’audio a posto: il gioco lo prendono pulito dalla registrazione e Lucianus dal suo file.
                </span>
                <span className="spacer" />
                <Link className="btn primary" to="/video/$id/short" params={{ id }}>
                  2 · Vai agli short →
                </Link>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Bar({ cuts, from, to, t, pendingStart, onSeek, height }: { cuts: Cut[]; from: number; to: number; t: number; pendingStart: number | null; onSeek: (s: number) => void; height: number }) {
  const span = to - from;
  const pct = (s: number) => `${((s - from) / span) * 100}%`;
  return (
    <div
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onSeek(from + ((e.clientX - r.left) / r.width) * span);
      }}
      style={{ position: 'relative', height, marginTop: 10, background: 'var(--panel-2)', borderRadius: 8, cursor: 'pointer', overflow: 'hidden' }}
    >
      {cuts
        .filter((c) => c.end > from && c.start < to)
        .map((c) => (
          <div
            key={c.id}
            title={`${REASON[c.reason].label}: ${hms(c.start)} – ${hms(c.end)}${c.enabled ? '' : ' (disattivato)'}`}
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: pct(Math.max(from, c.start)),
              width: `max(2px, ${((Math.min(to, c.end) - Math.max(from, c.start)) / span) * 100}%)`,
              background: c.enabled ? REASON[c.reason].color : 'transparent',
              border: c.enabled ? 'none' : `1px dashed ${REASON[c.reason].color}`,
              opacity: c.enabled ? 0.85 : 0.7,
            }}
          />
        ))}
      {pendingStart !== null && pendingStart >= from && pendingStart <= to && (
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: pct(Math.min(pendingStart, t)), width: pct(from + Math.abs(t - pendingStart)), background: 'rgba(63,208,201,0.35)' }} />
      )}
      {t >= from && t <= to && <div style={{ position: 'absolute', top: 0, bottom: 0, left: pct(t), width: 2, background: '#fff' }} />}
    </div>
  );
}

function Timeline({ dur, cuts, t, pendingStart, onSeek }: { dur: number; cuts: Cut[]; t: number; pendingStart: number | null; onSeek: (s: number) => void }) {
  return (
    <>
      <Bar cuts={cuts} from={0} to={dur} t={t} pendingStart={pendingStart} onSeek={onSeek} height={30} />
      <div className="row small muted" style={{ justifyContent: 'space-between' }}>
        <span>0:00</span>
        <span>
          {(Object.keys(REASON) as CutReason[])
            .filter((r) => cuts.some((c) => c.reason === r))
            .map((r) => (
              <span key={r} style={{ marginLeft: 10 }}>
                <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: REASON[r].color, marginRight: 4 }} />
                {REASON[r].label}
              </span>
            ))}
        </span>
        <span>{hms(dur)}</span>
      </div>
    </>
  );
}

/** Ingrandimento: due minuti intorno al punto in cui sei, per tagli precisi. */
function Zoom({ dur, cuts, t, pendingStart, onSeek }: { dur: number; cuts: Cut[]; t: number; pendingStart: number | null; onSeek: (s: number) => void }) {
  const from = Math.max(0, Math.min(dur - 120, t - 60));
  const to = Math.min(dur, from + 120);
  return (
    <>
      <Bar cuts={cuts} from={from} to={to} t={t} pendingStart={pendingStart} onSeek={onSeek} height={22} />
      <div className="row small muted" style={{ justifyContent: 'space-between' }}>
        <span>{hms(from)}</span>
        <span>ingrandimento: 2 minuti</span>
        <span>{hms(to)}</span>
      </div>
    </>
  );
}

function TimeInput({ value, onChange }: { value: number; onChange: (s: number) => void }) {
  const [text, setText] = useState(hms(value));
  useEffect(() => setText(hms(value)), [value]);
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const s = parseHms(text);
        if (s === null) setText(hms(value));
        else if (Math.abs(s - value) >= 1) onChange(s);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      style={{ width: 92, fontVariantNumeric: 'tabular-nums' }}
    />
  );
}

function CutRow({ c, t, canSeek, onGo, onChange, onDelete }: { c: Cut; t: number; canSeek: boolean; onGo: () => void; onChange: (p: Partial<Cut>) => void; onDelete: () => void }) {
  const r = REASON[c.reason];
  return (
    <div className="row" style={{ gap: 8, opacity: c.enabled ? 1 : 0.55 }}>
      <input type="checkbox" checked={c.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} style={{ width: 'auto' }} title="Taglio attivo" />
      <span className="chip" style={{ borderColor: r.color, color: r.color, minWidth: 64, textAlign: 'center' }}>
        {r.label}
      </span>
      <TimeInput value={c.start} onChange={(s) => onChange({ start: s })} />
      <span className="muted">→</span>
      <TimeInput value={c.end} onChange={(s) => onChange({ end: s })} />
      <span className="small muted" style={{ width: 60 }}>
        {Math.round(c.end - c.start)} s
      </span>
      <span className="small muted" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {c.note ?? ''}
        {c.edited ? ' · modificato' : ''}
      </span>
      <button className="btn" disabled={!canSeek} onClick={onGo} title="Guarda da 3 s prima del taglio">
        ▶ Guarda
      </button>
      <button className="btn" disabled={!canSeek} onClick={() => onChange({ start: t })}>
        Inizio = {hms(t)}
      </button>
      <button className="btn" disabled={!canSeek} onClick={() => onChange({ end: t })}>
        Fine = {hms(t)}
      </button>
      <button className="btn danger" onClick={onDelete} title="Elimina il taglio">
        ✕
      </button>
    </div>
  );
}

/** Nome del video finale: diventa il nome del file (anche di quello già esportato). */
function TitleInput({ id, title, placeholder, disabled }: { id: string; title: string; placeholder: string; disabled: boolean }) {
  const qc = useQueryClient();
  const show = useToast();
  const [text, setText] = useState(title);
  useEffect(() => setText(title), [title]);
  const save = async () => {
    if (text.trim() === title.trim()) return;
    try {
      await saveGameplayMeta({ data: { id, patch: { title: text } } });
      show(text.trim() ? `Il video finale si chiamerà “${text.trim()}.mp4”` : 'Torna il nome della registrazione');
      await qc.invalidateQueries({ queryKey: ['gameplay'] });
      await qc.invalidateQueries({ queryKey: ['project', id] });
      await qc.invalidateQueries({ queryKey: ['projects'] });
    } catch (e) {
      show((e as Error).message);
      setText(title);
    }
  };
  return (
    <input
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      title="Nome del video finale (e del file .mp4)"
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      style={{ flex: 1, minWidth: 220, maxWidth: 560, fontSize: 18, fontWeight: 600 }}
    />
  );
}

const DUCK_LABEL: Record<Duck, string> = { spento: 'no', leggero: 'leggero (circa −5 dB)', medio: 'medio (circa −7 dB)', forte: 'forte (circa −8 dB)' };

/** Volume della voce e quanto si abbassa il gioco mentre parli: valgono per l’anteprima e per l’export. */
/**
 * Lucianus nel video: quello della registrazione si può togliere (se si è bloccato), e in fondo si può mettere
 * un pezzo registrato a parte. Posizione e grandezza si cambiano nel player (“Posizione e grandezza”).
 */
function FacecamCard({ data, finalDur, save }: { data: GameplayData; finalDur: number; save: (patch: Parameters<typeof saveGameplayMeta>[0]['data']['patch']) => Promise<boolean> }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const o = data.outro;
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Lucianus nel video</h3>
      {data.lucianus ? (
        <label className="row small" style={{ width: 'auto', gap: 6 }}>
          <input type="checkbox" checked={data.facecam} onChange={(e) => void save({ facecam: e.target.checked })} style={{ width: 'auto' }} />
          Mostra il Lucianus della registrazione
          <span className="muted">· toglilo se si è bloccato: la voce resta, sparisce solo l’immagine</span>
        </label>
      ) : (
        <div className="small muted">Nessun file di Lucianus per questa registrazione.</div>
      )}
      <div style={{ marginTop: 12 }}>
        <b className="small">Pezzo finale</b>
        <span className="small muted"> · un Lucianus registrato a parte, sopra gli ultimi secondi del gameplay: il video finisce con lui. La sua voce prende il posto di quella del gameplay in quel tratto, il gioco resta.</span>
      </div>
      {o ? (
        <div className="row small" style={{ marginTop: 8 }}>
          <span className={`chip ${o.missing ? 'warn' : 'teal'}`}>{o.missing ? 'file non trovato' : `${Math.round(o.duration)} s`}</span>
          <code className="small">{o.name}</code>
          <span className="muted">
            da {hms(Math.max(0, finalDur - o.duration))} a {hms(finalDur)} del video finale
          </span>
          <span className="spacer" />
          <button className="btn" disabled={busy} onClick={async () => {
            setBusy(true);
            await save({ outro: null });
            setBusy(false);
          }}>
            Togli
          </button>
        </div>
      ) : (
        <form
          className="row"
          style={{ marginTop: 8 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!path.trim()) return;
            setBusy(true);
            if (await save({ outro: path })) setPath('');
            setBusy(false);
          }}
        >
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Percorso del file, per esempio ~/Movies/Lucianus_2026-11-22 19-51-52.mp4" style={{ flex: 1 }} />
          <button className="btn" disabled={busy || !path.trim()}>
            Metti in fondo
          </button>
        </form>
      )}
    </div>
  );
}

function MixCard({ id, mix }: { id: string; mix: AudioMix }) {
  const qc = useQueryClient();
  const show = useToast();
  const [draft, setDraft] = useState(mix);
  useEffect(() => setDraft(mix), [mix.voiceDb, mix.duck, mix.clear, mix.eq]); // eslint-disable-line react-hooks/exhaustive-deps
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const change = (next: AudioMix) => {
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        await saveGameplayMeta({ data: { id, patch: { mix: next } } });
        await qc.invalidateQueries({ queryKey: ['gameplay', id] });
      } catch (e) {
        show((e as Error).message);
      }
    }, 400);
  };
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Voce e gioco nel video finale</h3>
      <div className="row" style={{ gap: 18 }}>
        <label className="row small" style={{ width: 'auto', gap: 8 }}>
          Voce
          <input type="range" min={-6} max={12} step={0.5} value={draft.voiceDb} onChange={(e) => change({ ...draft, voiceDb: Number(e.target.value) })} style={{ width: 200 }} />
          <b style={{ width: 64, fontVariantNumeric: 'tabular-nums' }}>
            {draft.voiceDb > 0 ? '+' : ''}
            {draft.voiceDb} dB
          </b>
        </label>
        <label className="row small" style={{ width: 'auto', gap: 8 }}>
          Abbassa il gioco mentre parli
          <select value={draft.duck} onChange={(e) => change({ ...draft, duck: e.target.value as Duck })} style={{ width: 'auto' }}>
            {(Object.keys(DUCK_LABEL) as Duck[]).map((d) => (
              <option key={d} value={d}>
                {DUCK_LABEL[d]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row small" style={{ marginTop: 12, gap: 8 }}>
        <span>Tipo di voce</span>
        <div className="seg">
          <button aria-pressed={!draft.clear} onClick={() => change({ ...draft, clear: false })} title="Senza equalizzazione: solo pulizia e compressione morbida (tasto 0 nel player)">
            Spenta
          </button>
          {PRESET_KEYS.map((p, i) => (
            <button key={p} aria-pressed={draft.clear && (draft.eq ?? 'chiara') === p} onClick={() => change({ ...draft, clear: true, eq: p })} title={`${VOICE_PRESETS[p].hint} (tasto ${i + 1} nel player)`}>
              {VOICE_PRESETS[p].label}
            </button>
          ))}
        </div>
        <span className="muted">{draft.clear ? VOICE_PRESETS[draft.eq ?? 'chiara'].hint : 'Nessuna equalizzazione: solo pulizia e compressione morbida.'}</span>
      </div>
      <div className="small muted" style={{ marginTop: 8 }}>
        La voce viene compressa (livello costante) e alzata di quanto scegli; il gioco scende da solo mentre parli e risale nelle pause. Il video finale poi esce a −14 LUFS con i picchi sotto −1,5 dBTP. Nel player (Tracce) senti subito equalizzazione e compressione della voce, con i tasti 0–7; il compressore sul gioco di Anti-picchi, Morbida e Radio si sente solo nel mix finale da ascoltare o in una prova di 30 s.
      </div>
    </div>
  );
}

type GameplayData = ReturnType<typeof useGameplayData>;
function useGameplayData(id: string) {
  return useSuspenseQuery(q.gameplay(id)).data;
}

async function copy(text: string, show: (m: string) => void, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    show(`${what} copiato`);
  } catch {
    show('Non riesco a copiare: seleziona il testo e copialo a mano');
  }
}

/** Descrizione del gameplay, miniature di riferimento e generazione di titolo e prompt per Higgsfield. */
function YoutubeCard({ id, data }: { id: string; data: GameplayData }) {
  const qc = useQueryClient();
  const show = useToast();
  const [text, setText] = useState(data.edit?.description ?? '');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const saved = data.edit?.description ?? '';
  useEffect(() => setText(saved), [saved]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['gameplay', id] });
  const saveText = async () => {
    if (text === saved) return;
    await saveGameplayMeta({ data: { id, patch: { description: text } } });
    await refresh();
  };
  const generate = async () => {
    setBusy(true);
    try {
      await saveText();
      await generateGameplayYoutube({ data: id });
      await refresh();
      show('Titoli e prompt pronti');
    } catch (e) {
      show((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const upload = async (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      const base64 = await new Promise<string>((ok, ko) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(',')[1] ?? '');
        r.onerror = () => ko(r.error);
        r.readAsDataURL(f);
      });
      try {
        await addReference({ data: { name: f.name, base64 } });
      } catch (e) {
        show((e as Error).message);
      }
    }
    await refresh();
  };
  const y = data.youtube;
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Titolo e miniatura per YouTube</h3>
      <div className="small muted" style={{ marginBottom: 6 }}>
        Di cosa parla questo gameplay: cosa succede, i momenti migliori, cosa vuoi che risalti nella miniatura.
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} onBlur={saveText} rows={5} placeholder="Es.: prima sera su GTA 6, giro Vice City con Jason, inseguimento assurdo con la polizia verso le Keys…" style={{ width: '100%' }} />

      <div className="row small" style={{ marginTop: 12, gap: 8 }}>
        <b>Miniature di riferimento</b>
        <span className="muted">di altri youtuber, per lo stile ({data.references.length})</span>
        <span className="spacer" />
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" multiple style={{ display: 'none' }} onChange={(e) => void upload(e.target.files).then(() => (e.target.value = ''))} />
        <button className="btn" onClick={() => file.current?.click()}>
          + Aggiungi immagini
        </button>
        <button className="btn" onClick={() => void revealInFinder({ data: 'riferimenti' })}>
          Apri la cartella
        </button>
      </div>
      <div
        className="row"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void upload(e.dataTransfer.files);
        }}
        style={{ marginTop: 8, gap: 8, minHeight: 70, padding: 8, border: '1px dashed var(--line, #444)', borderRadius: 10 }}
      >
        {data.references.length === 0 && <span className="small muted">Trascina qui le miniature che ti piacciono, oppure mettile nella cartella.</span>}
        {data.references.map((r) => (
          <div key={r.path} style={{ position: 'relative' }}>
            <img src={r.url} alt={r.name} title={r.name} style={{ height: 72, borderRadius: 6, display: 'block' }} />
            <button
              className="btn danger"
              title="Togli (va nel Cestino)"
              onClick={async () => {
                await removeReference({ data: r.path });
                await refresh();
              }}
              style={{ position: 'absolute', top: 2, right: 2, padding: '0 6px', lineHeight: '18px' }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="row small" style={{ marginTop: 8, gap: 8 }}>
        <span className="muted">Screenshot ufficiali di Rockstar: {data.rockstar}</span>
        <button className="btn" onClick={() => void revealInFinder({ data: 'rockstar' })}>
          Apri la cartella
        </button>
        <span className="spacer" />
        <button className="btn primary" disabled={busy || !text.trim()} onClick={generate}>
          {busy ? 'Genero… (1-3 minuti)' : y ? 'Rigenera titolo e prompt' : 'Genera titolo e prompt'}
        </button>
      </div>

      {y && (
        <div className="grid" style={{ gap: 10, marginTop: 14 }}>
          <div>
            <b className="small">Titoli</b>
            {y.titles.map((t) => (
              <div key={t.title} className="row" style={{ gap: 8, marginTop: 6 }}>
                <span style={{ fontWeight: 600 }}>{t.title}</span>
                <span className="small muted" style={{ flex: 1 }}>
                  {t.title.length} caratteri · {t.why}
                </span>
                <button className="btn" onClick={() => void copy(t.title, show, 'Titolo')}>
                  Copia
                </button>
                <button
                  className="btn"
                  title="Usa questo titolo anche come nome del video finale"
                  onClick={async () => {
                    try {
                      await saveGameplayMeta({ data: { id, patch: { title: t.title } } });
                      await qc.invalidateQueries({ queryKey: ['gameplay'] });
                      show('Nome del video aggiornato');
                    } catch (e) {
                      show((e as Error).message);
                    }
                  }}
                >
                  Usa come nome
                </button>
              </div>
            ))}
          </div>
          <div>
            <div className="row small" style={{ gap: 8 }}>
              <b>Prompt per Higgsfield</b>
              <span className="muted">Nano Banana Pro, 16:9{y.thumbnail.text ? ` · testo: “${y.thumbnail.text}”` : ' · senza testo'}</span>
              <span className="spacer" />
              <button className="btn primary" onClick={() => void copy(y.thumbnail.prompt, show, 'Prompt')}>
                Copia il prompt
              </button>
            </div>
            <textarea readOnly value={y.thumbnail.prompt} rows={6} style={{ width: '100%', marginTop: 6 }} />
          </div>
          <div>
            <b className="small">Immagini da caricare su Higgsfield, in quest’ordine</b>
            <div className="row" style={{ gap: 10, marginTop: 6 }}>
              {y.thumbnail.upload.map((u, i) => (
                <div key={u.file} className="small" style={{ width: 170 }}>
                  {u.url ? <img src={u.url} alt="" style={{ width: '100%', borderRadius: 6, background: '#222' }} /> : <div className="empty">non trovata</div>}
                  <div>
                    <b>{i + 1}.</b> {u.role}
                  </div>
                  <button className="btn" style={{ marginTop: 4 }} onClick={() => void revealInFinder({ data: u.file })}>
                    Mostra nel Finder
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="small muted">
            {y.thumbnail.notes} · generato {when(y.generated_at)} con {y.route}
          </div>
        </div>
      )}
    </div>
  );
}

/** Gameplay senza più la registrazione: la copia a 720p del video finale e il lavoro fatto, in sola lettura. */
function ReviewCard({ data }: { data: GameplayData }) {
  const e = data.edit!;
  const cuts = [...e.cuts].sort((a, b) => a.start - b.start);
  return (
    <div className="card">
      {data.archive ? (
        <video src={data.archive.url} controls playsInline preload="metadata" style={{ width: '100%', maxHeight: '62vh', background: '#000', borderRadius: 10 }} />
      ) : (
        <div className="empty">Non c’è una copia da rivedere: il video è stato esportato prima che si facesse, o non è mai stato esportato.</div>
      )}
      <div className="small muted" style={{ marginTop: 8 }}>
        Video finale di {hms(data.final ?? 0)} · voce {data.mix.voiceDb > 0 ? '+' : ''}
        {data.mix.voiceDb} dB, gioco abbassato mentre parli: {data.mix.duck}
      </div>
      <h3>Tagli</h3>
      {cuts.length === 0 && <div className="empty">Nessun taglio.</div>}
      <div className="grid" style={{ gap: 4 }}>
        {cuts.map((c) => (
          <div key={c.id} className="row small" style={{ gap: 8, opacity: c.enabled ? 1 : 0.55 }}>
            <span className="chip" style={{ borderColor: REASON[c.reason].color, color: REASON[c.reason].color, minWidth: 64, textAlign: 'center' }}>
              {REASON[c.reason].label}
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {hms(c.start)} → {hms(c.end)}
            </span>
            <span className="muted">
              {Math.round(c.end - c.start)} s{c.enabled ? '' : ' · disattivato'}
              {c.note ? ` · ${c.note}` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
