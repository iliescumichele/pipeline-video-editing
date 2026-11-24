"""Di quanto il secondo file parte dopo il primo, confrontando l'audio (correlazione incrociata).

Uso: syncoffset.py <main.wav> <other.wav>   (WAV mono, stessa frequenza; bastano 60–120 s)
Stampa un JSON: {"offset": secondi, "confidence": 0–1}. offset > 0 vuol dire che il secondo file
inizia quando il primo è già a `offset` secondi.
"""

import json
import sys

import numpy as np
import soundfile as sf
from scipy.signal import correlate


def envelope(x: np.ndarray) -> np.ndarray:
    # Differenza prima: toglie la componente continua e dà più peso ai transienti.
    x = np.diff(x, prepend=x[:1])
    return (x - x.mean()) / (x.std() + 1e-9)


def main() -> None:
    a, sr_a = sf.read(sys.argv[1], dtype="float32", always_2d=False)
    b, sr_b = sf.read(sys.argv[2], dtype="float32", always_2d=False)
    if sr_a != sr_b:
        sys.exit("le due tracce devono avere la stessa frequenza")
    ea, eb = envelope(a), envelope(b)
    c = correlate(ea, eb, mode="full", method="fft")
    lag = int(np.argmax(c)) - (len(eb) - 1)
    peak = float(c.max())
    conf = peak / (np.sqrt((ea**2).sum() * (eb**2).sum()) + 1e-9)
    print(json.dumps({"offset": round(lag / sr_a, 4), "confidence": round(float(conf), 3)}))


if __name__ == "__main__":
    main()
