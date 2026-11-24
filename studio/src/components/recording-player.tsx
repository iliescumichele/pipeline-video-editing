// Anteprima del gameplay senza render: la registrazione 4K originale (il browser la decodifica in hardware),
// Lucianus disegnato sopra con lo stesso scontorno del verde di ffmpeg (WebGL). L'audio, come nel mixer di OBS:
// il gioco dalla traccia 1 della registrazione e la voce dal file di Lucianus, ognuno con mute e volume, senza
// preparare niente; oppure il mix del video finale, se è stato preparato. Il video principale comanda: audio e
// Lucianus lo seguono in play, pausa, salti e tagli. Posizione e grandezza di Lucianus si cambiano qui,
// trascinandolo: valgono anche per il video finale. Il pezzo finale (un Lucianus registrato a parte) compare
// negli ultimi secondi del video finale, con la sua voce al posto di quella del gameplay.
import { type PointerEvent as ReactPointerEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { Look } from '../../../src/gameplay/edit';
import { VOICE_PRESETS, type VoicePreset, voiceProfile } from '../../../src/lib/voice-eq';

// Gli stessi valori di LOOK in src/gameplay/edit.ts (che qui non si importa: usa il file system):
// crop 'iw-24:ih-18:12:6', colorkey=0x00B140:0.22:0.08.
const CROP = { left: 12, top: 6, right: 12, bottom: 12 };
const KEY = { color: [0x00 / 255, 0xb1 / 255, 0x40 / 255], similarity: 0.22, blend: 0.08 };
/** LUCIANUS_ASPECT di edit.ts: il file di Lucianus senza i bordi, 1056×1278 */
const LUC_ASPECT = 1056 / 1278;
/** larghezza di Lucianus in frazioni della larghezza del video 16:9, data l'altezza in frazioni */
const widthOf = (h: number) => h * (9 / 16) * LUC_ASPECT;
const clampLook = (l: Look): Look => ({
  h: Math.min(1.5, Math.max(0.05, l.h)),
  x: Math.min(0.98, Math.max(-0.9, l.x)),
  y: Math.min(0.98, Math.max(-0.9, l.y)),
});

/** Secondo del video finale che corrisponde al secondo `t` della registrazione. */
const toFinal = (removed: [number, number][], t: number) => t - removed.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, t) - a), 0);

export interface OutroView {
  url: string;
  /** secondo del video finale in cui parte */
  start: number;
  duration: number;
}

const VERT = `attribute vec2 p; varying vec2 uv; uniform vec4 crop;
void main() { uv = vec2(mix(crop.x, crop.z, (p.x + 1.0) / 2.0), mix(crop.w, crop.y, (p.y + 1.0) / 2.0)); gl_Position = vec4(p, 0.0, 1.0); }`;
// come vf_colorkey di ffmpeg: distanza RGB normalizzata, trasparente sotto la soglia, sfumata per `blend`
const FRAG = `precision mediump float; varying vec2 uv; uniform sampler2D tex; uniform vec3 key; uniform vec2 sb;
void main() { vec4 c = texture2D(tex, uv); float d = distance(c.rgb, key) / sqrt(3.0);
  float a = d < sb.x ? 0.0 : (sb.y > 0.0 ? clamp((d - sb.x) / sb.y, 0.0, 1.0) : 1.0); gl_FragColor = vec4(c.rgb * a, a); }`;

