import json
import sys
from pathlib import Path

import fitz  # PyMuPDF

sys.stdout.reconfigure(encoding="utf-8")

BASE_DIR = Path(__file__).resolve().parent
CARDS_PATH = BASE_DIR / "cards.json"
MIN_W = 120  # skip tiny decorative glyphs/icons
MIN_H = 120


def extract_card(card: dict) -> None:
    card_dir = BASE_DIR / card["id"]
    pdf_path = card_dir / "source.pdf"
    if not pdf_path.exists():
        print(f"{card['id']}: no source.pdf, skip")
        return
    img_dir = card_dir / "images"
    img_dir.mkdir(exist_ok=True)

    doc = fitz.open(str(pdf_path))
    page_map: dict[str, list[str]] = {}
    seen: dict[int, str] = {}  # xref -> filename (dedupe repeated images)
    total = 0
    for pno in range(doc.page_count):
        page = doc[pno]
        files: list[str] = []
        n = 0
        for img in page.get_images(full=True):
            xref = img[0]
            if xref in seen:
                files.append(seen[xref])
                continue
            try:
                pix = fitz.Pixmap(doc, xref)
            except Exception:
                continue
            if pix.width < MIN_W or pix.height < MIN_H:
                continue
            if pix.colorspace and pix.colorspace.n >= 4:  # CMYK -> RGB
                pix = fitz.Pixmap(fitz.csRGB, pix)
            elif pix.alpha:
                pix = fitz.Pixmap(fitz.csRGB, pix)
            n += 1
            fname = f"page{pno + 1}_{n}.png"
            pix.save(str(img_dir / fname))
            seen[xref] = fname
            files.append(fname)
            total += 1
        if files:
            page_map[str(pno + 1)] = files
    doc.close()

    with (img_dir / "map.json").open("w", encoding="utf-8", newline="\n") as f:
        json.dump(page_map, f, ensure_ascii=False)
    print(f"{card['id']}: {total} images across {len(page_map)} pages")


def main() -> None:
    cards = json.loads(CARDS_PATH.read_text(encoding="utf-8"))
    only = set(sys.argv[1:])
    for card in cards:
        if only and card["id"] not in only:
            continue
        extract_card(card)


if __name__ == "__main__":
    main()
