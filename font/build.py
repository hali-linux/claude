#!/usr/bin/env python3
"""몽글체 TTF 빌드 스크립트.

    python3 font/build.py                      # Regular + Bold 를 font/dist/ 에 생성
    python3 font/build.py --weights regular    # 한 굵기만
    python3 font/build.py --family-ko 내글씨체 --family-en MyHand   # 이름 바꾸기

모든 글자는 hangul.py / latin.py 의 중심선 설계에서 만들어진다.
"""

import argparse
import os
import sys
import time

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables import ttProgram

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from geom import Shape, outline  # noqa: E402
from hangul import CHO, COMPAT_CONSONANTS, COMPAT_VOWELS, JONG, JUNG, Hangul  # noqa: E402
from latin import build_latin  # noqa: E402

UPM = 1000
VERSION = "1.000"
# 한글 글자의 시각적 영역 (획 바깥 테두리 기준)과 글자 폭. 좌우 여백 50씩.
HANGUL_VISUAL = (50, -60, 910, 800)
HANGUL_ADVANCE = 960
ASCENT, DESCENT = 880, -220

WEIGHTS = {
    # 이름: (세로획 굵기, 가로획 두께 비율, usWeightClass)
    "regular": (68, 0.94, 400),
    "bold": (96, 0.86, 700),
}


def to_glyph(shape, width, ky=1.0):
    pen = TTGlyphPen(None)
    if shape is not None and (shape.subpaths or shape.dots):
        outline(shape, width, ky).draw(Cu2QuPen(pen, max_err=1.0, reverse_direction=False))
    return pen.glyph()


def notdef_glyph():
    s = Shape().poly((80, 0), (80, 700), (420, 700), (420, 0), closed=True)
    return to_glyph(s, 50)


def glyph_name(cp):
    return "uni%04X" % cp if cp <= 0xFFFF else "u%05X" % cp


