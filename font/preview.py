#!/usr/bin/env python3
"""만든 TTF로 견본 이미지를 그린다.

    python3 font/preview.py                       # font/preview.png
    python3 font/preview.py --text "안녕하세요" --size 120 --out hello.png
"""

import argparse
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")

SPECIMEN = [
    (150, "몽글체"),
    (64, "다람쥐 헌 쳇바퀴에 타고파"),
    (64, "가나다라마바사아자차카타파하"),
    (64, "꽃 닭 읽고 앉아 넋 놓고 뚫어 훑다"),
    (64, "괜찮아요 웬만하면 원하는 대로 돼요"),
    (40, "키스의 고유조건은 입술끼리 만나야 하고 특별한 기술은 필요치 않다."),
    (40, "동해 물과 백두산이 마르고 닳도록 하느님이 보우하사 우리나라 만세"),
    (40, "The quick brown fox jumps over the lazy dog. 0123456789"),
    (40, "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz"),
    (40, "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~ ₩1,000 · “한글” ‘따옴표’ …"),
    (40, "ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ ㄲㄸㅃㅆㅉ ㅏㅑㅓㅕㅗㅛㅜㅠㅡㅣ ㅋㅋㅋ ㅎㅎ"),
]


def render(lines, fonts, out, margin=60, gap=1.35):
    """lines: [(size, text)], fonts: [(label, path)] → 굵기별로 세로로 이어 붙인 이미지."""
    blocks = []
    for label, path in fonts:
        rows = []
        for size, text in lines:
            f = ImageFont.truetype(path, size)
            x0, y0, x1, y1 = f.getbbox(text)
            rows.append((f, text, x1, int(size * gap)))
        width = max(r[2] for r in rows) + margin * 2
        height = sum(r[3] for r in rows) + margin * 2 + 40
        img = Image.new("RGB", (width, height), "white")
        d = ImageDraw.Draw(img)
        d.text((margin, 16), label, fill=(150, 150, 150), font=ImageFont.truetype(path, 24))
        y = margin + 30
        for f, text, _, lh in rows:
            d.text((margin, y), text, fill=(20, 20, 30), font=f)
            y += lh
        blocks.append(img)
    W = max(b.width for b in blocks)
    H = sum(b.height for b in blocks)
    sheet = Image.new("RGB", (W, H), "white")
    y = 0
    for b in blocks:
        sheet.paste(b, (0, y))
        y += b.height
    sheet.save(out)
    print("saved", out, sheet.size)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", help="이 문장만 그리기")
    ap.add_argument("--size", type=int, default=96)
    ap.add_argument("--out", default=os.path.join(HERE, "preview.png"))
    ap.add_argument("--fonts", default="Monggeul-Regular,Monggeul-Bold")
    args = ap.parse_args()
    fonts = []
    for name in args.fonts.split(","):
        p = os.path.join(DIST, name + ".ttf")
        if os.path.exists(p):
            fonts.append((name, p))
    lines = [(args.size, t) for t in args.text.split("\\n")] if args.text else SPECIMEN
    render(lines, fonts, args.out)


if __name__ == "__main__":
    main()
