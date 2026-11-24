// Voce "pulita YouTube": scelta a orecchio il 21/11/2026 fra quattro versioni della stessa presa (Insta360 Mic Pro
// con il pelo, receiver 0, transmitter +4, riduzione rumore del microfono spenta, OBS senza filtri sulla voce).
// La presa era scura (3–5 kHz 12 dB sotto i medi, alti spenti sopra i 10 kHz: pelo e posizione sotto il mento) con un
// accumulo sui 300 Hz. Nessun import: la usano sia ffmpeg sia il browser (Web Audio, solo l'equalizzazione).

export type VoiceBand =
  | { type: 'highpass'; f: number }
  | { type: 'lowshelf' | 'highshelf'; f: number; g: number }
  | { type: 'peaking'; f: number; q: number; g: number };

export const CLEAR_VOICE: VoiceBand[] = [
  // due passa-alto a 2 poli: 24 dB/ottava sotto gli 80 Hz (colpi e rimbombo, il corpo della voce resta)
  { type: 'highpass', f: 80 },
  { type: 'highpass', f: 80 },
  // bassi: in OBS la voce ha un rigonfiamento stretto sui 100 Hz, circa 8 dB sopra il resto (troppi bassi, 21/11)
  { type: 'peaking', f: 100, q: 1.4, g: -4 },
  // il "petto" del microfono sotto il mento
  { type: 'peaking', f: 300, q: 1, g: -3 },
  // presenza: è qui che le parole si capiscono
  { type: 'peaking', f: 3200, q: 0.9, g: 4 },
  // aria, quella che il pelo toglie
  { type: 'highshelf', f: 9000, g: 5 },
];

/** Un'equalizzazione come catena di filtri di ffmpeg (di base quella "chiara"). */
export const clearVoiceFilter = (bands: VoiceBand[] = CLEAR_VOICE): string =>
  bands.map((b) =>
    b.type === 'highpass' ? `highpass=f=${b.f}:poles=2` : b.type === 'peaking' ? `equalizer=f=${b.f}:t=q:w=${b.q}:g=${b.g}` : `${b.type}=f=${b.f}:g=${b.g}`,
  ).join(',');

/**
 * Volume della voce grezza (LUFS, misurata in stereo come la registra OBS) su cui sono tarate le soglie qui sotto:
 * prima di tutto la voce si porta qui, così la catena suona uguale con qualunque guadagno del ricevitore.
 */
export const VOICE_IN_LUFS = -23;
/** Volume della voce all'uscita: quello della catena di prima, su cui sono stati scelti volume della voce e ducking. */
export const VOICE_OUT_LUFS = -17.5;
/** Quanto la catena abbassa una voce che entra a VOICE_IN_LUFS (media di tre registrazioni OBS del 21/11 sera). */
const CHAIN_LOSS_DB = 5;

/**
 * Gate anti-clic (21/11): fra le parole tutto scende di 20 dB. Lo comanda solo la banda della voce (120–900 Hz),
 * dove clic del controller e tastiera non hanno quasi energia, quindi loro non lo aprono. Senza, la compressione
 * li portava da 23 a 10 dB sotto la voce. La voce arriva 40 ms dopo la chiave: il gate è già aperto quando
 * comincia una parola soffiata ("this"), e i 40 ms si tolgono subito dopo, così la sincronia non cambia.
 */
const GATE_LOOKAHEAD_S = 0.04;
const GATE = `sidechaingate=threshold=${(10 ** (-42 / 20)).toFixed(5)}:ratio=4:range=0.1:attack=2:release=300:knee=3:detection=rms`;
/**
 * Riduzione del rumore leggera: con −72 dB di fondo ne basta poca, di più la voce diventa "acquosa".
 * afftdn ritarda l'audio di 25 ms (misurato a 48 kHz): si allunga la coda e si toglie la testa, così resta a tempo.
 */
const DENOISE = 'apad=pad_dur=0.025,afftdn=nr=6:nf=-75:tn=1,atrim=start=0.025,asetpts=PTS-STARTPTS';
/** De-esser e due compressori morbidi: il primo prende i picchi, il secondo tiene la voce costante. */
const DYNAMICS = 'deesser=i=0.3:m=0.5:f=0.5,acompressor=threshold=-24dB:ratio=3:attack=5:release=60:knee=4,acompressor=threshold=-20dB:ratio=2:attack=25:release=250:knee=6';

/** Compressione più decisa: urla e risate escono molto meno sopra il parlato, con un limitatore in fondo. */
const DYNAMICS_STRONG =
  'deesser=i=0.4:m=0.5:f=0.5,acompressor=threshold=-28dB:ratio=4:attack=3:release=80:knee=4,acompressor=threshold=-22dB:ratio=3:attack=15:release=200:knee=6,alimiter=limit=0.25:attack=2:release=60:level=false';
