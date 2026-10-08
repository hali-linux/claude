"""한글 자모 설계와 음절 조합 규칙.

음절 = 초성 + 중성 (+ 종성). 중성의 모양에 따라 세 가지 틀로 나눈다.
  V: 세로 모음(ㅏ ㅐ ㅑ ㅒ ㅓ ㅔ ㅕ ㅖ ㅣ)  → 초성은 왼쪽
  H: 가로 모음(ㅗ ㅛ ㅜ ㅠ ㅡ)             → 초성은 위쪽
  C: 섞임 모음(ㅘ ㅙ ㅚ ㅝ ㅞ ㅟ ㅢ)        → 초성은 왼쪽 위
받침이 있으면 아래쪽에 종성 칸을 만들고 나머지를 위로 올린다.

모든 위치는 '중심선 틀'(frame)에 대한 0..1 비율이며, 획 굵기는 음절 안에서
일정하다. 복잡한 음절(겹받침 등)은 숨통을 위해 굵기를 조금 줄인다.
"""

from geom import Box, Shape

CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"
JONG = [None] + list("ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ")

# 호환용 자모(U+3131~U+3163) 순서
COMPAT_CONSONANTS = "ㄱㄲㄳㄴㄵㄶㄷㄸㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅃㅄㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
COMPAT_VOWELS = JUNG

# 두 자음을 나란히 놓는 쌍자음·겹받침
PAIRS = {
    "ㄲ": "ㄱㄱ", "ㄸ": "ㄷㄷ", "ㅃ": "ㅂㅂ", "ㅆ": "ㅅㅅ", "ㅉ": "ㅈㅈ",
    "ㄳ": "ㄱㅅ", "ㄵ": "ㄴㅈ", "ㄶ": "ㄴㅎ", "ㄺ": "ㄹㄱ", "ㄻ": "ㄹㅁ",
    "ㄼ": "ㄹㅂ", "ㄽ": "ㄹㅅ", "ㄾ": "ㄹㅌ", "ㄿ": "ㄹㅍ", "ㅀ": "ㄹㅎ",
    "ㅄ": "ㅂㅅ",
}


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


# ---------------------------------------------------------------------------
# 자음 (단위 상자 0..1 안의 중심선. var: 'L' 세로모음 왼쪽, 'T' 위쪽, 'F' 받침)
# ---------------------------------------------------------------------------

def _giyeok(s, b, w, var):
    if var == "L":
        b.path(s, "M0 1 L1 1 Q1 .28 .58 0")  # 왼쪽으로 살짝 쓸어내린 다리
    else:
        b.path(s, "M0 1 L1 1 L1 0")


def _kieuk(s, b, w, var):
    _giyeok(s, b, w, var)
    b.path(s, "M0 .5 L.935 .5" if var == "L" else "M0 .5 L1 .5")


def _nieun(s, b, w, var):
    b.path(s, "M0 1 L0 0 L1 0")


def _digeut(s, b, w, var):
    b.path(s, "M1 1 L0 1 L0 0 L1 0")


def _tieut(s, b, w, var):
    b.path(s, "M1 1 L0 1 L0 0 L1 0 M0 .5 L.94 .5")


def _rieul(s, b, w, var):
    b.path(s, "M0 1 L1 1 L1 .5 L0 .5 L0 0 L1 0")


def _mieum(s, b, w, var):
    b.path(s, "M0 0 L0 1 L1 1 L1 0 Z")


def _bieup(s, b, w, var):
    b.path(s, "M0 1 L0 0 L1 0 L1 1 M0 .52 L1 .52")


def _pieup(s, b, w, var):
    b.path(s, "M0 1 L1 1 M0 0 L1 0 M.27 1 L.27 0 M.73 1 L.73 0")


def _siot(s, b, w, var):
    # 꼭짓점에서 왼쪽으로 휘어 내리는 획 + 그 중간에서 갈라지는 오른쪽 획
    b.path(s, "M.5 1 Q.42 .38 0 0 M.39 .563 L1 0")