/** `src`: il file che si sta scontornando; se cambia (o compare dopo) si ricomincia. */
function useKeyer(canvas: RefObject<HTMLCanvasElement | null>, source: RefObject<HTMLVideoElement | null>, src: string | null) {
  useEffect(() => {
    const cv = canvas.current;
    const v = source.current;
    if (!cv || !v) return;
    const gl = cv.getContext('webgl', { premultipliedAlpha: true, alpha: true });
    if (!gl) return;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    for (const [k, val] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const) gl.texParameteri(gl.TEXTURE_2D, k, val);
    gl.uniform3fv(gl.getUniformLocation(prog, 'key'), KEY.color);
    gl.uniform2f(gl.getUniformLocation(prog, 'sb'), KEY.similarity, KEY.blend);
    const cropLoc = gl.getUniformLocation(prog, 'crop');

    let stop = false;
    let handle = 0;
    const draw = () => {
      if (stop) return;
      if (v.readyState >= 2 && v.videoWidth) {
        const w = v.videoWidth - CROP.left - CROP.right;
        const h = v.videoHeight - CROP.top - CROP.bottom;
        if (cv.width !== Math.round(w / 2)) {
          cv.width = Math.round(w / 2);
          cv.height = Math.round(h / 2);
          gl.viewport(0, 0, cv.width, cv.height);
        }
        gl.uniform4f(cropLoc, CROP.left / v.videoWidth, CROP.top / v.videoHeight, 1 - CROP.right / v.videoWidth, 1 - CROP.bottom / v.videoHeight);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      handle = 'requestVideoFrameCallback' in v ? v.requestVideoFrameCallback(draw) : requestAnimationFrame(draw);
    };
    draw();
    // a video fermo requestVideoFrameCallback non scatta: si ridisegna dopo ogni salto
    v.addEventListener('seeked', draw);
    return () => {
      stop = true;
      v.removeEventListener('seeked', draw);
      if ('cancelVideoFrameCallback' in v) v.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
    };
  }, [canvas, source, src]);
}

/** Volumi del mixer dell'anteprima: valgono solo per ascoltare, l'export usa quelli di "Voce e gioco". */
interface Mixer {
  /** 'tracce': gioco e voce separati; 'mix': il mix del video finale preparato sul server */
  mode: 'tracce' | 'mix';
  game: number;
  gameMuted: boolean;
  /** guadagno della voce: fino a 3 (+9,5 dB), perché la voce del file di Lucianus è circa 7 dB sotto il gioco */
  voice: number;
  voiceMuted: boolean;
}
const MIXER_DEFAULT: Mixer = { mode: 'tracce', game: 0.7, gameMuted: false, voice: 1.8, voiceMuted: false };
const MIXER_KEY = 'anteprima-mixer';
const VOICE_MAX = 3;

function readMixer(): Mixer {
  try {
    return { ...MIXER_DEFAULT, ...(JSON.parse(localStorage.getItem(MIXER_KEY) ?? '{}') as Partial<Mixer>) };
  } catch {
    return MIXER_DEFAULT;
  }
}

const db = (g: number) => (g <= 0 ? '−∞' : `${g >= 1 ? '+' : '−'}${Math.abs(20 * Math.log10(g)).toFixed(1).replace('.', ',')} dB`);

const PRESETS = Object.keys(VOICE_PRESETS) as VoicePreset[];

/** Il volume della voce grezza nel browser è circa 8 dB sotto quello a cui ffmpeg la porta prima di comprimerla. */
const PREVIEW_LEVEL_DB = -8;

/**
 * La voce passa da Web Audio per poterla alzare oltre il 100% e per sentire il tipo di voce scelto: la stessa
 * equalizzazione dell'export e una compressione simile (DynamicsCompressorNode). Il contesto audio si può accendere
 * solo dopo un gesto (clic o tasto): fino ad allora la voce esce dall'elemento, al massimo al suo volume pieno e
 * senza equalizzazione.
 */
function useVoiceGain(el: RefObject<HTMLVideoElement | null>, gain: number, muted: boolean, active: boolean, clear: boolean, preset: VoicePreset) {
  const graph = useRef<{ ctx: AudioContext; src: MediaElementAudioSourceNode; chain: AudioNode[]; node: GainNode } | null>(null);
  const settings = useRef({ clear, preset });
  // sorgente → (equalizzazione → compressione → compensazione) → volume → uscita
  const wire = useCallback(() => {
    const g = graph.current;
    if (!g) return;
    g.src.disconnect();
    for (const n of g.chain) n.disconnect();
    g.chain = [];
    // "Già pulita in OBS": la voce passa com'è
    if (settings.current.clear && !voiceProfile(settings.current.preset).raw) {
      const p = voiceProfile(settings.current.preset);
      for (const b of p.previewBands ?? p.bands) {
        const f = g.ctx.createBiquadFilter();
        f.type = b.type;
        f.frequency.value = b.f;
        if (b.type === 'highpass') f.Q.value = Math.SQRT1_2;
        if (b.type === 'peaking') f.Q.value = b.q;
        if (b.type !== 'highpass') f.gain.value = b.g;
        g.chain.push(f);
      }
      const c = g.ctx.createDynamicsCompressor();
      c.threshold.value = Math.max(-100, p.preview.threshold + PREVIEW_LEVEL_DB);
      c.ratio.value = Math.min(20, p.preview.ratio);
      c.attack.value = p.preview.attack;
      c.release.value = p.preview.release;
      c.knee.value = p.preview.knee;
      // i tipi che comprimono di più si alzano di quanto abbassano, come nell'export
      const makeup = g.ctx.createGain();
      makeup.gain.value = 10 ** ((p.loss - VOICE_PRESETS.chiara.loss) / 20);
      g.chain.push(c, makeup);
    }
    let at: AudioNode = g.src;
    for (const n of g.chain) at = at.connect(n);
    at.connect(g.node);
  }, []);
  useEffect(() => {
    settings.current = { clear, preset };
    wire();
  }, [clear, preset, wire]);
  const [boosted, setBoosted] = useState(false);
  const apply = useCallback(() => {
    const v = el.current;
    if (!v) return;
    const g = active && !muted ? gain : 0;
    if (graph.current) {
      graph.current.node.gain.setTargetAtTime(g, graph.current.ctx.currentTime, 0.015);
      v.muted = false;
      v.volume = 1;
    } else {
      v.muted = g === 0;
      v.volume = Math.min(1, g);
    }
  }, [el, gain, muted, active]);
  useEffect(apply, [apply]);
  useEffect(() => {
    const unlock = () => {
      const v = el.current;
      if (!v) return;
      try {
        if (!graph.current) {
          const ctx = new AudioContext();
          const node = ctx.createGain();
          node.connect(ctx.destination);
          graph.current = { ctx, src: ctx.createMediaElementSource(v), chain: [], node };
          wire();
          setBoosted(true);
          apply();
        }
        if (graph.current.ctx.state !== 'running') void graph.current.ctx.resume();
      } catch {
        // senza Web Audio la voce resta sull'elemento, fino al 100%
      }
    };
    addEventListener('pointerdown', unlock, true);
    addEventListener('keydown', unlock, true);
    return () => {
      removeEventListener('pointerdown', unlock, true);
      removeEventListener('keydown', unlock, true);
    };
  }, [el, apply, wire]);
  return boosted;
}

export function RecordingPlayer({
  video,
  src,
  lucianus,
  offsetMs,
  audio,
  clearVoice,
  onClearVoice,
  preset,
  onPreset,
  onTime,
  look,
  defaultLook,
  onLook,
  facecam,
  outro,
  removed,
}: {
  video: RefObject<HTMLVideoElement | null>;
  src: string;
  lucianus: string | null;
  offsetMs: number;
  /** mix del video finale preparato sul server, se c'è */
  audio: string | null;
  /** "Voce più chiara" del gameplay: si sente anche qui, e si cambia anche dal mixer */
  clearVoice: boolean;
  onClearVoice: (clear: boolean) => void;
  /** tipo di voce (equalizzazione e compressione); onPreset(null) la spegne */
  preset: VoicePreset;
  onPreset: (preset: VoicePreset | null) => void;
  onTime: () => void;
  /** posizione e grandezza di Lucianus (anche nel video finale) */
  look: Look;
  defaultLook: Look;
  /** null: torna alla posizione di prima */
  onLook: (look: Look | null) => void;
  /** il Lucianus della registrazione si vede (false se si è bloccato: resta solo la sua voce) */
  facecam: boolean;
  outro: OutroView | null;
  /** tratti tolti, in secondi della registrazione: servono per sapere dove cade il pezzo finale */
  removed: [number, number][];
}) {
  const luc = useRef<HTMLVideoElement>(null);
  const snd = useRef<HTMLAudioElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const outroVideo = useRef<HTMLVideoElement>(null);
  const outroCanvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [inOutro, setInOutro] = useState(false);
  const [editing, setEditing] = useState(false);
  // posizione mentre la si cambia; quella salvata arriva da `look`
  const [draft, setDraft] = useState<Look | null>(null);
  const shown = draft ?? look;
  useKeyer(outroCanvas, outroVideo, outro?.url ?? null);
  const [error, setError] = useState<string | null>(null);
  const [mixer, setMixerState] = useState<Mixer>(MIXER_DEFAULT);
  useEffect(() => setMixerState(readMixer()), []);
  const setMixer = useCallback((patch: Partial<Mixer>) => {
    setMixerState((m) => {
      const next = { ...m, ...patch };
      try {
        localStorage.setItem(MIXER_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  useKeyer(canvas, luc, lucianus);
  const mode = mixer.mode === 'mix' && audio ? 'mix' : 'tracce';
  // nel pezzo finale parla lui: la voce del gameplay tace (come nel video finale)
  const boosted = useVoiceGain(luc, mixer.voice, mixer.voiceMuted || inOutro, mode === 'tracce', clearVoice, preset);

  // voce del pezzo finale: dal suo file, al volume della voce (fino al 100%)
  useEffect(() => {
    const o = outroVideo.current;
    if (!o) return;
    o.muted = mode === 'mix' || mixer.voiceMuted;
    o.volume = Math.min(1, mixer.voice);
  }, [mode, mixer.voice, mixer.voiceMuted, outro]);

  // Trascinare Lucianus (o il suo angolo, per la grandezza) nel riquadro del video
  const drag = useRef<{ kind: 'move' | 'size'; x: number; y: number; start: Look } | null>(null);
  const onDown = (kind: 'move' | 'size') => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { kind, x: e.clientX, y: e.clientY, start: shown };
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const box = frame.current?.getBoundingClientRect();
    if (!d || !box) return;
    const dx = (e.clientX - d.x) / box.width;
    const dy = (e.clientY - d.y) / box.height;
    setDraft(clampLook(d.kind === 'move' ? { ...d.start, x: d.start.x + dx, y: d.start.y + dy } : { ...d.start, h: d.start.h + dy }));
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    if (draft) onLook(draft);
  };
  // la grandezza dal cursore tiene fermo il centro di Lucianus
  const resize = (h: number) => {
    const cx = shown.x + widthOf(shown.h) / 2;
    const cy = shown.y + shown.h / 2;
    const next = clampLook({ h, x: cx - widthOf(h) / 2, y: cy - h / 2 });
    setDraft(next);
    return next;
  };
  // quando arriva la posizione salvata, la bozza non serve più
  useEffect(() => setDraft(null), [look.x, look.y, look.h]);
  const lookStyle = { left: `${shown.x * 100}%`, top: `${shown.y * 100}%`, height: `${shown.h * 100}%`, aspectRatio: '1056 / 1278' } as const;

  // gioco: la traccia 1 della registrazione, nel video principale
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.muted = mode === 'mix' || mixer.gameMuted;
    v.volume = mixer.game;
  }, [video, mode, mixer.game, mixer.gameMuted]);

  // G e V: mute veloce di gioco e voce; C: equalizzazione sì o no; 0–7: tipo di voce (fuori dai campi di testo)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || mode !== 'tracce') return;
      if (e.key.toLowerCase() === 'g') setMixer({ gameMuted: !mixer.gameMuted });
      else if (e.key.toLowerCase() === 'v' && lucianus) setMixer({ voiceMuted: !mixer.voiceMuted });
      else if (e.key.toLowerCase() === 'c' && lucianus) onClearVoice(!clearVoice);
      else if (/^[0-9]$/.test(e.key) && Number(e.key) <= PRESETS.length && lucianus) onPreset(e.key === '0' ? null : PRESETS[Number(e.key) - 1]!);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [mode, mixer.gameMuted, mixer.voiceMuted, lucianus, setMixer, clearVoice, onClearVoice, onPreset]);

  // Audio e Lucianus seguono il video principale (Lucianus in ritardo di offsetMs, come nell'export).
  // Gli scarti piccoli si recuperano cambiando appena la velocità, senza salti che si sentono; quelli grandi
  // (un taglio saltato, un salto nel video) con un salto.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const followers = () => [
      ...(mode === 'mix' && snd.current ? [{ el: snd.current as HTMLMediaElement, at: (t: number) => t }] : []),
      ...(luc.current ? [{ el: luc.current as HTMLMediaElement, at: (t: number) => t - offsetMs / 1000 }] : []),
      // il pezzo finale sta nel tempo del video finale: senza i tratti tolti
      ...(outro && outroVideo.current ? [{ el: outroVideo.current as HTMLMediaElement, at: (t: number) => toFinal(removed, t) - outro.start }] : []),
    ];
    const sync = (force: boolean) => {
      if (outro) {
        const o = toFinal(removed, v.currentTime) - outro.start;
        setInOutro(o >= 0 && o < outro.duration);
      } else setInOutro(false);
      for (const f of followers()) {
        const t = f.at(v.currentTime);
        if (t < 0 || (f.el.duration && t >= f.el.duration)) {
          if (!f.el.paused) f.el.pause();
          continue;
        }
        const drift = f.el.currentTime - t;
        if (force || Math.abs(drift) > 0.3) {
          f.el.currentTime = t;
          f.el.playbackRate = v.playbackRate;
        } else if (!v.paused && Math.abs(drift) > 0.03) f.el.playbackRate = v.playbackRate * (drift > 0 ? 0.97 : 1.03);
        else f.el.playbackRate = v.playbackRate;
        if (v.paused !== f.el.paused) {
          if (v.paused) f.el.pause();
          // senza un gesto il browser può rifiutare l'audio: Lucianus riparte muto, l'immagine non si ferma
          else
            void f.el.play().catch((err: Error) => {
              if (err.name !== 'NotAllowedError' || f.el.muted) return;
              f.el.muted = true;
              void f.el.play().catch(() => {});
            });
        }
      }
      if (mode !== 'mix' && snd.current && !snd.current.paused) snd.current.pause();
    };
    const hard = () => sync(true);
    const soft = () => sync(false);
    const events = ['play', 'pause', 'seeking', 'seeked', 'ratechange'] as const;
    for (const e of events) v.addEventListener(e, hard);
    const timer = setInterval(soft, 250);
    hard();
    return () => {
      for (const e of events) v.removeEventListener(e, hard);
      clearInterval(timer);
    };
  }, [video, offsetMs, audio, lucianus, mode, outro, removed]);

  return (
    <div style={{ width: 'min(100%, calc(62vh * 16 / 9))', margin: '0 auto' }}>
      <div ref={frame} style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: '#000', borderRadius: 10, overflow: 'hidden' }}>
        <video
          ref={video}
          src={src}
          onTimeUpdate={onTime}
          onSeeked={onTime}
          onError={() => setError('Questo browser non riesce a riprodurre la registrazione originale (HEVC 4K con audio PCM). Apri la dashboard in Safari.')}
          controls
          playsInline
          preload="metadata"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        />
        {lucianus && (
          <>
            <video ref={luc} src={lucianus} playsInline preload="auto" style={{ display: 'none' }} />
            <canvas
              ref={canvas}
              style={{
                position: 'absolute',
                ...lookStyle,
                pointerEvents: 'none',
                // tolto dal video: si vede solo mentre lo sposti, come riferimento
                visibility: (facecam && !inOutro) || (editing && !inOutro) ? 'visible' : 'hidden',
                opacity: facecam ? 1 : 0.35,
              }}
            />
          </>
        )}
        {outro && (
          <>
            <video ref={outroVideo} src={outro.url} playsInline preload="auto" style={{ display: 'none' }} />
            <canvas ref={outroCanvas} style={{ position: 'absolute', ...lookStyle, pointerEvents: 'none', visibility: inOutro ? 'visible' : 'hidden' }} />
          </>
        )}
        {editing && (
          <div
            onPointerDown={onDown('move')}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            title="Trascina per spostare Lucianus"
            style={{ position: 'absolute', ...lookStyle, border: '2px dashed var(--amber, #ffb547)', borderRadius: 6, cursor: 'move', touchAction: 'none', boxSizing: 'border-box' }}
          >
            <div
              onPointerDown={onDown('size')}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              title="Trascina per ingrandire o rimpicciolire"
              style={{ position: 'absolute', right: -9, bottom: -9, width: 18, height: 18, borderRadius: 4, background: 'var(--amber, #ffb547)', cursor: 'nwse-resize', touchAction: 'none' }}
            />
          </div>
        )}
        {audio && <audio ref={snd} src={audio} preload="auto" />}
        {error && (
          <div className="empty" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 20, textAlign: 'center' }}>
            {error}
          </div>
        )}
      </div>
      {(lucianus || outro) && (
        <div className="mixer">
          <button className="btn" aria-pressed={editing} onClick={() => setEditing(!editing)} title="Sposta Lucianus trascinandolo nel video; l'angolo in basso a destra lo ingrandisce. Vale anche per il video finale.">
            {editing ? '✓ Fatto' : '✥ Posizione e grandezza'}
          </button>
          {editing && (
            <>
              <div className="channel">
                <span className="small muted">Grandezza</span>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.01}
                  value={Math.min(1, shown.h)}
                  onChange={(e) => resize(Number(e.target.value))}
                  onPointerUp={() => draft && onLook(draft)}
                  onKeyUp={() => draft && onLook(draft)}
                  aria-label="Grandezza di Lucianus"
                />
                <span className="small muted" style={{ minWidth: 58, textAlign: 'right' }}>
                  {Math.round(shown.h * 100)}% dell’altezza
                </span>
              </div>
              <button
                className="btn"
                onClick={() => {
                  setDraft(defaultLook);
                  onLook(null);
                }}
              >
                Ripristina
              </button>
            </>
          )}
          {!editing && !facecam && lucianus && <span className="small muted">Lucianus della registrazione tolto dal video: resta la sua voce.</span>}
          {!editing && outro && <span className="small muted">Pezzo finale negli ultimi {Math.round(outro.duration)} s del video finale.</span>}
        </div>
      )}
      <div className="mixer">
        {audio && (
          <div className="seg" title="Tracce: gioco e voce separati, come in OBS. Mix finale: quello che uscirà nel video, con voce compressa e gioco abbassato mentre parli.">
            <button aria-pressed={mode === 'tracce'} onClick={() => setMixer({ mode: 'tracce' })}>
              Tracce
            </button>
            <button aria-pressed={mode === 'mix'} onClick={() => setMixer({ mode: 'mix' })}>
              Mix finale
            </button>
          </div>
        )}
        {mode === 'tracce' ? (
          <>
            <Channel
              label="Gioco"
              hint="G"
              muted={mixer.gameMuted}
              value={mixer.game}
              max={1}
              onMute={() => setMixer({ gameMuted: !mixer.gameMuted })}
              onChange={(game) => setMixer({ game })}
            />
            {lucianus ? (
              <Channel
                label="Voce"
                hint="V"
                muted={mixer.voiceMuted}
                value={mixer.voice}
                max={boosted ? VOICE_MAX : 1}
                onMute={() => setMixer({ voiceMuted: !mixer.voiceMuted })}
                onChange={(voice) => setMixer({ voice })}
              />
            ) : null}
            {lucianus && (
              <label className="row small" style={{ width: 'auto', gap: 6 }} title="Equalizzazione e compressione della voce, come nel video finale e negli short. Tasti 1–7 per cambiarla al volo, 0 per spegnerla, C per confrontare. Vale per questo video.">
                Voce
                <select
                  value={clearVoice ? preset : 'spenta'}
                  onChange={(e) => onPreset(e.target.value === 'spenta' ? null : (e.target.value as VoicePreset))}
                  style={{ width: 'auto' }}
                >
                  <option value="spenta">0 · Spenta</option>
                  {PRESETS.map((p, i) => (
                    <option key={p} value={p}>
                      {i + 1} · {VOICE_PRESETS[p].label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {lucianus ? null : (
              <span className="small muted">Voce: senza il file di Lucianus si sente solo preparando il mix.</span>
            )}
          </>
        ) : (
          <span className="small muted">Stai ascoltando il mix del video finale: voce compressa, gioco abbassato mentre parli, −14 LUFS.</span>
        )}
      </div>
    </div>
  );
}

function Channel({ label, hint, muted, value, max, onMute, onChange }: { label: string; hint: string; muted: boolean; value: number; max: number; onMute: () => void; onChange: (v: number) => void }) {
  return (
    <div className={`channel ${muted ? 'muted' : ''}`}>
      <button className="btn" aria-pressed={muted} onClick={onMute} title={`${muted ? 'Riattiva' : 'Muta'} (tasto ${hint})`}>
        {muted ? '🔇' : '🔊'} {label}
      </button>
      <input type="range" min={0} max={max} step={0.05} value={Math.min(value, max)} onChange={(e) => onChange(Number(e.target.value))} aria-label={`Volume ${label}`} />
      <span className="small muted" style={{ minWidth: 58, textAlign: 'right' }}>
        {muted ? 'muto' : db(Math.min(value, max))}
      </span>
    </div>
  );
}
