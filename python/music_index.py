"""Proposte di musica libera simile a una canzone protetta: impronte CLAP (laion/clap-htsat-unfused) e BPM.

Uso:
  music_index.py index <libreria> <indice.json>        impronta e BPM di ogni brano della libreria (con cache)
  music_index.py catalog <catalogo.json>               catalogo di Kevin MacLeod (incompetech.com, CC BY 4.0)
  music_index.py propose <richiesta.json> <uscita.json>
     richiesta: {"audio": "tratto.wav" (gioco originale del tratto, facoltativo), "text": "descrizione",
                 "library_index": "...", "catalog": "...", "exclude": [file...], "n": 6}

Con "audio", BandIt separa la musica del tratto: se c'è (almeno il 25% del tempo) l'impronta e i BPM vengono da
lei; altrimenti (canzone disattivata nel gioco) dal testo. La libreria si confronta audio con audio (più BPM
vicini); il catalogo, che non si scarica, testo con audio o testo con testo, dalle sue descrizioni.
"""

import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import torch

ROOT = Path(__file__).resolve().parent.parent
CLAP = ROOT / "models" / "clap-htsat-unfused"
CATALOG_URL = "https://incompetech.com/music/royalty-free/pieces.json"
MP3_URL = "https://incompetech.com/music/royalty-free/mp3-royaltyfree/{}"
AUDIO = {".mp3", ".m4a", ".wav", ".flac", ".ogg", ".opus", ".webm", ".aac"}
SR = 48000
CROP = 10.0  # CLAP ascolta 10 s alla volta