def _jieut(s, b, w, var):
    b.path(s, "M.02 1 L.98 1")
    _siot(s, b, w, var)


def _top_tick(s, b, w):
    """ㅊ·ㅎ의 꼭지. 가로줄의 y 좌표를 돌려준다."""
    t = _clamp(0.13 * b.h, 0.25 * w, 0.9 * w)
    bar_y = b.y1 - t
    s.poly((b.cx, b.y1), (b.cx, bar_y))
    return bar_y


def _chieut(s, b, w, var):
    bar_y = _top_tick(s, b, w)
    s.poly((b.x0 + 0.02 * b.w, bar_y), (b.x1 - 0.02 * b.w, bar_y))
    _siot(s, Box(b.x0, b.y0, b.x1, bar_y), w, var)


def _ieung(s, b, w, var):
    rx, ry = b.w / 2, b.h / 2
    rx = min(rx, ry * 1.28)
    ry = min(ry, rx * 1.08)
    s.ellipse(b.cx, b.cy, rx, ry)


def _hieut(s, b, w, var):
    bar_y = _top_tick(s, b, w)
    s.poly((b.x0 + 0.06 * b.w, bar_y), (b.x1 - 0.06 * b.w, bar_y))
    top = bar_y - (w + max(0.05 * b.h, 0.28 * w))
    ry = (top - b.y0) / 2
    rx = min(b.w * 0.38, ry * 1.4)
    ry = min(ry, rx * 1.08)
    s.ellipse(b.cx, (top + b.y0) / 2, rx, ry)


DRAW = {
    "ㄱ": _giyeok, "ㄴ": _nieun, "ㄷ": _digeut, "ㄹ": _rieul, "ㅁ": _mieum,
    "ㅂ": _bieup, "ㅅ": _siot, "ㅇ": _ieung, "ㅈ": _jieut, "ㅊ": _chieut,
    "ㅋ": _kieuk, "ㅌ": _tieut, "ㅍ": _pieup, "ㅎ": _hieut,
}

# 홑자음이 칸을 다 채우면 어색한 것들의 크기 보정 (가로, 세로)
SCALE_L = {  # 세로 모음 왼쪽 (가, 마, 하 …)
    "ㄴ": (1, .9), "ㄷ": (1, .86), "ㄹ": (1, .9), "ㅁ": (.92, .74),
    "ㅂ": (.92, .84), "ㅇ": (.95, .92), "ㅌ": (1, .88), "ㅍ": (1, .78),
    "ㅎ": (1, .94),
}
SCALE_T = {  # 가로 모음 위 (고, 모, 호 …)
    "ㄴ": (.86, 1), "ㄷ": (.86, 1), "ㄹ": (.86, 1), "ㅁ": (.7, 1),
    "ㅂ": (.7, 1), "ㅅ": (.86, 1), "ㅈ": (.86, 1), "ㅊ": (.86, 1),
    "ㅌ": (.86, 1), "ㅍ": (.84, 1), "ㅎ": (.8, 1), "ㅋ": (.92, 1), "ㄱ": (.92, 1),
}
SCALE_F = {  # 받침
    "ㄱ": (.86, 1), "ㄴ": (.86, 1), "ㄷ": (.8, 1), "ㄹ": (.78, 1),
    "ㅁ": (.64, 1), "ㅂ": (.64, 1), "ㅅ": (.72, 1), "ㅈ": (.74, 1),
    "ㅊ": (.74, 1), "ㅋ": (.8, 1), "ㅌ": (.78, 1), "ㅍ": (.74, 1),
    "ㅎ": (.8, 1),
}
SCALES = {"L": SCALE_L, "T": SCALE_T, "F": SCALE_F, "J": {}}


