"""모노라인(단일 굵기) 획 기하 도구.

글자는 '획의 중심선'으로만 정의하고, 마지막에 일정한 굵기로 둥글게 외곽선을
만든 뒤(skia-pathops) 겹친 부분을 합쳐 TrueType 윤곽으로 바꾼다.
"""

import math
import re

import pathops

KAPPA = 0.5522847498307936  # 원을 3차 베지어 4개로 근사할 때의 상수


class Shape:
    """중심선 획(subpath)과 채워진 점(dot)을 모아 두는 그릇. 좌표는 절대 단위."""

    def __init__(self):
        self.subpaths = []  # [('M', p), ('L', p), ('Q', c, p), ('C', c1, c2, p), ('Z',)]
        self.dots = []  # (cx, cy, r)

    # --- 기본 명령 -------------------------------------------------------
    def M(self, x, y):
        self.subpaths.append([("M", (x, y))])
        return self

    def L(self, x, y):
        self.subpaths[-1].append(("L", (x, y)))
        return self

    def Q(self, cx, cy, x, y):
        self.subpaths[-1].append(("Q", (cx, cy), (x, y)))
        return self

    def C(self, c1x, c1y, c2x, c2y, x, y):
        self.subpaths[-1].append(("C", (c1x, c1y), (c2x, c2y), (x, y)))
        return self

    def Z(self):
        self.subpaths[-1].append(("Z",))
        return self

    # --- 편의 명령 -------------------------------------------------------
    def poly(self, *pts, closed=False):
        self.M(*pts[0])
        for p in pts[1:]:
            self.L(*p)
        if closed:
            self.Z()
        return self

    def ellipse(self, cx, cy, rx, ry):
        kx, ky = rx * KAPPA, ry * KAPPA
        self.M(cx + rx, cy)
        self.C(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry)
        self.C(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy)
        self.C(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry)
        self.C(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy)
        self.Z()
        return self

    def arc(self, cx, cy, rx, ry, a0, a1, move=True):
        """(cx, cy) 중심 타원호를 a0°에서 a1°까지(반시계 +) 그린다."""
        sweep = a1 - a0
        n = max(1, int(math.ceil(abs(sweep) / 90.0 - 1e-9)))
        d = math.radians(sweep / n)
        k = 4.0 / 3.0 * math.tan(d / 4.0)
        t = math.radians(a0)
        px, py = cx + rx * math.cos(t), cy + ry * math.sin(t)
        if move or not self.subpaths:
            self.M(px, py)
        else:
            self.L(px, py)
        for _ in range(n):
            t2 = t + d
            qx, qy = cx + rx * math.cos(t2), cy + ry * math.sin(t2)
            c1 = (px - k * rx * math.sin(t), py + k * ry * math.cos(t))
            c2 = (qx + k * rx * math.sin(t2), qy - k * ry * math.cos(t2))
            self.C(c1[0], c1[1], c2[0], c2[1], qx, qy)
            t, px, py = t2, qx, qy
        return self

    def dot(self, cx, cy, r):
        self.dots.append((cx, cy, r))
        return self

    def extend(self, other):
        self.subpaths.extend(other.subpaths)
        self.dots.extend(other.dots)
        return self

    def transformed(self, fn):
        """모든 좌표에 fn(x, y) -> (x, y)를 적용한 새 Shape."""
        out = Shape()
        for sp in self.subpaths:
            out.subpaths.append(
                [(op[0],) + tuple(fn(*p) for p in op[1:]) for op in sp]
            )
        for cx, cy, r in self.dots:
            x, y = fn(cx, cy)
            out.dots.append((x, y, r))
        return out

    def translated(self, dx, dy):
        return self.transformed(lambda x, y: (x + dx, y + dy))