/** La più compatta, stile podcast: la voce resta quasi sempre allo stesso volume. */
const DYNAMICS_HEAVY =
  'deesser=i=0.4:m=0.5:f=0.5,acompressor=threshold=-32dB:ratio=6:attack=2:release=60:knee=4,acompressor=threshold=-24dB:ratio=3:attack=10:release=150:knee=6,alimiter=limit=0.2:attack=2:release=50:level=false';

/** Meno bassi: passa-alto più in alto e il "petto" più giù. */
const LESS_BASS: VoiceBand[] = [
  { type: 'highpass', f: 110 },
  { type: 'highpass', f: 110 },
  { type: 'lowshelf', f: 250, g: -4 },
  { type: 'peaking', f: 300, q: 1, g: -3 },
  { type: 'peaking', f: 3200, q: 0.9, g: 4 },
  { type: 'highshelf', f: 9000, g: 5 },
];

export type VoicePreset = 'chiara' | 'meno-bassi' | 'anti-picchi' | 'morbida' | 'radio' | 'obs' | 'nessuna';

export interface VoiceProfile {
  label: string;
  hint: string;
  bands: VoiceBand[];
  /** compressione della voce (ffmpeg) */
  dynamics: string;
  /** quanto la catena abbassa una voce che entra a VOICE_IN_LUFS: si compensa, così ogni tipo esce a VOICE_OUT_LUFS */
  loss: number;
  /** la stessa compressione, approssimata, per l'anteprima nel browser (DynamicsCompressorNode; tempi in secondi) */
  preview: { threshold: number; ratio: number; attack: number; release: number; knee: number };
  /** filtri sul mix intero (gioco + voce), per i picchi che vengono dal gioco: nell'anteprima si sentono solo nel mix finale */
  bus?: string;
  /**
   * Prima della catena la voce passa dai filtri di OBS del 22/11 (src/lib/obs-voice.ts), che fanno loro
   * riduzione del rumore ed equalizzazione: qui restano il passa-alto e la compressione.
   */
  obsChain?: boolean;
  /** equalizzazione per l'anteprima nel browser, se diversa da `bands` (per "obs": quella di OBS, approssimata) */
  previewBands?: VoiceBand[];
  /**
   * Nessuna pulizia: la voce è già sistemata dai filtri di OBS (dal 24/11). Niente gate, riduzione del rumore,
   * equalizzazione o compressione: si porta solo a VOICE_OUT_LUFS, così volume della voce e ducking tengono
   * l'equilibrio di sempre col gioco.
   */
  raw?: boolean;
}

/**
 * I cinque tipi di voce (22/11): si provano al volo nel player (tasti 1–5) e valgono per video finale e short.
 * "chiara" è quella di sempre. I picchi del 22/11 erano urla e risate sopra il gioco, e qualche botta del gioco.
 */
export const VOICE_PRESETS: Record<VoicePreset, VoiceProfile> = {
  chiara: {
    label: 'Chiara',
    hint: 'Quella di sempre: meno rimbombo, consonanti più chiare, compressione morbida.',
    bands: CLEAR_VOICE,
    dynamics: DYNAMICS,
    loss: CHAIN_LOSS_DB,
    preview: { threshold: -24, ratio: 3, attack: 0.005, release: 0.06, knee: 4 },
  },
  'meno-bassi': {
    label: 'Meno bassi',
    hint: 'Come Chiara, ma con molti meno bassi sulla voce (rimbombo, petto, colpi sul microfono).',
    bands: LESS_BASS,
    dynamics: DYNAMICS,
    loss: CHAIN_LOSS_DB,
    preview: { threshold: -24, ratio: 3, attack: 0.005, release: 0.06, knee: 4 },
  },
  'anti-picchi': {
    label: 'Anti-picchi',
    hint: 'Urla e risate molto più contenute, e un compressore leggero anche sul gioco.',
    bands: CLEAR_VOICE,
    dynamics: DYNAMICS_STRONG,
    loss: 8.5, // misurata il 22/11 su 6 minuti con risate e urla
    preview: { threshold: -28, ratio: 6, attack: 0.003, release: 0.1, knee: 4 },
    bus: 'acompressor=threshold=-16dB:ratio=3:attack=10:release=250:knee=6',
  },
  morbida: {
    label: 'Morbida',
    hint: 'Meno bassi e meno picchi, anche nel gioco: per volume troppo alto e bassi troppo forti.',
    bands: LESS_BASS.map((b) => (b.type === 'peaking' && b.f === 3200 ? { ...b, g: 2 } : b.type === 'highshelf' ? { ...b, g: 3 } : b)),
    dynamics: DYNAMICS_STRONG,
    loss: 9.1, // misurata il 22/11 su 6 minuti con risate e urla
    preview: { threshold: -28, ratio: 6, attack: 0.003, release: 0.1, knee: 4 },
    bus: 'bass=g=-3:f=110:w=0.7,acompressor=threshold=-16dB:ratio=2.5:attack=15:release=300:knee=8',
  },
  radio: {
    label: 'Radio',
    hint: 'Voce compatta e sempre allo stesso volume, stile podcast: la più controllata.',
    bands: [
      { type: 'highpass', f: 130 },
      { type: 'highpass', f: 130 },
      { type: 'lowshelf', f: 250, g: -5 },
      { type: 'peaking', f: 300, q: 1, g: -4 },
      { type: 'peaking', f: 2500, q: 0.8, g: 5 },
      { type: 'highshelf', f: 8000, g: 4 },
    ],
    dynamics: DYNAMICS_HEAVY,
    loss: 12.2, // misurata il 22/11 su 6 minuti con risate e urla
    preview: { threshold: -32, ratio: 10, attack: 0.002, release: 0.08, knee: 4 },
    bus: 'acompressor=threshold=-18dB:ratio=4:attack=5:release=200:knee=6',
  },
  obs: {
    label: 'OBS + Morbida',
    hint: 'Il timbro dei filtri OBS del 22/11 (bassi tagliati, alti aperti) con la compressione di Morbida: scelta per l’episodio 3.',
    bands: [{ type: 'highpass', f: 80 }],
    dynamics: DYNAMICS_STRONG,
    loss: 9.1, // come Morbida: è la versione ascoltata e scelta il 23/11
    preview: { threshold: -28, ratio: 6, attack: 0.003, release: 0.1, knee: 4 },
    bus: 'bass=g=-3:f=110:w=0.7,acompressor=threshold=-16dB:ratio=2.5:attack=15:release=300:knee=8',
    obsChain: true,
    previewBands: [
      { type: 'highpass', f: 80 },
      { type: 'lowshelf', f: 800, g: -7.3 },
      { type: 'peaking', f: 2000, q: 0.5, g: -2.8 },
      { type: 'highshelf', f: 5000, g: 10.5 },
    ],
  },
  nessuna: {
    label: 'Già pulita in OBS',
    hint: 'Nessuna pulizia: la voce resta com’è uscita dai filtri di OBS, solo portata al volume giusto per il mix. Per le registrazioni dal 23/11.',
    bands: [],
    dynamics: '',
    loss: 0,
    preview: { threshold: 0, ratio: 1, attack: 0.003, release: 0.25, knee: 0 },
    raw: true,
  },
};