# 획이 뭉치지 않으려면 칸(중심선 기준)이 획 굵기의 몇 배는 되어야 하는지 (가로, 세로).
# 획 사이 흰 공간을 최소 0.4w 로 잡은 값이다.
ROOM = {
    "ㄱ": (1, 1), "ㄴ": (1, 1), "ㄷ": (1, 1.4), "ㄹ": (1.4, 2.8), "ㅁ": (1.4, 1.4),
    "ㅂ": (1.4, 2.7), "ㅅ": (1.3, 1), "ㅇ": (1.5, 1.5), "ㅈ": (1.3, 1.5), "ㅊ": (1.3, 2.0),
    "ㅋ": (1, 2.8), "ㅌ": (1, 2.8), "ㅍ": (3.0, 1.4), "ㅎ": (1.9, 3.0),
}


def plan_consonant(c, b, w, var="T", scale=True):
    """자음을 실제로 그릴 [(홑자음, 상자, 변형)] 목록으로 펼친다."""
    if c in PAIRS:
        a, z = PAIRS[c]
        b1, b2 = b.split(gap=w * 1.5)
        # 쌍자음의 앞 글자는 다리를 쓸어내리지 않는다 (ㄲ = ㄱ + 쓸어내린 ㄱ)
        return plan_consonant(a, b1, w, "T" if var == "L" else var, False) + plan_consonant(z, b2, w, var, False)
    if scale and c in SCALES[var]:
        b = b.scaled(*SCALES[var][c])
    return [(c, b, var)]


def room_weight(parts, ky=1.0):
    """이 칸들에서 속공간이 막히지 않는 최대 (세로획 기준) 획 굵기."""
    return min(min(b.w / ROOM[c][0], b.h / (ROOM[c][1] * ky)) for c, b, _ in parts)


def consonant(s, c, b, w, var="T"):
    for cc, bb, vv in plan_consonant(c, b, w, var):
        DRAW[cc](s, bb, w, vv)


# ---------------------------------------------------------------------------
# 모음 사양
# ---------------------------------------------------------------------------

VKIND = {}
for _v in "ㅏㅐㅑㅒㅓㅔㅕㅖㅣ":
    VKIND[_v] = "V"
for _v in "ㅗㅛㅜㅠㅡ":
    VKIND[_v] = "H"
for _v in "ㅘㅙㅚㅝㅞㅟㅢ":
    VKIND[_v] = "C"

# 세로 모음: (기둥 x들, 곁줄기 (x_from, x_to) 또는 None, 곁줄기 개수, 초성 칸 오른쪽 끝)
VSPEC = {
    "ㅏ": ([0.72], (0.72, 0.98), 1, 0.54),
    "ㅐ": ([0.66, 0.96], (0.66, 0.96), 1, 0.47),
    "ㅑ": ([0.72], (0.72, 0.98), 2, 0.54),
    "ㅒ": ([0.66, 0.96], (0.66, 0.96), 2, 0.47),
    "ㅓ": ([0.95], (0.70, 0.95), 1, 0.51),
    "ㅔ": ([0.76, 0.97], (0.58, 0.76), 1, 0.40),
    "ㅕ": ([0.95], (0.70, 0.95), 2, 0.51),
    "ㅖ": ([0.76, 0.97], (0.58, 0.76), 2, 0.40),
    "ㅣ": ([0.80], None, 0, 0.62),
}
# 쌍자음 초성(깨, 께 …)은 자리가 더 필요하므로 겹세로 모음을 오른쪽으로 좁힌다
VSPEC_PAIR = {
    "ㅐ": ([0.71, 0.965], (0.71, 0.965), 1, 0.53),
    "ㅒ": ([0.71, 0.965], (0.71, 0.965), 2, 0.53),
    "ㅔ": ([0.80, 0.975], (0.65, 0.80), 1, 0.48),
    "ㅖ": ([0.80, 0.975], (0.65, 0.80), 2, 0.48),
}

# 가로 모음: (곁줄기 x들, 방향 +1 위 / -1 아래 / 0 없음)
HSPEC = {
    "ㅗ": ([0.5], +1), "ㅛ": ([0.34, 0.66], +1),
    "ㅜ": ([0.5], -1), "ㅠ": ([0.34, 0.66], -1),
    "ㅡ": ([], 0),
}