class Box:
    """단위 좌표(0..1)를 절대 좌표 상자에 대응시킨다. y는 위쪽이 +."""

    def __init__(self, x0, y0, x1, y1):
        self.x0, self.y0, self.x1, self.y1 = x0, y0, x1, y1

    @property
    def w(self):
        return self.x1 - self.x0

    @property
    def h(self):
        return self.y1 - self.y0

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2

    @property
    def cy(self):
        return (self.y0 + self.y1) / 2

    def p(self, u, v):
        return (self.x0 + u * self.w, self.y0 + v * self.h)

    def sub(self, u0, v0, u1, v1):
        """단위 좌표로 지정한 부분 상자."""
        a, b = self.p(u0, v0), self.p(u1, v1)
        return Box(a[0], a[1], b[0], b[1])

    def scaled(self, sx=1.0, sy=1.0, ax=0.5, ay=0.5):
        """(ax, ay) 기준점을 고정하고 가로 sx, 세로 sy배로 줄이거나 늘린다."""
        px, py = self.p(ax, ay)
        return Box(
            px - (px - self.x0) * sx,
            py - (py - self.y0) * sy,
            px + (self.x1 - px) * sx,
            py + (self.y1 - py) * sy,
        )

    def split(self, gap, ratio=0.5):
        """가로로 두 칸(쌍자음·겹받침용). gap은 절대 단위의 중심선 간격."""
        avail = self.w - gap
        mid = self.x0 + avail * ratio
        return Box(self.x0, self.y0, mid, self.y1), Box(mid + gap, self.y0, self.x1, self.y1)

    _TOKEN = re.compile(r"[MLQCZO]|-?\d*\.?\d+(?:e-?\d+)?")
    _ARGS = {"M": 2, "L": 2, "Q": 4, "C": 6, "Z": 0, "O": 4}

    def path(self, shape, d):
        """SVG 비슷한 짧은 경로 문자열(단위 좌표)을 shape에 추가한다.

        M/L/Q/C/Z 외에 'O cx cy rx ry'(타원)를 지원한다.
        """
        toks = self._TOKEN.findall(d)
        i = 0
        while i < len(toks):
            cmd = toks[i]
            n = self._ARGS[cmd]
            a = [float(t) for t in toks[i + 1 : i + 1 + n]]
            i += 1 + n
            if cmd == "Z":
                shape.Z()
            elif cmd == "O":
                cx, cy = self.p(a[0], a[1])
                shape.ellipse(cx, cy, a[2] * self.w, a[3] * self.h)
            else:
                pts = [c for j in range(0, n, 2) for c in self.p(a[j], a[j + 1])]
                getattr(shape, cmd)(*pts)
        return shape


def _skia_path(shape):
    p = pathops.Path()
    for sp in shape.subpaths:
        for op in sp:
            k = op[0]
            if k == "M":
                p.moveTo(*op[1])
            elif k == "L":
                p.lineTo(*op[1])
            elif k == "Q":
                p.quadTo(*op[1], *op[2])
            elif k == "C":
                p.cubicTo(*op[1], *op[2], *op[3])
            elif k == "Z":
                p.close()
    return p


def outline(shape, width, ky=1.0):
    """중심선 Shape를 굵기 width로 둥글게 칠한 하나의 합쳐진 윤곽으로 만든다.

    ky < 1 이면 가로획이 세로획보다 ky배 얇아지는 납작한 타원 펜으로 그린다
    (같은 두께면 가로획이 더 굵어 보이는 착시를 보정하고, 촘촘한 글자에 숨통을 준다).
    """
    src = shape if ky == 1.0 else shape.transformed(lambda x, y: (x, y / ky))
    p = _skia_path(src)
    p.stroke(width, pathops.LineCap.ROUND_CAP, pathops.LineJoin.ROUND_JOIN, 4)
    p.convertConicsToQuads()
    if ky != 1.0:
        p = p.transform(scaleY=ky)
    result = pathops.simplify(p, clockwise=True)
    if shape.dots:
        dots = Shape()
        for cx, cy, r in shape.dots:
            dots.ellipse(cx, cy, r, r)
        d = pathops.simplify(_skia_path(dots), clockwise=True)
        result = pathops.op(result, d, pathops.PathOp.UNION, clockwise=True)
    return result
