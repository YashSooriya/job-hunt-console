#!/usr/bin/env python3
"""Create one PDF/DOCX-renderer contact sheet for synthetic M06 theme review."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


THEMES = (
    "classic-navy", "clean-charcoal", "technical-slate", "research-classic",
    "modern-teal", "engineering-blue", "quiet-olive", "minimal-black",
)
COLUMNS = (
    ("PDF CV · page 1", "cv.pdf", 1),
    ("PDF CV · page 2", "cv.pdf", 2),
    ("PDF cover letter", "letter.pdf", 1),
)


def render_page(pdftoppm: str, pdf: Path, page: int, output: Path) -> Image.Image | None:
    if not pdf.is_file():
        return None
    prefix = output / f"{pdf.stem}-{page}"
    subprocess.run(
        [pdftoppm, "-png", "-f", str(page), "-l", str(page), "-scale-to-x", "170", "-scale-to-y", "240", str(pdf), str(prefix)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    image_path = prefix.with_name(prefix.name + f"-{page}.png")
    if not image_path.is_file():
        return None
    with Image.open(image_path) as image:
        return image.convert("RGB")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    fixture_dir = args.fixtures.resolve(strict=True)
    word_report = json.loads((fixture_dir / "m06-word-pagination.json").read_text(encoding="utf-8-sig"))
    if not str(word_report.get("result", "")).startswith("PASS") or len(word_report.get("fixtures", [])) != 16:
        raise SystemExit("The contact sheet needs a passing Microsoft Word pagination report for all eight paired themes.")
    word_pages = {
        (fixture["theme"], fixture["kind"]): fixture["pages"]
        for fixture in word_report["fixtures"]
    }
    if any(word_pages.get((theme, "cv")) != 2 for theme in THEMES):
        raise SystemExit("Microsoft Word CV page-count evidence is incomplete.")
    if any(word_pages.get((theme, "letter")) != 1 for theme in THEMES):
        raise SystemExit("Microsoft Word cover-letter page-count evidence is incomplete.")
    pdftoppm = shutil.which("pdftoppm.exe") or shutil.which("pdftoppm")
    if not pdftoppm:
        raise SystemExit("Poppler pdftoppm is required to render the PDF contact sheet.")

    cell_width, cell_height, title_height = 225, 310, 46
    margin, gap = 18, 12
    width = margin * 2 + len(COLUMNS) * cell_width + (len(COLUMNS) - 1) * gap
    height = margin * 2 + len(THEMES) * (cell_height + title_height + gap)
    sheet = Image.new("RGB", (width, height), "#e7ebf0")
    draw = ImageDraw.Draw(sheet)
    try:
        title_font = ImageFont.truetype("arial.ttf", 14)
        body_font = ImageFont.truetype("arial.ttf", 12)
    except OSError:
        title_font = ImageFont.load_default()
        body_font = ImageFont.load_default()

    with tempfile.TemporaryDirectory(prefix="jobhunt-m06-contact-") as temporary:
        render_dir = Path(temporary)
        for row, theme in enumerate(THEMES):
            row_top = margin + row * (cell_height + title_height + gap)
            draw.text((margin, row_top), f"{theme} · Word: CV 2 pages / letter 1 page", fill="#17212d", font=title_font)
            for column, (caption, suffix, page) in enumerate(COLUMNS):
                left = margin + column * (cell_width + gap)
                top = row_top + title_height
                draw.text((left, top), caption, fill="#465465", font=body_font)
                pdf = fixture_dir / f"{theme}-{suffix}"
                image = render_page(pdftoppm, pdf, page, render_dir)
                if image is None:
                    draw.text((left + 12, top + 48), "page not present", fill="#7c3941", font=body_font)
                    continue
                image.thumbnail((cell_width - 8, cell_height - 8), Image.Resampling.LANCZOS)
                x = left + (cell_width - image.width) // 2
                y = top + 30
                sheet.paste(image, (x, y))
                draw.rectangle((x - 1, y - 1, x + image.width, y + image.height), outline="#bcc5cf", width=1)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.output, format="PNG", optimize=True)
    print(f"Contact sheet: {args.output} ({width}x{height}, {len(THEMES)} themes, one shared synthetic CV and letter; Word page counts included)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