# 섞임 모음: (가로 부분, 기둥 x들, 세로 곁줄기 (x_from, x_to) 또는 None, 가로줄 끝 x)
CSPEC = {
    "ㅘ": ("ㅗ", [0.78], (0.78, 0.99), 0.62),
    "ㅙ": ("ㅗ", [0.70, 0.97], (0.70, 0.97), 0.54),
    "ㅚ": ("ㅗ", [0.86], None, 0.70),
    "ㅝ": ("ㅜ", [0.96], (0.73, 0.96), 0.64),
    "ㅞ": ("ㅜ", [0.78, 0.98], (0.60, 0.78), 0.50),
    "ㅟ": ("ㅜ", [0.86], None, 0.70),
    "ㅢ": ("ㅡ", [0.86], None, 0.70),
}

# 가로 모음 틀:  방향 → (가로줄 y, 곁줄기 끝 y, 초성 칸 y0, y1)
H_NOFINAL = {+1: (0.11, 0.35, 0.51, 0.97), -1: (0.52, 0.0, 0.70, 0.98), 0: (0.36, None, 0.56, 0.97)}
H_FINAL = {+1: (0.47, 0.575, 0.725, 1.0), -1: (0.605, 0.47, 0.755, 1.0), 0: (0.48, None, 0.645, 1.0)}
# 섞임 모음 틀: 방향 → (가로줄 y, 곁줄기 끝 y, 초성 칸 y0, y1, 세로 곁줄기 y, 기둥 y0)
C_NOFINAL = {+1: (0.13, 0.34, 0.50, 0.96, 0.56, 0.0), -1: (0.55, 0.03, 0.72, 0.98, 0.31, 0.0),
             0: (0.36, None, 0.55, 0.97, None, 0.0)}
C_FINAL = {+1: (0.46, 0.56, 0.71, 1.0, 0.73, 0.46), -1: (0.60, 0.46, 0.755, 1.0, 0.50, 0.46),
           0: (0.47, None, 0.64, 1.0, None, 0.46)}


