"""Trova le canzoni protette nella traccia del gioco con Shazam (shazamio, gratuito e non ufficiale).

Uso: detect_songs.py <gioco> <uscita.json> [--keep tratti.json] [--window 12] [--coarse-hop 24] [--hop 6]
       [--pause 3] [--silence-db -50] [--min-hits 2] [--no-refine] [--fake risposte.json]

- Prima passata: una finestra di --window secondi ogni --coarse-hop, solo nei tratti di --keep (quelli che restano
  nel video: [[inizio, fine], ...]; senza, tutto), saltando le finestre più silenziose di --silence-db.
- Seconda passata, solo attorno alle canzoni trovate: finestre ogni --hop secondi, per avere i bordi.
- Le finestre consecutive della stessa canzone diventano un tratto; si tiene se l'hanno riconosciuta almeno
  --min-hits finestre (meno falsi positivi).
- Bordi rifiniti sull'energia della musica separata da BandIt (separate_cinematic.py), se il modello c'è.
- Fra una richiesta e l'altra --pause secondi. Se Shazam non risponde o blocca per 3 volte di fila ci si ferma:
  il risultato dice "bloccato" con quello che si era trovato fino lì, e la pipeline va avanti.
--fake: risposte finte {"<inizio finestra>": {"key", "title", "artist"}} al posto di Shazam (per i test).
"""

import argparse
import asyncio
import io
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

MAX_ERRORS = 3


def rms_db(x: np.ndarray) -> float:
    return 10 * math.log10(float(np.mean(x**2)) + 1e-12)


class Recognizer:
    """Shazam, o le risposte finte dei test."""

    def __init__(self, fake: str | None, pause: float):
        self.fake = json.loads(Path(fake).read_text()) if fake else None
        self.pause = pause
        self.last = 0.0
        self.requests = 0
        self.shazam = None

    async def __call__(self, audio: np.ndarray, sr: int, at: float) -> dict | None:
        self.requests += 1
        if self.fake is not None:
            r = self.fake.get(str(int(at)))
            if r == "errore":
                raise RuntimeError("risposta finta: errore")
            return r
        if self.shazam is None:
            from shazamio import Shazam  # noqa: E402

            self.shazam = Shazam()
        wait = self.pause - (time.time() - self.last)
        if wait > 0:
            await asyncio.sleep(wait)
        self.last = time.time()
        buf = io.BytesIO()
        sf.write(buf, audio.mean(axis=1), sr, format="WAV", subtype="PCM_16")
        out = await self.shazam.recognize(buf.getvalue())
        track = (out or {}).get("track")
        if not track:
            return None
        return {"key": str(track.get("key")), "title": track.get("title", ""), "artist": track.get("subtitle", ""), "url": track.get("url")}


async def scan(src: sf.SoundFile, starts: list[float], a: argparse.Namespace, rec: Recognizer, state: dict) -> list[tuple[float, dict]]:
    """Le finestre che partono da `starts`, riconosciute: [(inizio, canzone)]."""
    sr = src.samplerate
    hits = []
    for at in starts:
        if state["blocked"]:
            break
        src.seek(int(at * sr))
        x = src.read(int(a.window * sr), dtype="float32", always_2d=True)
        if len(x) < sr * 3 or rms_db(x) < a.silence_db:
            continue
        try:
            r = await rec(x, sr, at)
            state["errors_in_row"] = 0
        except Exception as e:  # rete, limiti, risposte strane: si segnala e si va avanti
            state["errors"].append({"at": round(at, 1), "error": str(e)[:200]})
            state["errors_in_row"] += 1
            if state["errors_in_row"] >= MAX_ERRORS:
                state["blocked"] = True
            continue
        if r:
            hits.append((at, r))
    return hits


def windows(keep: list[list[float]], step: float, length: float) -> list[float]:
    out = []
    for s, e in keep:
        t = s
        while t + 3 <= e:
            out.append(round(t, 2))
            t += step
    return out


