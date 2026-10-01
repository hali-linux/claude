#!/usr/bin/env bash
# Rocky Linux 9 컨테이너에서 RPM / 설치 스크립트 설치를 검증한다. (make e2e-rocky9)
#   - RPM 설치 → 설정/사용자/권한 확인 → 서버 기동 → 부하 테스트 → 업그레이드 → 제거
#   - 압축 파일 install.sh 설치 → 재실행(업그레이드) → uninstall.sh --purge
# 컨테이너에는 systemd 가 없으므로 서비스는 runuser 로 직접 실행한다.
set -euo pipefail

VERSION="${VERSION:?VERSION 필요}"
GOARCH="${GOARCH:-amd64}"
IMAGE="${IMAGE:-rockylinux/rockylinux:9}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${ROOT}/dist"
case "$GOARCH" in amd64) RPMARCH=x86_64 ;; arm64) RPMARCH=aarch64 ;; esac
RPM="trafficgate-${VERSION}-1.el9.${RPMARCH}.rpm"
TARBALL="trafficgate-${VERSION}-linux-${GOARCH}.tar.gz"
[[ -f "${DIST}/${RPM}" && -f "${DIST}/${TARBALL}" ]] || { echo "먼저 make rpm 을 실행하세요" >&2; exit 1; }

# 업그레이드 검증용 Release 2 RPM
if [[ ! -f "${DIST}/trafficgate-${VERSION}-2.el9.${RPMARCH}.rpm" ]]; then
  VERSION="$VERSION" RELEASE=2 GOARCH="$GOARCH" "${ROOT}/scripts/build-rpm.sh" >/dev/null 2>&1
fi

echo "### 1. RPM 설치/업그레이드/제거 (${IMAGE})"
docker run --rm -i -v "${DIST}:/dist:ro" "$IMAGE" bash -s -- "$RPM" "trafficgate-${VERSION}-2.el9.${RPMARCH}.rpm" <<'EOS'
set -euo pipefail
RPM1="/dist/$1"; RPM2="/dist/$2"
pass() { echo "  [OK] $*"; }
fail() { echo "  [FAIL] $*"; exit 1; }
cat /etc/rocky-release

rpm -ivh "$RPM1" | tail -n 12
rpm -q trafficgate >/dev/null && pass "rpm 설치"
getent passwd trafficgate | grep -q /sbin/nologin && pass "시스템 사용자 trafficgate (nologin)"
[[ "$(stat -c '%a %U:%G' /etc/trafficgate/config.yaml)" == "640 root:trafficgate" ]] && pass "config.yaml 0640 root:trafficgate" || fail "config 권한 $(stat -c '%a %U:%G' /etc/trafficgate/config.yaml)"
[[ "$(stat -c '%a %U' /etc/trafficgate/initial-admin-password)" == "600 root" ]] && pass "초기 비밀번호 파일 0600" || fail "pw 권한"
[[ "$(stat -c '%a %U:%G' /var/lib/trafficgate)" == "750 trafficgate:trafficgate" ]] && pass "데이터 디렉터리 0750" || fail "data dir"
test -f /usr/lib/systemd/system/trafficgate.service && pass "systemd 유닛"
test -f /usr/lib/firewalld/services/trafficgate.xml && pass "firewalld 서비스 정의"
test -f /usr/share/doc/trafficgate/nginx/trafficgate-gate.conf && pass "문서/nginx 예시"
runuser -u trafficgate -- trafficgate check-config -config /etc/trafficgate/config.yaml >/dev/null && pass "trafficgate 사용자로 설정 읽기"
SECRET1=$(grep token_secret: /etc/trafficgate/config.yaml)