class Hangul:
    def __init__(self, w, frame, ky=1.0):
        self.w = w
        self.ky = ky  # 가로획 두께 비율
        self.F = Box(*frame)

    # 틀 비율 → 절대 좌표
    def X(self, u):
        return self.F.x0 + u * self.F.w

    def Y(self, v):
        return self.F.y0 + v * self.F.h

    def box(self, u0, v0, u1, v1):
        return self.F.sub(u0, v0, u1, v1)

    def line(self, s, u0, v0, u1, v1):
        s.poly((self.X(u0), self.Y(v0)), (self.X(u1), self.Y(v1)))

    # --- 모음 부품 ---------------------------------------------------------
    def _vert(self, s, stems, tick, count, sy0, sy1, tick_y, spread):
        for x in stems:
            self.line(s, x, sy0, x, sy1)
        if tick and count:
            ys = [tick_y] if count == 1 else [tick_y + spread, tick_y - spread]
            for y in ys:
                self.line(s, tick[0], y, tick[1], y)

    def _horiz(self, s, ticks, direction, bar_y, tick_to, x0, x1):
        self.line(s, x0, bar_y, x1, bar_y)
        if direction:
            for t in ticks:
                tx = x0 + t * (x1 - x0)
                self.line(s, tx, bar_y, tx, tick_to)

    # --- 음절 --------------------------------------------------------------
    def weight_factor(self, cho, jung, jong):
        kind = VKIND[jung]
        f = {"V": 1.0, "H": 1.0, "C": 0.97}[kind]
        if jong:
            f -= {"V": 0.05, "H": 0.07, "C": 0.09}[kind]
            if jong in PAIRS:
                f -= 0.03
        if cho in PAIRS:
            f -= 0.02
        return f

    def syllable(self, cho, jung, jong):
        """초성·중성·종성 문자로 (Shape, 획 굵기)를 만든다."""
        s = Shape()
        kind = VKIND[jung]
        if kind == "V":
            stems, tick, count, iright = (VSPEC_PAIR if cho in PAIRS else VSPEC).get(jung, VSPEC[jung])
            if jong:
                iy0, iy1, sy0, spread, fb = 0.56, 0.97, 0.49, 0.085, (0.07, 0.0, 0.93, 0.35)
            else:
                iy0, iy1, sy0, spread, fb = 0.13, 0.93, 0.0, 0.11, None
            vowel = lambda: self._vert(s, stems, tick, count, sy0, 1.0, (iy0 + iy1) / 2, spread)
            ibox, ivar = self.box(0.0, iy0, iright, iy1), "L"
        elif kind == "H":
            ticks, d = HSPEC[jung]
            bar, tick_to, iy0, iy1 = (H_FINAL if jong else H_NOFINAL)[d]
            fb = (0.10, 0.0, 0.90, 0.33) if jong else None
            vowel = lambda: self._horiz(s, ticks, d, bar, tick_to, 0.0, 1.0)
            ibox, ivar = self.box(0.13, iy0, 0.87, iy1), "T"
        else:
            hv, stems, vtick, bar_end = CSPEC[jung]
            ticks, d = HSPEC[hv]
            bar, tick_to, iy0, iy1, vty, sy0 = (C_FINAL if jong else C_NOFINAL)[d]
            fb = (0.08, 0.0, 0.92, 0.32) if jong else None

            def vowel():
                self._horiz(s, ticks, d, bar, tick_to, 0.0, bar_end)
                self._vert(s, stems, vtick, 1 if vtick else 0, sy0, 1.0, vty, 0)

            ibox, ivar = self.box(0.02, iy0, bar_end - 0.05, iy1), "T"

        cons = [(cho, ibox, ivar)] + ([(jong, self.box(*fb), "F")] if jong else [])
        w = self.fit_weight(self.w * self.weight_factor(cho, jung, jong), cons)
        vowel()
        for c, b, var in cons:
            consonant(s, c, b, w, var)
        return s, w

    def fit_weight(self, w_nom, cons):
        """칸이 좁아 속공간이 막힐 것 같으면 획을 가늘게 (명목 굵기의 78%까지)."""
        w = w_nom
        for _ in range(5):  # 쌍자음 간격이 굵기에 따라 바뀌므로 몇 번 되풀이
            parts = [p for c, b, v in cons for p in plan_consonant(c, b, w, v)]
            w = min(w_nom, room_weight(parts, self.ky))
        return max(w, w_nom * 0.78)

    # --- 호환용 낱자 ---------------------------------------------------------
    def jamo(self, ch):
        """낱자(ㄱ, ㅏ …) 하나를 가운데에 놓은 (Shape, 굵기)."""
        w = self.w
        s = Shape()
        if ch in COMPAT_CONSONANTS:
            b = self.box(0.06, 0.14, 0.94, 0.84) if ch in PAIRS else self.box(0.22, 0.14, 0.78, 0.84)
            consonant(s, ch, b, w, "J")
            return s, w
        kind = VKIND[ch]
        if kind == "V":
            stems, tick, count, _ = VSPEC[ch]
            self._vert(s, stems, tick, count, 0.0, 1.0, 0.53, 0.11)
        elif kind == "H":
            ticks, d = HSPEC[ch]
            bar = {+1: 0.28, -1: 0.64, 0: 0.46}[d]
            self._horiz(s, ticks, d, bar, {+1: 0.6, -1: 0.2, 0: None}[d], 0.06, 0.94)
        else:
            hv, stems, vtick, bar_end = CSPEC[ch]
            ticks, d = HSPEC[hv]
            bar, tick_to, _, _, vty, sy0 = C_NOFINAL[d]
            self._horiz(s, ticks, d, bar, tick_to, 0.0, bar_end)
            self._vert(s, stems, vtick, 1 if vtick else 0, sy0, 1.0, vty, 0)
        # 가로 가운데 정렬 (모음은 직선뿐이라 점 좌표로 범위 계산이 정확하다)
        xs = [p[0] for sp in s.subpaths for op in sp for p in op[1:]]
        dx = self.F.cx - (min(xs) + max(xs)) / 2
        return s.translated(dx, 0), w
