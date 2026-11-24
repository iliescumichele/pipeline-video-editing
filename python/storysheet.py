"""Fogli con l'orario scritto sopra, per guardare un video lungo e trovare le storie degli short.

    storysheet.py sheet <cartella-fotogrammi> <prefisso-uscita> <passo-s> [<inizio-s>]
        fotogrammi f0001.jpg, f0002.jpg, ... estratti ogni <passo-s> secondi a partire da <inizio-s>:
        griglie 6×6 con l'orario m:ss in giallo in alto a sinistra. Stampa i percorsi dei fogli.
    storysheet.py strip <cartella-fotogrammi> <uscita.jpg> <passo-s> <inizio-s>
        una colonna di fotogrammi (di solito la fascia dei sottotitoli) con l'orario in secondi a sinistra:
        serve a leggere le battute dei personaggi e quando iniziano/finiscono.

ffmpeg di sistema non ha drawtext, per questo l'orario si scrive qui con PIL.
"""

import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def frames(folder: str) -> list[str]:
    return sorted(glob.glob(os.path.join(folder, "f*.jpg")))


def stamp(i: int, step: float, start: float) -> float:
    return start + i * step


def sheet(folder: str, prefix: str, step: float, start: float) -> None:
    fs = frames(folder)
    cols, per = 6, 36
    font = ImageFont.truetype(FONT, 26)
    for s in range(0, len(fs), per):
        chunk = fs[s : s + per]
        w, h = Image.open(chunk[0]).size
        rows = (len(chunk) + cols - 1) // cols
        out = Image.new("RGB", (cols * w, rows * h), (0, 0, 0))
        d = ImageDraw.Draw(out)
        for i, f in enumerate(chunk):
            t = stamp(s + i, step, start)
            x, y = (i % cols) * w, (i // cols) * h
            out.paste(Image.open(f), (x, y))
            label = f"{int(t // 60)}:{int(t % 60):02d}"
            d.rectangle([x, y, x + 90, y + 30], fill=(0, 0, 0))
            d.text((x + 4, y + 1), label, font=font, fill=(255, 220, 0))
        path = f"{prefix}-{s // per + 1:02d}.jpg"
        out.save(path, quality=80)
        print(path)


def strip(folder: str, path: str, step: float, start: float) -> None:
    fs = frames(folder)
    font = ImageFont.truetype(FONT, 22)
    w, h = Image.open(fs[0]).size
    out = Image.new("RGB", (w + 100, h * len(fs)), (0, 0, 0))
    d = ImageDraw.Draw(out)
    for i, f in enumerate(fs):
        out.paste(Image.open(f), (100, i * h))
        d.text((4, i * h + h // 2 - 12), f"{stamp(i, step, start):.1f}", font=font, fill=(255, 220, 0))
    out.save(path, quality=80)
    print(path)


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "sheet":
        sheet(sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5]) if len(sys.argv) > 5 else 0.0)
    elif mode == "strip":
        strip(sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5]))
    else:
        sys.exit(f"modo sconosciuto: {mode}")
