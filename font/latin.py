"""라틴 문자·숫자·문장부호. 한글과 같은 둥근 모노라인 방식.

좌표는 중심선 기준 절대 단위(UPM 1000). 글자 폭은 윤곽의 실제 범위에서
자동으로 계산하므로 x 원점은 신경 쓰지 않아도 된다.
"""

from geom import Box, Shape


def build_latin(w, ky=1.0):
    """{문자: (Shape, 고정 폭 또는 None, 간격용 x 범위 또는 None)} 을 돌려준다.

    ky: 가로획 두께 비율(geom.outline 참고). 기준선·높이 맞춤에 쓴다.
    """
    h = w / 2 * ky
    B, X, CAP, ASC, DSC = h, 500 - h, 700 - h, 740 - h, -200 + h
    xm, cm = (B + X) / 2, (B + CAP) / 2
    ry = (X - B) / 2  # 소문자 둥근 몸통의 세로 반지름
    rx = ry * 1.0
    dot_r = w * 0.62
    G = {}

    def put(ch, s, adv=None, extent=None):
        # extent: 간격 계산에 쓸 중심선 x 범위 (꼬리가 옆 글자 밑으로 들어가는 j 등)
        G[ch] = (s, adv, extent)

    def box(x0, x1, y0, y1):
        return Box(x0, y0, x1, y1)

    def path(d, b, s=None):
        s = s or Shape()
        return b.path(s, d)

    # ---- 소문자 -------------------------------------------------------------
    s = Shape().ellipse(rx, xm, rx, ry).poly((2 * rx, X), (2 * rx, B))
    put("a", s)
    s = Shape().ellipse(rx, xm, rx, ry).poly((0, ASC), (0, B))
    put("b", s)
    put("c", Shape().arc(rx, xm, rx, ry, 42, 318))
    s = Shape().ellipse(rx, xm, rx, ry).poly((2 * rx, ASC), (2 * rx, B))
    put("d", s)
    s = Shape().poly((0, xm), (2 * rx, xm)).arc(rx, xm, rx, ry, 0, 318, move=False)
    put("e", s)
    fr = 118
    s = Shape().M(90, B).L(90, ASC - fr).arc(90 + fr, ASC - fr, fr, fr, 180, 55, move=False)
    s.poly((-10, X), (220, X))
    put("f", s)
    gr = 150
    s = Shape().ellipse(rx, xm, rx, ry).M(2 * rx, X).L(2 * rx, DSC + gr)
    s.arc(2 * rx - gr * 1.05, DSC + gr, gr * 1.05, gr, 0, -152, move=False)
    put("g", s)
    na = 190  # n, h, m 어깨 반지름

    def arch(s, x0, x1, top):
        r = (x1 - x0) / 2
        yc = top - r
        s.M(x0, yc).arc((x0 + x1) / 2, yc, r, r, 180, 0, move=False).L(x1, B)
        return s

    s = arch(Shape().poly((0, ASC), (0, B)), 0, 2 * na, X)
    put("h", s)
    put("i", Shape().poly((0, X), (0, B)).dot(0, 648, dot_r))
    jr = 135
    s = Shape().M(jr, X).L(jr, DSC + jr).arc(0, DSC + jr, jr, jr, 0, -150, move=False)
    s.dot(jr, 648, dot_r)
    put("j", s, extent=(jr - 50, jr))
    s = Shape().poly((0, ASC), (0, B)).poly((320, X), (0, 160)).poly((112, 266), (330, B))
    put("k", s)
    put("l", Shape().poly((0, ASC), (0, B)))
    ma = 150
    s = arch(Shape().poly((0, X), (0, B)), 0, 2 * ma, X)
    arch(s, 2 * ma, 4 * ma, X)
    put("m", s)
    put("n", arch(Shape().poly((0, X), (0, B)), 0, 2 * na, X))
    put("o", Shape().ellipse(rx * 1.04, xm, rx * 1.04, ry))
    s = Shape().ellipse(rx, xm, rx, ry).poly((0, X), (0, DSC))
    put("p", s)
    s = Shape().ellipse(rx, xm, rx, ry).poly((2 * rx, X), (2 * rx, DSC))
    put("q", s)
    s = Shape().poly((0, X), (0, B)).M(0, 250).C(0, 390, 90, X, 235, X)
    put("r", s)
    S_PATH = ("M.93 .83 C.85 .95 .68 1 .5 1 C.25 1 .05 .9 .05 .75 C.05 .58 .25 .54 .5 .5 "
              "C.75 .46 .95 .42 .95 .25 C.95 .08 .75 0 .5 0 C.28 0 .12 .06 .05 .17")
    put("s", path(S_PATH, box(0, 330, B, X)))
    tr = 105
    s = Shape().M(90, 650).L(90, B + tr).arc(90 + tr, B + tr, tr, tr, 180, 270, move=False)
    s.L(90 + tr + 50, B).poly((0, X), (250, X))
    put("t", s)
    s = Shape().M(0, X).L(0, B + na).arc(na, B + na, na, na, 180, 360, move=False)
    s.poly((2 * na, X), (2 * na, B))
    put("u", s)
    put("v", Shape().poly((0, X), (200, B), (400, X)))
    put("w", Shape().poly((0, X), (150, B), (300, X), (450, B), (600, X)))
    put("x", Shape().poly((0, X), (360, B)).poly((0, B), (360, X)))
    put("y", Shape().poly((400, X), (130, DSC)).poly((0, X), (216, B)))
    put("z", Shape().poly((0, X), (350, X), (0, B), (350, B)))

    # ---- 대문자 -------------------------------------------------------------
    put("A", Shape().poly((0, B), (270, CAP), (540, B)).poly((85, 230), (455, 230)))
    s = Shape().M(0, B).L(0, CAP).L(190, CAP)
    tmid = 384
    rt, rb = (CAP - tmid) / 2, (tmid - B) / 2
    s.arc(190, tmid + rt, 150, rt, 90, -90, move=False).L(0, tmid)
    s.M(0, tmid).L(205, tmid).arc(205, B + rb, 175, rb, 90, -90, move=False).L(0, B)
    put("B", s)
    cry = (CAP - B) / 2
    put("C", Shape().arc(300, cm, 300, cry, 45, 315))
    s = Shape().M(0, B).L(0, CAP).L(150, CAP)
    s.arc(150, cm, 270, cry, 90, -90, move=False).L(0, B)
    put("D", s)
    put("E", Shape().poly((350, CAP), (0, CAP), (0, B), (350, B)).poly((0, cm + 8), (310, cm + 8)))
    put("F", Shape().poly((350, CAP), (0, CAP), (0, B)).poly((0, cm), (310, cm)))
    s = Shape().arc(310, cm, 310, cry, 45, 360).L(360, cm)
    put("G", s)
    put("H", Shape().poly((0, B), (0, CAP)).poly((450, B), (450, CAP)).poly((0, cm + 8), (450, cm + 8)))
    put("I", Shape().poly((0, B), (0, CAP)))
    jR = 160
    s = Shape().M(320, CAP).L(320, B + jR).arc(320 - jR, B + jR, jR, jR, 0, -170, move=False)
    put("J", s)
    s = Shape().poly((0, B), (0, CAP)).poly((420, CAP), (0, 240)).poly((150, 377), (440, B))
    put("K", s)
    put("L", Shape().poly((0, CAP), (0, B), (330, B)))
    put("M", Shape().poly((0, B), (0, CAP), (290, 190), (580, CAP), (580, B)))
    put("N", Shape().poly((0, B), (0, CAP), (460, B), (460, CAP)))
    put("O", Shape().ellipse(335, cm, 335, cry))
    pmid = 316
    rp = (CAP - pmid) / 2
    s = Shape().M(0, B).L(0, CAP).L(190, CAP).arc(190, pmid + rp, 180, rp, 90, -90, move=False)
    s.L(0, pmid)
    put("P", s)
    s = Shape().ellipse(335, cm, 335, cry).poly((420, 170), (690, -40))
    put("Q", s)
    s = Shape().M(0, B).L(0, CAP).L(190, CAP).arc(190, pmid + rp, 180, rp, 90, -90, move=False)
    s.L(0, pmid).poly((200, pmid), (420, B))
    put("R", s)
    put("S", path(S_PATH, box(0, 420, B, CAP)))
    put("T", Shape().poly((0, CAP), (460, CAP)).poly((230, CAP), (230, B)))
    uR = 225
    s = Shape().M(0, CAP).L(0, B + uR).arc(uR, B + uR, uR, uR, 180, 360, move=False).L(2 * uR, CAP)
    put("U", s)
    put("V", Shape().poly((0, CAP), (265, B), (530, CAP)))
    put("W", Shape().poly((0, CAP), (190, B), (375, CAP), (560, B), (750, CAP)))
    put("X", Shape().poly((0, CAP), (480, B)).poly((0, B), (480, CAP)))
    put("Y", Shape().poly((0, CAP), (250, 330), (500, CAP)).poly((250, 330), (250, B)))
    put("Z", Shape().poly((0, CAP), (450, CAP), (0, B), (450, B)))

    # ---- 숫자 (고정 폭) -----------------------------------------------------
    nb = box(0, 390, B, CAP)
    DIG = 600
    put("0", path("O.5 .5 .5 .5", nb), DIG)
    put("1", path("M.12 .8 L.55 1 L.55 0", nb), DIG)
    put("2", path("M.04 .78 C.08 .93 .27 1 .5 1 C.76 1 .95 .86 .95 .68 "
                  "C.95 .48 .7 .33 0 0 L1 0", nb), DIG)
    put("3", path("M.06 .84 C.15 .95 .3 1 .48 1 C.75 1 .92 .88 .92 .74 C.92 .6 .75 .53 .45 .53 "
                  "C.8 .53 .98 .42 .98 .26 C.98 .1 .78 0 .5 0 C.3 0 .13 .06 .02 .17", nb), DIG)
    put("4", path("M.74 0 L.74 1 L0 .3 L1 .3", nb), DIG)
    put("5", path("M.92 1 L.14 1 L.08 .56 C.2 .62 .35 .64 .5 .64 C.78 .64 .98 .48 .98 .31 "
                  "C.98 .12 .78 0 .5 0 C.3 0 .13 .06 .02 .17", nb), DIG)
    put("6", path("O.5 .31 .48 .31 M.8 1 C.4 .92 .04 .62 .02 .31", nb), DIG)
    put("7", path("M0 1 L1 1 L.35 0", nb), DIG)
    put("8", path("O.5 .76 .4 .24 O.5 .27 .48 .27", nb), DIG)
    put("9", path("O.5 .69 .48 .31 M.98 .69 C.96 .38 .6 .08 .2 0", nb), DIG)

    # ---- 문장부호 -----------------------------------------------------------
    put(" ", None, 280)
    put(chr(0x00A0), None, 280)  # 줄바꿈 없는 공백
    put(chr(0x3000), None, 960)  # 전각 공백 (한글 폭과 같게)
    put("!", Shape().poly((0, CAP), (0, 230)).dot(0, dot_r, dot_r))
    put('"', Shape().poly((0, CAP), (0, CAP - 170)).poly((150, CAP), (150, CAP - 170)))
    put("'", Shape().poly((0, CAP), (0, CAP - 170)))
    s = Shape().poly((160, 640), (110, 60)).poly((340, 640), (290, 60))
    s.poly((30, 450), (430, 450)).poly((10, 250), (410, 250))
    put("#", s)
    s = path(S_PATH, box(0, 380, 70, 630)).poly((190, 740), (190, -40))
    put("$", s)
    s = Shape().ellipse(100, 545, 100, 120).ellipse(480, 155, 100, 120).poly((500, CAP), (80, B))
    put("%", s)
    s = Shape().M(470, B).L(150, 400).C(90, 470, 90, 560, 120, 610).C(150, 650, 190, CAP, 230, CAP)
    s.C(290, CAP, 330, 620, 330, 565).C(330, 480, 230, 430, 160, 390).C(80, 345, 30, 290, 30, 215)
    s.C(30, 110, 110, B, 215, B).C(310, B, 380, 90, 440, 210)
    put("&", s)
    put("(", Shape().M(170, 760).C(30, 620, 0, 450, 0, 300).C(0, 150, 30, -20, 170, -160))
    put(")", Shape().M(0, 760).C(140, 620, 170, 450, 170, 300).C(170, 150, 140, -20, 0, -160))
    s = Shape().poly((150, 690), (150, 430)).poly((37, 625), (263, 495)).poly((37, 495), (263, 625))
    put("*", s)
    put("+", Shape().poly((0, 300), (400, 300)).poly((200, 100), (200, 500)))
    put(",", Shape().M(60, 80).Q(70, -40, 0, -120))
    put("-", Shape().poly((0, 290), (250, 290)))
    put(".", Shape().dot(0, dot_r, dot_r))
    put("/", Shape().poly((0, -140), (340, 760)))
    put(":", Shape().dot(0, dot_r, dot_r).dot(0, X - dot_r, dot_r))
    put(";", Shape().M(60, 80).Q(70, -40, 0, -120).dot(60, X - dot_r, dot_r))
    put("<", Shape().poly((380, 540), (0, 300), (380, 60)))
    put("=", Shape().poly((0, 390), (400, 390)).poly((0, 210), (400, 210)))
    put(">", Shape().poly((0, 540), (380, 300), (0, 60)))
    s = path("M0 .62 C.04 .88 .25 1 .5 1 C.78 1 .98 .86 .98 .66 C.98 .48 .84 .41 .7 .33 "
             "C.56 .25 .5 .18 .5 0", box(0, 330, 240, CAP))
    put("?", s.dot(165, dot_r, dot_r))
    s = Shape().ellipse(330, 300, 115, 125).M(445, 425).L(445, 230).C(445, 150, 500, 130, 560, 150)
    s.C(640, 180, 680, 240, 680, 310).C(680, 500, 530, 640, 340, 640).C(150, 640, 10, 500, 10, 300)
    s.C(10, 100, 160, -40, 340, -40).C(420, -40, 490, -20, 540, 10)
    put("@", s)
    put("[", Shape().poly((170, 760), (0, 760), (0, -160), (170, -160)))
    put("\\", Shape().poly((0, 760), (340, -140)))
    put("]", Shape().poly((0, 760), (170, 760), (170, -160), (0, -160)))
    put("^", Shape().poly((0, 420), (200, CAP), (400, 420)))
    put("_", Shape().poly((0, -130), (480, -130)))
    put("`", Shape().poly((0, 740), (110, 630)))
    s = Shape().M(190, 760).C(100, 760, 90, 720, 90, 640).L(90, 400).C(90, 330, 70, 300, 0, 300)
    s.C(70, 300, 90, 270, 90, 200).L(90, -40).C(90, -120, 100, -160, 190, -160)
    put("{", s)
    put("}", s.transformed(lambda x, y: (190 - x, y)))
    put("|", Shape().poly((0, 780), (0, -200)))
    put("~", Shape().M(0, 260).C(60, 360, 140, 360, 200, 300).C(260, 240, 340, 240, 400, 340))

    # ---- 자주 쓰는 추가 기호 ------------------------------------------------
    put("·", Shape().dot(0, 300, dot_r))
    put("…", Shape().dot(0, dot_r, dot_r).dot(250, dot_r, dot_r).dot(500, dot_r, dot_r))
    put("‘", Shape().M(10, 500).Q(0, 620, 70, CAP))
    put("’", Shape().M(60, CAP).Q(70, 580, 0, 500))
    put("“", Shape().M(10, 500).Q(0, 620, 70, CAP).M(160, 500).Q(150, 620, 220, CAP))
    put("”", Shape().M(60, CAP).Q(70, 580, 0, 500).M(210, CAP).Q(220, 580, 150, 500))
    put("–", Shape().poly((0, 290), (420, 290)))
    put("—", Shape().poly((0, 290), (840, 290)))
    put("•", Shape().dot(0, 300, w * 1.2))
    put("°", Shape().ellipse(0, 590, 85, 85))
    put("×", Shape().poly((0, 120), (340, 460)).poly((0, 460), (340, 120)))
    s = Shape().poly((0, CAP), (160, B), (320, CAP), (480, B), (640, CAP))
    put("₩", s.poly((-30, 420), (670, 420)).poly((-30, 280), (670, 280)))

    # 원문자 ①~⑳ (전각, 한글과 같은 높이의 원 안에 숫자를 줄여 넣는다)
    for n in range(1, 21):
        r, cy = 430 - w / 2, 370
        s = Shape().ellipse(500, cy, r, r)
        digits = str(n)
        sx, sy = (0.52, 0.52) if n < 10 else (0.4, 0.5)
        dw, gap = 390 * sx, w * 1.5
        x = 500 - (len(digits) * dw + (len(digits) - 1) * gap) / 2
        for dch in digits:
            s.extend(G[dch][0].transformed(lambda px, py, ox=x: (ox + px * sx, cy + (py - cm) * sy)))
            x += dw + gap
        put(chr(0x2460 + n - 1), s, 960)
    return G
