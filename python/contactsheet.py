"""Fogli di provini numerati: tante immagini piccole in una griglia, con il numero in alto a sinistra.

    python contactsheet.py <prefisso-uscita> <immagine> [<immagine> ...]

Scrive <prefisso>-1.jpg, <prefisso>-2.jpg, ... (48 immagini per foglio, 8 colonne) e stampa i percorsi.
Servono al modello che sceglie gli screenshot per la miniatura: vede tutto in pochi fogli e li indica per numero.
"""

import sys

from PIL import Image, ImageDraw, ImageFont

COLS, PER_SHEET = 8, 48
CELL_W, CELL_H = 256, 144
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def main() -> None:
    prefix, images = sys.argv[1], sys.argv[2:]
    font = ImageFont.truetype(FONT, 30)
    for s in range(0, len(images), PER_SHEET):
        chunk = images[s : s + PER_SHEET]
        rows = (len(chunk) + COLS - 1) // COLS
        sheet = Image.new("RGB", (COLS * CELL_W, rows * CELL_H), (20, 20, 20))
        draw = ImageDraw.Draw(sheet)
        for i, path in enumerate(chunk):
            with Image.open(path) as im:
                im = im.convert("RGB")
                im.thumbnail((CELL_W - 4, CELL_H - 4))
                x, y = (i % COLS) * CELL_W + 2, (i // COLS) * CELL_H + 2
                sheet.paste(im, (x, y))
            label = str(s + i + 1)
            box = draw.textbbox((x + 4, y + 2), label, font=font)
            draw.rectangle((box[0] - 4, box[1] - 2, box[2] + 4, box[3] + 2), fill=(0, 0, 0))
            draw.text((x + 4, y + 2), label, font=font, fill=(255, 220, 0))
        out = f"{prefix}-{s // PER_SHEET + 1}.jpg"
        sheet.save(out, quality=85)
        print(out)


if __name__ == "__main__":
    main()
