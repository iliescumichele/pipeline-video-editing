"""Lingua parlata in ogni tratto di un WAV, con Whisper (solo il riconoscimento della lingua).

Uso: langid.py <wav> <cartella modello> <tratti.json> <out.json> [--batch 16] [--device mps|cpu]

tratti.json è una lista di [inizio, fine] in secondi (al massimo 30 s l'uno). out.json riceve per
ogni tratto {"start", "end", "lang", "p", "top"}: codice della lingua più probabile (it, ro, en…),
la sua probabilità tra le lingue e le cinque lingue più probabili con la loro.
"""

import argparse
import json
import sys
import time

import numpy as np
import soundfile as sf
import torch
from scipy.signal import resample_poly
from transformers import WhisperFeatureExtractor, WhisperForConditionalGeneration

SR = 16000


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("wav")
    p.add_argument("model_dir")
    p.add_argument("spans")
    p.add_argument("out")
    p.add_argument("--batch", type=int, default=16)
    p.add_argument("--device", default="mps")
    a = p.parse_args()

    device = a.device if a.device != "mps" or torch.backends.mps.is_available() else "cpu"

    audio, sr = sf.read(a.wav, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if sr != SR:
        g = np.gcd(sr, SR)
        audio = resample_poly(audio, SR // g, sr // g).astype(np.float32)
    with open(a.spans) as f:
        spans: list[list[float]] = json.load(f)

    fe = WhisperFeatureExtractor.from_pretrained(a.model_dir)
    model = WhisperForConditionalGeneration.from_pretrained(a.model_dir).to(device).eval()
    gc = model.generation_config
    # token della lingua → codice: "<|ro|>" → "ro"
    langs = {tid: tok[2:-2] for tok, tid in gc.lang_to_id.items()}
    ids = list(langs)
    lang_ids = torch.tensor(ids, device=device)
    start = torch.full((1, 1), gc.decoder_start_token_id, dtype=torch.long, device=device)

    out = []
    t0 = time.perf_counter()
    for b in range(0, len(spans), a.batch):
        batch = spans[b : b + a.batch]
        clips = [audio[int(s * SR) : int(e * SR)] for s, e in batch]
        feats = fe(clips, sampling_rate=SR, return_tensors="pt")["input_features"].to(device)
        with torch.no_grad():
            logits = model(input_features=feats, decoder_input_ids=start.expand(len(batch), 1)).logits[:, -1]
        probs = torch.softmax(logits[:, lang_ids], dim=-1).cpu().numpy()
        for (s, e), row in zip(batch, probs):
            best = row.argsort()[::-1][:5]
            top = {langs[ids[k]]: round(float(row[k]), 3) for k in best}
            out.append({"start": s, "end": e, "lang": langs[ids[best[0]]], "p": top[langs[ids[best[0]]]], "top": top})
        print(f"\r  {len(out)}/{len(spans)} frasi", end="", file=sys.stderr)
    dt = time.perf_counter() - t0
    print("", file=sys.stderr)

    with open(a.out, "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    talk = sum(e - s for s, e in spans)
    print(f"langid: {talk:.0f} s di parlato in {dt:.1f} s ({talk / max(dt, 1e-6):.0f}x) su {device}", file=sys.stderr)


if __name__ == "__main__":
    main()
