"""Sostituisce le canzoni protette nella traccia del gioco, tenendo dialoghi ed effetti originali.

Uso, un tratto:  replace_music.py <gioco.flac> <uscita.flac> --music <musica.wav> --start <s> --end <s> [opzioni]
Uso, più tratti: replace_music.py <gioco.flac> <uscita.flac> --segments tratti.json [opzioni]
  tratti.json: [{"id": "...", "start": s, "end": s, "music": "musica.wav", "mode": "auto", "add_level_db": 0}, ...]
Opzioni: --fade 1.5 --max-gain-db 12 --silence-db -65 --margin 6 --device auto --no-separate
         --previews cartella (un WAV per tratto, da ascoltare) --stems-out cartella (le parti, un tratto solo)
         --report report.json

Per ogni tratto [start, end]:
- BandIt Plus (separate_cinematic.py) divide il gioco in dialoghi, musica ed effetti, su una finestra un po' più
  larga (--margin) perché i bordi del tratto non risentano dei bordi della separazione;
- modo "sostituisci" (la canzone si sente): la musica nuova segue l'inviluppo del volume della sola musica
  originale (finestre da 50 ms, smussato su 0,5 s): dove l'originale scende sotto i dialoghi o sfuma, scende anche
  lei; dove tace (sotto --silence-db), tace; l'amplificazione è limitata a --max-gain-db. Il tratto diventa
  dialoghi + effetti + musica nuova, con una dissolvenza incrociata di --fade secondi ai bordi;
- modo "aggiungi" (la canzone era disattivata nel gioco: nel tratto c'è musica per meno del 25% del tempo): niente
  da togliere, il gioco resta intatto e la musica nuova si somma sopra al livello mediano del gioco nel minuto
  prima e nel minuto dopo il tratto (dentro, con la radio spenta, il gioco è più basso del solito e non dice quanto
  forte dovrebbe essere la musica) più add_level_db, con dissolvenze di --fade secondi; "auto" sceglie fra i due;
- i picchi restano sotto −1 dBFS.
Fuori dai tratti i campioni sono copiati identici (FLAC a 24 bit, letti e scritti come interi), senza passare dalla
separazione. Le musiche devono essere già a 48 kHz stereo float (le prepara ffmpeg). Si legge a blocchi: regge
registrazioni di ore. --no-separate: niente separazione, la musica nuova prende il posto di tutto il gioco.
"""

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

BLOCK = 1 << 20  # campioni per blocco nella copia
FRAME = 0.05  # finestra dell'inviluppo, s
SMOOTH = 0.5  # smussatura dell'inviluppo, s
PEAK = 10 ** (-1.0 / 20)  # mai sopra −1 dBFS nei tratti ricostruiti
PRESENT_MIN = 0.25  # sotto questa quota di musica nel tratto, "auto" aggiunge invece di sostituire