# 부하 테스트를 위해 IP 요청 제한 끄기 (모든 요청이 127.0.0.1)
sed -i 's/^  enabled: true/  enabled: false/' /etc/trafficgate/config.yaml
runuser -u trafficgate -- trafficgate serve -config /etc/trafficgate/config.yaml >/tmp/tg.log 2>&1 &
for i in $(seq 1 50); do curl -sf http://127.0.0.1:8800/readyz >/dev/null && break; sleep 0.2; done
curl -sf http://127.0.0.1:8800/readyz >/dev/null && pass "서버 기동 (/readyz)"
curl -sf http://127.0.0.1:8800/trafficgate.js | grep -q TrafficGate && pass "JS 에이전트 제공"
PW=$(sed -n 's/^비밀번호: //p' /etc/trafficgate/initial-admin-password)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8801/api/login -d "{\"username\":\"admin\",\"password\":\"$PW\"}")
[[ "$code" == 200 ]] && pass "초기 계정으로 관리 콘솔 로그인" || fail "login $code"
trafficgate bench -url http://127.0.0.1:8800 -segment default -users 400 -rate 200 -hold 1s > /tmp/bench.txt
grep -q "통과 400, 완료 400, 차단/종료 0, 오류 0" /tmp/bench.txt && pass "부하 테스트 400명 통과/완료" || { cat /tmp/bench.txt; fail bench; }
grep "동시 입장 최대" /tmp/bench.txt
kill %1; wait %1 2>/dev/null || true
test -f /var/lib/trafficgate/segments.json && pass "세그먼트 영속화"
grep -q "저장소 종료 완료" /tmp/tg.log && pass "정상 종료(SIGTERM) 시 상태 저장"

rpm -Uvh "$RPM2" | tail -n 2
[[ "$(rpm -q trafficgate)" == *-2.el9.* ]] && pass "업그레이드(Release 2)"
[[ "$(grep token_secret: /etc/trafficgate/config.yaml)" == "$SECRET1" ]] && pass "업그레이드 후 설정 유지"
grep -q "enabled: false" /etc/trafficgate/config.yaml && pass "사용자 변경 사항 유지"

rpm -e trafficgate
! test -e /usr/bin/trafficgate && pass "rpm 제거"
ls /etc/trafficgate/ 2>/dev/null | sed 's/^/    남은 파일: /' || true
EOS

echo
echo "### 2. 압축 파일 + install.sh 설치/업그레이드/제거 (${IMAGE})"
docker run --rm -i -v "${DIST}:/dist:ro" "$IMAGE" bash -s -- "$TARBALL" <<'EOS'
set -euo pipefail
pass() { echo "  [OK] $*"; }
fail() { echo "  [FAIL] $*"; exit 1; }
cd /tmp && tar xzf "/dist/$1" && cd "${1%.tar.gz}"
./install.sh --admin-password 'Rocky9-Admin-Pass' 2>&1 | sed 's/^/    /'
test -x /usr/bin/trafficgate && pass "바이너리 설치"
test -f /etc/systemd/system/trafficgate.service && pass "systemd 유닛"
[[ "$(stat -c '%a %U:%G' /etc/trafficgate/config.yaml)" == "640 root:trafficgate" ]] && pass "설정 권한"
runuser -u trafficgate -- trafficgate serve -config /etc/trafficgate/config.yaml >/tmp/tg.log 2>&1 &
for i in $(seq 1 50); do curl -sf http://127.0.0.1:8800/readyz >/dev/null && break; sleep 0.2; done
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8801/api/login -d '{"username":"admin","password":"Rocky9-Admin-Pass"}')
[[ "$code" == 200 ]] && pass "지정한 관리자 비밀번호로 로그인" || fail "login $code"
r=$(curl -s -X POST http://127.0.0.1:8800/api/v1/segments/default/enter)
[[ "$r" == *'"status":"PASS"'* ]] && pass "대기열 진입 PASS"
kill %1; wait %1 2>/dev/null || true
SECRET=$(grep token_secret: /etc/trafficgate/config.yaml)
./install.sh 2>&1 | grep -E "기존|유지" | sed 's/^/    /'
test -x /usr/bin/trafficgate.prev && pass "업그레이드 시 이전 바이너리 보관"
[[ "$(grep token_secret: /etc/trafficgate/config.yaml)" == "$SECRET" ]] && pass "업그레이드 후 설정 유지"
./uninstall.sh --purge
! test -e /usr/bin/trafficgate && ! test -e /etc/trafficgate && ! getent passwd trafficgate >/dev/null && pass "uninstall --purge"
EOS
echo
echo "Rocky Linux 9 설치 검증 완료"