def build(weight, family_en, family_ko, outdir, woff2=True):
    stroke, ky, weight_class = WEIGHTS[weight]
    style = weight.capitalize()
    t0 = time.time()

    glyphs = {".notdef": notdef_glyph()}
    advances = {".notdef": 500}
    cmap = {}

    # --- 라틴·기호: 윤곽 범위로 좌우 여백을 자동 계산 -------------------------
    side = 48
    lw = stroke * 0.94
    for ch, (shape, fixed, extent) in build_latin(lw, ky).items():
        name = glyph_name(ord(ch))
        if shape is None:
            glyphs[name], advances[name] = to_glyph(None, 0), fixed
        else:
            if extent:
                x0, x1 = extent[0] - lw / 2, extent[1] + lw / 2
            else:
                x0, _, x1, _ = outline(shape, lw, ky).bounds
            adv = fixed if fixed else round(x1 - x0 + 2 * side)
            dx = (adv - (x1 - x0)) / 2 - x0
            glyphs[name] = to_glyph(shape.translated(dx, 0), lw, ky)
            advances[name] = adv
        cmap[ord(ch)] = name

    # --- 한글 ---------------------------------------------------------------
    vx0, vy0, vx1, vy1 = HANGUL_VISUAL
    h = stroke / 2
    hg = Hangul(stroke, (vx0 + h, vy0 + h * ky, vx1 - h, vy1 - h * ky), ky)

    for i, ch in enumerate(COMPAT_CONSONANTS + COMPAT_VOWELS):
        cp = 0x3131 + i
        name = glyph_name(cp)
        shape, w = hg.jamo(ch)
        glyphs[name], advances[name] = to_glyph(shape, w, ky), HANGUL_ADVANCE
        cmap[cp] = name

    for ci, cho in enumerate(CHO):
        for vi, jung in enumerate(JUNG):
            for fi, jong in enumerate(JONG):
                cp = 0xAC00 + (ci * 21 + vi) * 28 + fi
                name = glyph_name(cp)
                shape, w = hg.syllable(cho, jung, jong)
                glyphs[name], advances[name] = to_glyph(shape, w, ky), HANGUL_ADVANCE
                cmap[cp] = name
        print(f"  [{weight}] 초성 {cho} 완료 ({time.time() - t0:.0f}s)", flush=True)

    # --- 폰트 조립 -----------------------------------------------------------
    order = [".notdef"] + sorted((n for n in glyphs if n != ".notdef"), key=lambda n: int(n[3:], 16))
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    glyf = fb.font["glyf"]
    metrics = {}
    for n in order:
        g = glyf[n]
        g.recalcBounds(glyf)
        metrics[n] = (advances[n], getattr(g, "xMin", 0))
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ASCENT, descent=DESCENT, lineGap=0)

    ps_family = "".join(c for c in family_en if c.isalnum())
    fb.setupNameTable(
        {
            "copyright": f"Copyright (c) {time.strftime('%Y')}, {family_en} authors.",
            "familyName": {"en": family_en, "ko": family_ko},
            "styleName": {"en": style, "ko": style},
            "uniqueFontIdentifier": f"{VERSION};{ps_family}-{style}",
            "fullName": {"en": f"{family_en} {style}", "ko": f"{family_ko} {style}"},
            "version": f"Version {VERSION}",
            "psName": f"{ps_family}-{style}",
            "description": "Rounded monoline Hangul font generated from stroke skeletons.",
        },
        mac=False,
    )

    ymax = max(getattr(glyf[n], "yMax", 0) for n in order)
    ymin = min(getattr(glyf[n], "yMin", 0) for n in order)
    bold = weight_class >= 700
    fb.setupOS2(
        version=4,
        usWeightClass=weight_class,
        usWidthClass=5,
        fsType=0,  # 설치·임베딩 제한 없음
        achVendID="NONE",
        sTypoAscender=ASCENT,
        sTypoDescender=DESCENT,
        sTypoLineGap=0,
        usWinAscent=max(ASCENT, ymax),
        usWinDescent=max(-DESCENT, -ymin),
        sxHeight=500,
        sCapHeight=700,
        fsSelection=(1 << 5 if bold else 1 << 6) | (1 << 7),  # BOLD/REGULAR + USE_TYPO_METRICS
        ulCodePageRange1=(1 << 0) | (1 << 19),  # Latin 1, Korean Wansung
    )
    fb.setupPost(keepGlyphNames=False)
    font = fb.font
    font["head"].fontRevision = float(VERSION)
    font["head"].macStyle = 1 if bold else 0
    font["OS/2"].recalcUnicodeRanges(font)

    # 힌팅 없는 폰트를 모든 크기에서 매끄럽게 (gasp + 드롭아웃 제어 prep)
    gasp = newTable("gasp")
    gasp.gaspRange = {0xFFFF: 0x000F}
    font["gasp"] = gasp
    prog = ttProgram.Program()
    prog.fromAssembly(["PUSHW[]", "511", "SCANCTRL[]", "PUSHB[]", "4", "SCANTYPE[]"])
    prep = newTable("prep")
    prep.program = prog
    font["prep"] = prep

    os.makedirs(outdir, exist_ok=True)
    base = os.path.join(outdir, f"{ps_family}-{style}")
    font.save(base + ".ttf")
    print(f"  → {base}.ttf  ({len(order)} glyphs, {os.path.getsize(base + '.ttf') / 1e6:.1f} MB)")
    if woff2:
        font.flavor = "woff2"
        font.save(base + ".woff2")
        print(f"  → {base}.woff2 ({os.path.getsize(base + '.woff2') / 1e6:.1f} MB)")
    return base + ".ttf"


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weights", default="regular,bold", help="regular,bold 중 쉼표로 구분")
    ap.add_argument("--family-en", default="Monggeul", help="영문 글꼴 이름")
    ap.add_argument("--family-ko", default="몽글체", help="한글 글꼴 이름")
    ap.add_argument("--out", default=os.path.join(here, "dist"), help="출력 폴더")
    ap.add_argument("--no-woff2", action="store_true", help="웹폰트(woff2) 생략")
    args = ap.parse_args()
    for wname in args.weights.split(","):
        build(wname.strip().lower(), args.family_en, args.family_ko, args.out, not args.no_woff2)


if __name__ == "__main__":
    main()
