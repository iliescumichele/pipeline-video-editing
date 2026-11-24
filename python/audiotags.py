"""Probabilità nel tempo di gruppi di classi AudioSet, con AST (Audio Spectrogram Transformer).

Uso: audiotags.py <wav> <cartella modello> <out.json> --groups '{"laughter": ["Laughter", ...]}'
                  [--win 4] [--hop 1] [--device mps|cpu]

Finestre di --win secondi ogni --hop secondi. Per ogni finestra e gruppo scrive la probabilità
massima tra le classi del gruppo. Il valore i-esimo copre [i*hop, i*hop + win).
"""

import argparse
import json
import sys
import time

import numpy as np
import soundfile as sf
import torch
from scipy.signal import resample_poly
from transformers import ASTFeatureExtractor, ASTForAudioClassification

SR = 16000


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("wav")
    p.add_argument("model_dir")
    p.add_argument("out")
    p.add_argument("--groups", required=True)
    p.add_argument("--win", type=float, default=4.0)
    p.add_argument("--hop", type=float, default=1.0)
    p.add_argument("--batch", type=int, default=32)
    p.add_argument("--device", default="mps")
    a = p.parse_args()

    device = a.device if a.device != "mps" or torch.backends.mps.is_available() else "cpu"
    groups: dict[str, list[str]] = json.loads(a.groups)

    audio, sr = sf.read(a.wav, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if sr != SR:
        g = np.gcd(sr, SR)
        audio = resample_poly(audio, SR // g, sr // g).astype(np.float32)

    fe = ASTFeatureExtractor.from_pretrained(a.model_dir)
    model = ASTForAudioClassification.from_pretrained(a.model_dir).to(device).eval()
    label2id = {v: int(k) for k, v in model.config.id2label.items()}
    idx = {}
    for name, labels in groups.items():
        missing = [l for l in labels if l not in label2id]
        if missing:
            sys.exit(f"classi AudioSet sconosciute nel gruppo {name}: {missing}")
        idx[name] = [label2id[l] for l in labels]

    win, hop = int(a.win * SR), int(a.hop * SR)
    starts = list(range(0, max(1, len(audio) - win + hop), hop))
    out = {name: [] for name in groups}

    t0 = time.perf_counter()
    for b in range(0, len(starts), a.batch):
        chunk = [audio[s : s + win] for s in starts[b : b + a.batch]]
        feats = fe(chunk, sampling_rate=SR, return_tensors="pt")["input_values"].to(device)
        with torch.no_grad():
            probs = torch.sigmoid(model(feats).logits).cpu().numpy()
        for name, ids in idx.items():
            out[name].extend(np.round(probs[:, ids].max(axis=1), 4).tolist())
    dt = time.perf_counter() - t0

    with open(a.out, "w") as f:
        json.dump({"win": a.win, "hop": a.hop, "groups": out}, f)
    dur = len(audio) / SR
    print(f"audiotags: {dur:.0f} s di audio in {dt:.1f} s ({dur / max(dt, 1e-6):.0f}x) su {device}", file=sys.stderr)


if __name__ == "__main__":
    main()