class Clap:
    def __init__(self):
        from transformers import ClapModel, ClapProcessor

        self.model = ClapModel.from_pretrained(CLAP).eval()
        self.proc = ClapProcessor.from_pretrained(CLAP)

    @staticmethod
    def _vec(out) -> np.ndarray:
        out = getattr(out, "pooler_output", out)
        return torch.nn.functional.normalize(out, dim=-1).numpy()

    def audio(self, y: np.ndarray) -> np.ndarray:
        """Impronta media di tre pezzi da 10 s (inizio, metà, fine) di un audio mono a 48 kHz."""
        n = int(CROP * SR)
        starts = [0, max(0, len(y) // 2 - n // 2), max(0, len(y) - n)] if len(y) > n else [0]
        crops = [y[s : s + n] for s in starts]
        with torch.inference_mode():
            v = self._vec(self.model.get_audio_features(**self.proc(audio=crops, sampling_rate=SR, return_tensors="pt")))
        m = v.mean(axis=0)
        return m / np.linalg.norm(m)

    def text(self, texts: list[str]) -> np.ndarray:
        with torch.inference_mode():
            return self._vec(self.model.get_text_features(**self.proc(text=texts, return_tensors="pt", padding=True, truncation=True)))


def bpm(y: np.ndarray) -> float:
    tempo, _ = librosa.beat.beat_track(y=y.astype(np.float32), sr=SR)
    return round(float(np.atleast_1d(tempo)[0]), 1)


def duration(path: str) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True).stdout
    return float(out.strip() or 0)


def load(path: str, seconds: float = 90) -> np.ndarray:
    """Fino a `seconds` dalla metà del brano, mono a 48 kHz (lo decodifica ffmpeg: qualunque formato, anche .webm)."""
    off = max(0.0, duration(path) / 2 - seconds / 2)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(off), "-t", str(seconds), "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def index(lib: str, out: str) -> None:
    cache = json.loads(Path(out).read_text()) if Path(out).exists() else {}
    clap = None
    files = sorted(p for p in Path(lib).iterdir() if p.suffix.lower() in AUDIO and not p.name.startswith("."))
    fresh = {}
    for p in files:
        key = str(p)
        mtime = p.stat().st_mtime
        if key in cache and cache[key]["mtime"] == mtime:
            fresh[key] = cache[key]
            continue
        clap = clap or Clap()
        y = load(key)
        fresh[key] = {"mtime": mtime, "bpm": bpm(y), "duration": round(duration(key), 1), "emb": [round(float(v), 5) for v in clap.audio(y)]}
        print(json.dumps({"indicizzato": p.name, "bpm": fresh[key]["bpm"]}), flush=True)
    Path(out).write_text(json.dumps(fresh))


def catalog(out: str) -> None:
    req = urllib.request.Request(CATALOG_URL, headers={"User-Agent": "Mozilla/5.0"})
    pieces = json.loads(urllib.request.urlopen(req, timeout=60).read())
    clap = Clap()
    texts = [f"{p.get('title')}. {p.get('feel') or ''}. {p.get('instruments') or ''}. {p.get('description') or ''}"[:300] for p in pieces]
    embs = np.concatenate([clap.text(texts[i : i + 64]) for i in range(0, len(texts), 64)])
    rows = []
    for p, e in zip(pieces, embs):
        try:
            b = float(p.get("bpm") or 0)
        except ValueError:
            b = 0.0
        rows.append({
            "title": p.get("title"), "artist": "Kevin MacLeod", "filename": p.get("filename"), "url": MP3_URL.format(urllib.parse.quote(p.get("filename") or "")),
            "bpm": b, "length": p.get("length"), "feel": p.get("feel"), "instruments": p.get("instruments"), "description": (p.get("description") or "")[:200],
            "emb": [round(float(v), 5) for v in e],
        })
    Path(out).write_text(json.dumps({"fetched": time.strftime("%Y-%m-%d"), "pieces": rows}))
    print(json.dumps({"catalogo": len(rows)}))


def propose(req_path: str, out: str) -> None:
    req = json.loads(Path(req_path).read_text())
    clap = Clap()
    ref, ref_bpm, source = None, None, None
    if req.get("audio"):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from replace_music import Separator, envelope_db  # noqa: E402

        x, sr = sf.read(req["audio"], dtype="float64", always_2d=True)
        _, music, _ = Separator("auto")(x, sr)
        env = envelope_db(music, sr)
        if float(np.mean(env >= req.get("silence_db", -65))) >= 0.25:
            y = librosa.resample(music.mean(axis=1), orig_sr=sr, target_sr=SR) if sr != SR else music.mean(axis=1)
            # la musica separata è bassa: la si porta a un livello normale prima dell'impronta
            y = y / (np.max(np.abs(y)) + 1e-9) * 0.5
            ref, ref_bpm, source = clap.audio(y), bpm(y), "musica del tratto"
    if ref is None and req.get("text"):
        ref, source = clap.text([req["text"]])[0], f"descrizione: {req['text']}"
    if ref is None:
        Path(out).write_text(json.dumps({"source": None, "library": [], "catalog": [], "note": "né musica nel tratto né una descrizione: scrivi lo stile che cerchi"}))
        return
    n = int(req.get("n", 6))
    exclude = set(req.get("exclude", []))

    def bpm_score(b):
        if not ref_bpm or not b:
            return 0.0
        r = min(b, ref_bpm) / max(b, ref_bpm)
        r = max(r, min(2 * b, ref_bpm) / max(2 * b, ref_bpm), min(b, 2 * ref_bpm) / max(b, 2 * ref_bpm))  # metà o doppio tempo
        return 0.15 * r

    lib = json.loads(Path(req["library_index"]).read_text()) if Path(req.get("library_index", "")).exists() else {}
    library = sorted(
        ({"file": f, "bpm": v["bpm"], "score": round(float(np.dot(ref, v["emb"])) + bpm_score(v["bpm"]), 3)} for f, v in lib.items() if f not in exclude),
        key=lambda r: -r["score"],
    )[:n]
    cat = json.loads(Path(req["catalog"]).read_text())["pieces"] if Path(req.get("catalog", "")).exists() else []
    catalog_rows = sorted(
        ({k: p[k] for k in ("title", "artist", "url", "bpm", "length", "feel", "instruments", "description")} | {"score": round(float(np.dot(ref, p["emb"])) + bpm_score(p["bpm"]), 3)} for p in cat),
        key=lambda r: -r["score"],
    )[:n]
    Path(out).write_text(json.dumps({"source": source, "bpm": ref_bpm, "library": library, "catalog": catalog_rows}, ensure_ascii=False))


if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    {"index": index, "catalog": catalog, "propose": propose}[cmd](*args)