export const voiceProfile = (preset: VoicePreset | undefined): VoiceProfile => VOICE_PRESETS[preset ?? 'chiara'] ?? VOICE_PRESETS.chiara;

let graphs = 0;

/**
 * Catena completa della voce, come pezzo di filter_complex da `input` (per esempio "[0:a:1]") all'etichetta
 * `output`: livello di partenza, gate anti-clic, riduzione del rumore, equalizzazione del tipo scelto (con `clear`,
 * altrimenti solo il passa-alto a 80 Hz) e compressione del tipo scelto; esce a VOICE_OUT_LUFS. Il tipo "nessuna"
 * (voce già pulita in OBS) salta tutto e regola solo il volume.
 * `inputLufs` è il volume della voce grezza misurato su un segnale con `channels` canali (il mono misura 3 dB meno).
 */
export function voiceGraph(input: string, output: string, inputLufs: number, clear: boolean, channels: 1 | 2 = 2, preset?: VoicePreset): string {
  const p = voiceProfile(preset);
  const stereoLufs = channels === 1 ? inputLufs + 3 : inputLufs;
  // senza parlato misurabile non si tocca il livello
  const inGain = Number.isFinite(stereoLufs) ? Math.max(-20, Math.min(30, VOICE_IN_LUFS - stereoLufs)) : 0;
  const outGain = VOICE_OUT_LUFS - (VOICE_IN_LUFS - p.loss);
  // etichette interne uniche, nel caso un grafo contenga più catene
  // già pulita in OBS: solo il volume, dal livello misurato a quello d'uscita
  if (p.raw) return `${input}volume=${(Number.isFinite(stereoLufs) ? Math.max(-20, Math.min(30, VOICE_OUT_LUFS - stereoLufs)) : 0).toFixed(2)}dB[${output}]`;
  const n = graphs++;
  const [v, k, vd, key] = ['v', 'k', 'vd', 'key'].map((l) => `[voce${n}${l}]`);
  return [
    `${input}volume=${inGain.toFixed(2)}dB,asplit=2${v}${k}`,
    `${v}adelay=${GATE_LOOKAHEAD_S * 1000}:all=1${vd}`,
    // la chiave dura 40 ms in più: il gate si ferma quando finisce lei, e la voce ritardata non perde la coda
    `${k}highpass=f=120,lowpass=f=900,apad=pad_dur=${GATE_LOOKAHEAD_S}${key}`,
    `${vd}${key}${GATE},atrim=start=${GATE_LOOKAHEAD_S},asetpts=PTS-STARTPTS,${DENOISE},${clear ? clearVoiceFilter(p.bands) : 'highpass=f=80:poles=2'},${p.dynamics},volume=${outGain.toFixed(2)}dB[${output}]`,
  ].join(';');
}
