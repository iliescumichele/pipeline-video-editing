"""Separa un audio di gioco in dialoghi, musica ed effetti con BandIt Plus (Divide and Remaster).

Uso: separate_cinematic.py <ingresso> <cartella di uscita> [--device auto|mps|cpu]
Scrive speech.wav, music.wav ed effects.wav (float32, 44,1 kHz stereo come vuole il modello: l'ingresso deve
essere già così, lo prepara ffmpeg). La somma dei tre è circa l'ingresso.

Il codice del modello è quello di ZFTurbo/Music-Source-Separation-Training (MIT), clonato in .tools/msst a un
commit fisso (models.json, voce msst-code): se ne carica solo l'architettura, senza le librerie di training
(pytorch_lightning, asteroid, torchmetrics), che il suo pacchetto importerebbe all'avvio.
"""

import argparse
import json
import os
import sys
import time
import types
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import yaml

ROOT = Path(__file__).resolve().parent.parent
MSST = ROOT / ".tools" / "msst"
MODEL_DIR = ROOT / "models" / "bandit-dnr"
WEIGHTS = MODEL_DIR / "model_bandit_plus_dnr_sdr_11.47.chpt"
CONFIG = MODEL_DIR / "config_dnr_bandit_bsrnn_multi_mus64.yaml"
STEMS = ("speech", "music", "effects")


def load_model(device: str) -> tuple[torch.nn.Module, int, int]:
    """Il modello BandIt Plus pronto per l'inferenza; restituisce anche frequenza e lunghezza dei blocchi."""
    sys.path.insert(0, str(MSST))
    # pytorch_lightning serve al pacchetto solo come classe base: per l'inferenza basta un nn.Module
    pl = types.ModuleType("pytorch_lightning")
    pl.LightningModule = torch.nn.Module  # type: ignore[attr-defined]
    sys.modules.setdefault("pytorch_lightning", pl)
    # models/bandit/core/__init__.py importa tutto il training: si registra il pacchetto senza eseguirlo
    core = types.ModuleType("models.bandit.core")
    core.__path__ = [str(MSST / "models" / "bandit" / "core")]  # type: ignore[attr-defined]
    sys.modules["models.bandit.core"] = core
    from models.bandit.core.model import MultiMaskMultiSourceBandSplitRNNSimple  # noqa: E402

    config = yaml.safe_load(CONFIG.read_text())
    if tuple(config["model"]["stems"]) != STEMS:
        raise SystemExit(f"stem inattesi nella configurazione: {config['model']['stems']}")
    model = MultiMaskMultiSourceBandSplitRNNSimple(**config["model"])
    model.load_state_dict(torch.load(WEIGHTS, map_location="cpu"))
    # alcuni buffer (le bande di frequenza) nascono a 64 bit, che la GPU del Mac non supporta
    model.eval().float().to(device)
    return model, int(config["audio"]["sample_rate"]), int(config["audio"]["chunk_size"])


def separate(model: torch.nn.Module, audio: np.ndarray, chunk: int, device: str) -> np.ndarray:
    """(campioni, 2) → (3 stem, campioni, 2). Blocchi sovrapposti a metà, sommati con una finestra di Hann."""
    n = audio.shape[0]
    step = chunk // 2
    pad = step
    x = np.pad(audio, ((pad, pad + chunk), (0, 0)), mode="reflect" if n > pad + chunk else "constant")
    window = np.sin(np.linspace(0, np.pi, chunk, endpoint=False)) ** 2  # Hann periodica: a metà si somma a 1
    out = np.zeros((len(STEMS), x.shape[0], 2), dtype=np.float32)
    weight = np.zeros(x.shape[0], dtype=np.float32)
    with torch.inference_mode():
        for start in range(0, x.shape[0] - chunk + 1, step):
            part = torch.from_numpy(x[start : start + chunk].T.copy()).unsqueeze(0).to(device)
            y = model(part)[0].float().cpu().numpy()  # (stem, canali, campioni)
            out[:, start : start + chunk] += (y * window).transpose(0, 2, 1)
            weight[start : start + chunk] += window
    out /= np.maximum(weight, 1e-6)[None, :, None]
    return out[:, pad : pad + n]


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("input")
    p.add_argument("out_dir")
    p.add_argument("--device", default="auto")
    a = p.parse_args()

    device = a.device
    if device == "auto":
        device = "mps" if torch.backends.mps.is_available() else "cpu"
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

    t0 = time.time()
    model, sr, chunk = load_model(device)
    audio, in_sr = sf.read(a.input, dtype="float32", always_2d=True)
    if in_sr != sr:
        raise SystemExit(f"l'ingresso è a {in_sr} Hz, BandIt vuole {sr} Hz")
    if audio.shape[1] == 1:
        audio = np.repeat(audio, 2, axis=1)
    t1 = time.time()
    try:
        stems = separate(model, audio, chunk, device)
    except RuntimeError as e:
        if device == "cpu":
            raise
        print(f"{device} non riesce ({e}); rifaccio sulla CPU", file=sys.stderr)
        device = "cpu"
        model = model.to("cpu")
        stems = separate(model, audio, chunk, device)
    t2 = time.time()

    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for name, s in zip(STEMS, stems):
        sf.write(out / f"{name}.wav", s, sr, subtype="FLOAT")
    secs = audio.shape[0] / sr
    print(json.dumps({"device": device, "seconds": round(secs, 1), "load_s": round(t1 - t0, 1), "separate_s": round(t2 - t1, 1), "speed_x": round(secs / max(t2 - t1, 1e-6), 2)}))


if __name__ == "__main__":
    main()