def merge(hits: list[tuple[float, dict]], a: argparse.Namespace) -> list[dict]:
    """Finestre consecutive della stessa canzone → tratti."""
    segs: list[dict] = []
    for at, r in sorted(hits, key=lambda h: h[0]):
        last = segs[-1] if segs else None
        if last and last["key"] == r["key"] and at - last["last"] <= max(a.hop, a.coarse_hop) + 0.01:
            last["last"] = at
            last["hits"] += 1
        else:
            segs.append({"key": r["key"], "title": r["title"], "artist": r["artist"], "url": r.get("url"), "first": at, "last": at, "hits": 1})
    out = []
    for s in segs:
        if s["hits"] < a.min_hits:
            continue
        out.append({"start": s["first"], "end": s["last"] + a.window, "title": s["title"], "artist": s["artist"], "url": s["url"], "key": s["key"], "hits": s["hits"]})
    return out


def refine(src: sf.SoundFile, seg: dict, a: argparse.Namespace, total: float) -> dict:
    """Bordi sull'energia della musica separata: dove la musica sale sopra la sua mediana −20 dB."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from replace_music import Separator, envelope_db, FRAME  # noqa: E402

    sr = src.samplerate
    sep = refine.sep = getattr(refine, "sep", None) or Separator("auto")
    span = a.hop + 2
    for edge in ("start", "end"):
        t0 = max(0.0, seg[edge] - span)
        t1 = min(total, seg[edge] + span)
        src.seek(int(t0 * sr))
        x = src.read(int((t1 - t0) * sr), dtype="float64", always_2d=True)
        _, music, _ = sep(x, sr)
        env = envelope_db(music, sr)
        on = env > (np.median(env) - 20 if edge == "start" else np.max(env) - 30)
        if not on.any():
            continue
        idx = np.argmax(on) if edge == "start" else len(on) - 1 - np.argmax(on[::-1])
        seg[edge] = round(t0 + idx * FRAME + (0 if edge == "start" else FRAME), 2)
    seg["refined"] = True
    return seg


async def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("game")
    p.add_argument("out")
    p.add_argument("--keep")
    p.add_argument("--window", type=float, default=12)
    p.add_argument("--coarse-hop", type=float, default=24)
    p.add_argument("--hop", type=float, default=6)
    p.add_argument("--pause", type=float, default=3)
    p.add_argument("--silence-db", type=float, default=-50)
    p.add_argument("--min-hits", type=int, default=2)
    p.add_argument("--no-refine", action="store_true")
    p.add_argument("--fake")
    a = p.parse_args()

    src = sf.SoundFile(a.game)
    total = src.frames / src.samplerate
    keep = json.loads(Path(a.keep).read_text()) if a.keep else [[0.0, total]]
    rec = Recognizer(a.fake, a.pause)
    state = {"errors": [], "errors_in_row": 0, "blocked": False}

    coarse = await scan(src, windows(keep, a.coarse_hop, a.window), a, rec, state)
    print(json.dumps({"passata": 1, "richieste": rec.requests, "trovate": len(coarse)}), flush=True)
    # seconda passata attorno a ogni canzone: da una finestra grossa prima a una dopo, ogni --hop secondi
    fine: list[tuple[float, dict]] = list(coarse)
    done = {round(t, 2) for t, _ in coarse}
    for key in dict.fromkeys(r["key"] for _, r in coarse):
        ts = [t for t, r in coarse if r["key"] == key]
        lo, hi = min(ts) - a.coarse_hop, max(ts) + a.coarse_hop
        region = [[max(s, lo), min(e, hi)] for s, e in keep if e > lo and s < hi]
        starts = [t for t in windows(region, a.hop, a.window) if t not in done]
        fine += await scan(src, starts, a, rec, state)
        done.update(starts)
    print(json.dumps({"passata": 2, "richieste": rec.requests}), flush=True)

    segs = merge(fine, a)
    if not a.no_refine and segs:
        try:
            segs = [refine(src, s, a, total) for s in segs]
        except Exception as e:  # senza modello o con un errore della separazione i bordi restano quelli delle finestre
            state["errors"].append({"at": None, "error": f"rifinitura dei bordi: {str(e)[:200]}"})
    result = {
        "status": "bloccato" if state["blocked"] else ("con errori" if state["errors"] else "ok"),
        "requests": rec.requests,
        "segments": segs,
        "errors": state["errors"],
    }
    Path(a.out).write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(json.dumps({"status": result["status"], "tratti": len(segs), "richieste": rec.requests}), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
