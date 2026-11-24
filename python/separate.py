"""Separa la voce dal resto con Demucs (htdemucs, due stem come `--two-stems vocals`).

Uso: separate.py <input.wav a 44.1 kHz> <cartella di uscita> [--device mps|cpu]
Scrive vocals.wav e no_vocals.wav (float32, stessa frequenza e canali dell'ingresso).
"""

import argparse
import sys
import time
from pathlib import Path

import soundfile as sf
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("input")
    p.add_argument("out_dir")
    p.add_argument("--device", default="mps")
    p.add_argument("--model", default="htdemucs")
    a = p.parse_args()

    device = a.device
    if device == "mps" and not torch.backends.mps.is_available():
        print("MPS non disponibile, uso la CPU", file=sys.stderr)
        device = "cpu"

    model = get_model(a.model)
    model.eval()
    wav, sr = sf.read(a.input, dtype="float32", always_2d=True)
    if sr != model.samplerate:
        sys.exit(f"l'ingresso è a {sr} Hz, Demucs vuole {model.samplerate} Hz")

    x = torch.from_numpy(wav.T.copy())
    if x.shape[0] == 1:
        x = x.repeat(2, 1)
    # Stessa normalizzazione della CLI di Demucs.
    ref = x.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    x = (x - mean) / std

    t0 = time.perf_counter()
    with torch.no_grad():
        out = apply_model(model, x[None], device=device, shifts=0, split=True, overlap=0.25, progress=True)[0]
    out = out * std + mean
    vocals = out[model.sources.index("vocals")]
    rest = out.sum(0) - vocals

    out_dir = Path(a.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    sf.write(out_dir / "vocals.wav", vocals.T.numpy(), sr, subtype="FLOAT")
    sf.write(out_dir / "no_vocals.wav", rest.T.numpy(), sr, subtype="FLOAT")
    dur = wav.shape[0] / sr
    dt = time.perf_counter() - t0
    print(f"demucs: {dur:.0f} s di audio in {dt:.0f} s ({dur / dt:.1f}x) su {device}", file=sys.stderr)


if __name__ == "__main__":
    main()