def envelope_db(x: np.ndarray, sr: int) -> np.ndarray:
    """RMS in dB (dei due canali) su finestre da FRAME, smussato con una media mobile di SMOOTH (in dB)."""
    n = int(sr * FRAME)
    frames = max(1, len(x) // n)
    # potenza media dei due canali, non del loro mono: una musica molto larga (una radio) nel mono si annulla
    power = (x[: frames * n] ** 2).mean(axis=1).reshape(frames, n)
    db = 10 * np.log10(power.mean(axis=1) + 1e-12)
    k = max(1, int(SMOOTH / FRAME))
    return np.convolve(np.pad(db, (k // 2, k - 1 - k // 2), mode="edge"), np.ones(k) / k, mode="valid")


def to_samples(curve: np.ndarray, sr: int, length: int) -> np.ndarray:
    """Da una curva per finestra a una per campione (interpolazione lineare sui centri delle finestre)."""
    n = int(sr * FRAME)
    centres = np.arange(len(curve)) * n + n / 2
    return np.interp(np.arange(length), centres, curve)


# filtro K di ITU-R BS.1770 a 48 kHz (lo stesso di ebur128/loudnorm di ffmpeg): mensola sugli acuti e passa-alto
K_SHELF = ([1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585])
K_HIGHPASS = ([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621])


def loudness(x: np.ndarray, sr: int) -> float | None:
    """Loudness integrata (LUFS, EBU R128: blocchi da 400 ms, soglia assoluta −70 e relativa −10)."""
    if sr != 48000 or len(x) < sr:
        return None
    from scipy.signal import lfilter

    y = lfilter(*K_HIGHPASS, lfilter(*K_SHELF, x, axis=0), axis=0)
    block, step = int(0.4 * sr), int(0.1 * sr)
    z = np.array([np.mean(y[i : i + block] ** 2, axis=0).sum() for i in range(0, len(y) - block + 1, step)])
    lk = -0.691 + 10 * np.log10(z + 1e-15)
    z = z[lk > -70]
    if not len(z):
        return None
    rel = -0.691 + 10 * np.log10(z.mean()) - 10
    z = z[-0.691 + 10 * np.log10(z) > rel]
    return float(-0.691 + 10 * np.log10(z.mean()))


def around_level(src: sf.SoundFile, s0: int, s1: int, seconds: float = 60) -> float | None:
    """Loudness (LUFS) del gioco nel minuto prima e nel minuto dopo il tratto, fuori dal tratto."""
    sr, n = src.samplerate, int(seconds * src.samplerate)
    parts = []
    for a, b in ((max(0, s0 - n), s0), (s1, min(src.frames, s1 + n))):
        if b - a > sr:
            src.seek(a)
            parts.append(src.read(b - a, dtype="float64", always_2d=True))
    return loudness(np.concatenate(parts), sr) if parts else None


def copy(src: sf.SoundFile, dst: sf.SoundFile, frames: int) -> None:
    while frames > 0:
        block = src.read(min(BLOCK, frames), dtype="int32", always_2d=True)
        if not len(block):
            break
        dst.write(block)
        frames -= len(block)


class Separator:
    """BandIt caricato una volta sola, alla prima separazione."""

    def __init__(self, device: str):
        self.device = device
        self.model = None

    def __call__(self, audio: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import separate_cinematic as sc  # noqa: E402
        import torch  # noqa: E402

        if self.model is None:
            if self.device == "auto":
                self.device = "mps" if torch.backends.mps.is_available() else "cpu"
            self.model, self.msr, self.chunk = sc.load_model(self.device)
        g = math.gcd(sr, self.msr)
        x = resample_poly(audio, self.msr // g, sr // g, axis=0).astype(np.float32)
        try:
            stems = sc.separate(self.model, x, self.chunk, self.device)
        except RuntimeError:
            self.device = "cpu"
            self.model = self.model.to("cpu")
            stems = sc.separate(self.model, x, self.chunk, self.device)
        back = [resample_poly(s, sr // g, self.msr // g, axis=0)[: len(audio)] for s in stems]
        speech, music, effects = (np.pad(s, ((0, len(audio) - len(s)), (0, 0))) for s in back)
        return speech, music, effects


def rebuild(seg: dict, src: sf.SoundFile, sep: Separator | None, a: argparse.Namespace) -> tuple[np.ndarray, dict, dict]:
    """Il tratto ricostruito (interi a 32 bit), il suo report e le parti (per ascoltarle)."""
    sr, total, ch = src.samplerate, src.frames, src.channels
    s0, s1 = int(seg["start"] * sr), min(int(seg["end"] * sr), total)
    length = s1 - s0
    fade = min(int(a.fade * sr), length // 2)
    c0, c1 = max(0, s0 - int(a.margin * sr)), min(total, s1 + int(a.margin * sr))

    music, msr = sf.read(seg["music"], dtype="float64", always_2d=True)
    if msr != sr or music.shape[1] != ch:
        raise SystemExit(f"{seg['music']}: la musica deve essere a {sr} Hz e {ch} canali")
    music = np.concatenate([music] * math.ceil(length / len(music)))[:length]  # più corta: si ripete

    src.seek(c0)
    ctx_i = src.read(c1 - c0, dtype="int32", always_2d=True)
    ctx = ctx_i.astype(np.float64) / 2**31
    if sep is None:
        speech = effects = np.zeros_like(ctx)
        old_music = ctx
    else:
        speech, old_music, effects = sep(ctx, sr)
    cut = slice(s0 - c0, s1 - c0)
    orig_i, orig = ctx_i[cut], ctx[cut]
    speech, old_music, effects = speech[cut], old_music[cut], effects[cut]

    e_old, e_new = envelope_db(old_music, sr), envelope_db(music, sr)
    present = float(np.mean(e_old >= a.silence_db))
    mode = seg.get("mode", "auto")
    if mode == "auto":
        mode = "sostituisci" if present >= PRESENT_MIN else "aggiungi"
    w = np.ones(length)
    if fade:
        ramp = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, fade))
        w[:fade], w[length - fade :] = ramp, ramp[::-1]
    if mode == "sostituisci":
        # la musica nuova segue l'andamento della musica originale; dove quella tace, tace anche lei
        gain_db = np.clip(e_old - e_new, -80.0, a.max_gain_db)
        gain_db[e_old < a.silence_db] = -80.0
        new = music * (10 ** (to_samples(gain_db, sr, length) / 20))[:, None]
        rebuilt = speech + effects + new
    else:
        # canzone assente: il gioco resta com'è e la musica si aggiunge, a volume costante, con le dissolvenze,
        # forte quanto il gioco attorno al tratto (loudness, come la misura YouTube): dentro, senza la radio, il
        # gioco è più basso del solito e non dice quanto forte dovrebbe essere la musica
        reference = around_level(src, s0, s1) or loudness(orig, sr)
        music_lufs = loudness(music, sr)
        level = (reference if reference is not None else float(np.median(envelope_db(orig, sr)))) + float(seg.get("add_level_db", 0))
        base = music_lufs if music_lufs is not None and reference is not None else float(np.median(e_new))
        gain_db = np.clip(np.full_like(e_new, level - base), -80.0, a.max_gain_db)
        new = music * (10 ** (to_samples(gain_db, sr, length) / 20) * w)[:, None]
        rebuilt = orig + new
    # niente picchi oltre −1 dBFS: si abbassa solo dove servirebbe (si allarga di 10 ms per non fare scatti)
    over = np.maximum(np.abs(rebuilt).max(axis=1) / PEAK, 1.0)
    limited = bool(over.max() > 1.0)
    if limited:
        k = int(sr * 0.01)
        over = np.maximum.reduce([np.roll(over, s) for s in range(-k, k + 1, max(1, k // 8))])
        rebuilt /= over[:, None]
    # dissolvenza incrociata ai bordi: somma lineare, perché dialoghi ed effetti sono gli stessi nei due lati
    # (con "aggiungi" la musica ha già le sue dissolvenze e il gioco è l'originale: niente da incrociare)
    mixed = orig * (1 - w)[:, None] + rebuilt * w[:, None] if mode == "sostituisci" else rebuilt
    out = np.clip(np.round(mixed * 2**31), -(2**31), 2**31 - 1).astype(np.int32)
    out[w == 0] = orig_i[w == 0]  # dove la dissolvenza vale 0 restano i campioni originali

    db = lambda x: round(10 * math.log10(float(np.mean(x**2)) + 1e-12), 1)  # noqa: E731
    report = {
        "id": seg.get("id"),
        "start": s0 / sr,
        "end": s1 / sr,
        "mode": mode,
        "music_present_pct": round(100 * present, 1),
        "reference_db": round(level - float(seg.get("add_level_db", 0)), 1) if mode == "aggiungi" else None,
        "levels_db": {"original": db(orig), "speech": db(speech), "original_music": db(old_music), "effects": db(effects), "new_music": db(new), "rebuilt": db(mixed)},
        "gain_db": {"min": round(float(gain_db.min()), 1), "max": round(float(gain_db.max()), 1), "median": round(float(np.median(gain_db)), 1)},
        "peak_limited": limited,
    }
    parts = {"dialoghi": speech, "musica-originale": old_music, "effetti": effects, "musica-nuova": new, "ricostruito": mixed}
    return out, report, parts


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("game")
    p.add_argument("out")
    p.add_argument("--segments")
    p.add_argument("--music")
    p.add_argument("--start", type=float)
    p.add_argument("--end", type=float)
    p.add_argument("--mode", choices=("auto", "sostituisci", "aggiungi"), default="auto")
    p.add_argument("--add-level-db", type=float, default=0.0)
    p.add_argument("--fade", type=float, default=1.5)
    p.add_argument("--max-gain-db", type=float, default=12.0)
    p.add_argument("--silence-db", type=float, default=-65.0)
    p.add_argument("--margin", type=float, default=6.0)
    p.add_argument("--device", default="auto")
    p.add_argument("--no-separate", action="store_true")
    p.add_argument("--previews")
    p.add_argument("--stems-out")
    p.add_argument("--report")
    a = p.parse_args()

    if a.segments:
        segments = json.loads(Path(a.segments).read_text())
    elif a.music and a.start is not None and a.end is not None:
        segments = [{"id": "tratto", "start": a.start, "end": a.end, "music": a.music, "mode": a.mode, "add_level_db": a.add_level_db}]
    else:
        raise SystemExit("servono --segments, oppure --music --start --end")
    segments = sorted(segments, key=lambda s: s["start"])
    for x, y in zip(segments, segments[1:]):
        if y["start"] < x["end"]:
            raise SystemExit(f"tratti sovrapposti: {x['start']}–{x['end']} e {y['start']}–{y['end']}")

    src = sf.SoundFile(a.game)
    sr, ch, total = src.samplerate, src.channels, src.frames
    sep = None if a.no_separate else Separator(a.device)
    dst = sf.SoundFile(a.out, "w", samplerate=sr, channels=ch, format="FLAC", subtype="PCM_24")
    reports, at = [], 0
    for seg in segments:
        s0, s1 = int(seg["start"] * sr), min(int(seg["end"] * sr), total)
        if not at <= s0 < s1:
            raise SystemExit(f"tratto fuori dalla traccia: {seg['start']}–{seg['end']}")
        out, report, parts = rebuild(seg, src, sep, a)
        src.seek(at)
        copy(src, dst, s0 - at)
        dst.write(out)
        at = s1
        reports.append(report)
        print(json.dumps(report), flush=True)
        if a.previews:
            Path(a.previews).mkdir(parents=True, exist_ok=True)
            sf.write(Path(a.previews) / f"{seg.get('id', 'tratto')}.wav", np.clip(parts["ricostruito"], -1, 1), sr, subtype="PCM_24")
        if a.stems_out and len(segments) == 1:
            d = Path(a.stems_out)
            d.mkdir(parents=True, exist_ok=True)
            for name, x in parts.items():
                sf.write(d / f"{name}.flac", np.clip(x, -1, 1), sr, subtype="PCM_24")
    src.seek(at)
    copy(src, dst, total - at)
    dst.close()
    src.close()
    result = {"separation": None if sep is None else {"model": "BandIt Plus DnR", "device": sep.device}, "segments": reports}
    if a.report:
        Path(a.report).write_text(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
