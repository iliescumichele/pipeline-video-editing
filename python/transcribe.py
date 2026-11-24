"""Trascrive un WAV mono a 16 kHz con parakeet-mlx, con l'orario di ogni parola.

Uso: transcribe.py <voice16k.wav> <cartella modello> <words.json> [--max-seg 30]

L'audio lungo si taglia in segmenti di al massimo --max-seg secondi, nel punto più silenzioso
della seconda metà di ciascun segmento (come il segmentatore di Parakeet Ultra), così nessuna
parola resta a cavallo di due pezzi e non serve fondere sovrapposizioni.
"""

import argparse
import json
import sys
import time

import mlx.core as mx
import numpy as np
import soundfile as sf
from parakeet_mlx import from_pretrained
from parakeet_mlx.audio import get_logmel

SR = 16000


def cut_points(audio: np.ndarray, max_seg: float) -> list[tuple[int, int]]:
    """Segmenti [inizio, fine) in campioni, tagliati dove l'energia (finestra 300 ms) è minima."""
    hop = SR // 100  # 10 ms
    n = len(audio) // hop
    energy = np.sqrt(np.mean(audio[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12)
    smooth = np.convolve(energy, np.ones(30) / 30, mode="same")
    segs, start = [], 0
    max_len = int(max_seg * 100)
    while n - start > max_len:
        lo, hi = start + max_len // 2, start + max_len
        cut = lo + int(np.argmin(smooth[lo:hi]))
        segs.append((start * hop, cut * hop))
        start = cut
    segs.append((start * hop, len(audio)))
    return segs


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("wav")
    p.add_argument("model_dir")
    p.add_argument("out")
    p.add_argument("--max-seg", type=float, default=30.0)
    a = p.parse_args()

    audio, sr = sf.read(a.wav, dtype="float32", always_2d=False)
    if sr != SR or audio.ndim != 1:
        sys.exit(f"serve un WAV mono a {SR} Hz, questo è {sr} Hz con forma {audio.shape}")

    t0 = time.perf_counter()
    model = from_pretrained(a.model_dir)
    cfg = model.preprocessor_config
    load_s = time.perf_counter() - t0

    t0 = time.perf_counter()
    words, segments = [], []
    for s0, s1 in cut_points(audio, a.max_seg):
        offset = s0 / SR
        segments.append({"s": round(offset, 3), "e": round(s1 / SR, 3)})
        result = model.generate(get_logmel(mx.array(audio[s0:s1]), cfg))[0]
        current = None
        for sentence in result.sentences:
            for t in sentence.tokens:
                # I token di SentencePiece che iniziano con uno spazio aprono una parola nuova;
                # gli altri (sillabe, punteggiatura) si attaccano alla parola corrente.
                if current is None or t.text.startswith(" "):
                    current = {"w": t.text.strip(), "s": offset + t.start, "e": offset + t.end, "c": t.confidence}
                    words.append(current)
                else:
                    current["w"] += t.text
                    current["e"] = offset + t.end
                    current["c"] = min(current["c"], t.confidence)
    words = [w for w in words if w["w"]]
    for w in words:
        w["s"], w["e"], w["c"] = round(w["s"], 3), round(w["e"], 3), round(float(w["c"]), 3)
    asr_s = time.perf_counter() - t0

    dur = len(audio) / SR
    with open(a.out, "w") as f:
        json.dump({"duration": dur, "segments": segments, "words": words}, f, ensure_ascii=False)
    print(
        f"parakeet: {dur:.0f} s di audio in {asr_s:.1f} s ({dur / max(asr_s, 1e-6):.0f}x), "
        f"{len(segments)} segmenti, {len(words)} parole, modello caricato in {load_s:.1f} s",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
