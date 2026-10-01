#!/usr/bin/env bash
# =====================================================================
#  TrafficGate 설치/업그레이드 스크립트 — Rocky Linux 9 (RHEL 9 계열)
#
#  사용법 (배포 압축 파일을 푼 디렉터리에서):
#    sudo ./install.sh                         # 기본 설치 (메모리 저장소, 단일 서버)
#    sudo ./install.sh --open-firewall         # 8800/tcp 방화벽 개방
#    sudo ./install.sh --store redis --install-redis
#    sudo ./install.sh --help
#
#  이미 설치되어 있으면 설정/데이터는 유지하고 바이너리만 교체한 뒤 재시작한다(업그레이드).
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_SRC="${SCRIPT_DIR}/trafficgate"
if [[ -d "${SCRIPT_DIR}/deploy/systemd" ]]; then RES="${SCRIPT_DIR}/deploy"; else RES="${SCRIPT_DIR}"; fi

BIN_DST=/usr/bin/trafficgate
CONF_DIR=/etc/trafficgate
CONF="${CONF_DIR}/config.yaml"
DATA_DIR=/var/lib/trafficgate
UNIT_DST=/etc/systemd/system/trafficgate.service
PW_FILE="${CONF_DIR}/initial-admin-password"

LISTEN="0.0.0.0:8800"
ADMIN_LISTEN="127.0.0.1:8801"
STORE="memory"
REDIS_ADDR="127.0.0.1:6379"
ADMIN_PASSWORD=""
OPEN_FIREWALL=0
OPEN_ADMIN_FIREWALL=0
SELINUX_NGINX=0
TUNE_SYSCTL=0
INSTALL_REDIS=0
START=1
FORCE=0

c_green=$'\e[32m'; c_yellow=$'\e[33m'; c_red=$'\e[31m'; c_bold=$'\e[1m'; c_off=$'\e[0m'
[[ -t 1 ]] || { c_green=""; c_yellow=""; c_red=""; c_bold=""; c_off=""; }
info() { echo "${c_green}==>${c_off} $*"; }
warn() { echo "${c_yellow}경고:${c_off} $*" >&2; }
die()  { echo "${c_red}오류:${c_off} $*" >&2; exit 1; }

usage() {
  cat <<EOF
TrafficGate 설치 스크립트

옵션:
  --listen ADDR          공개 서버 주소 (기본 ${LISTEN})
  --admin-listen ADDR    관리 콘솔 주소 (기본 ${ADMIN_LISTEN}, 로컬 전용)
  --store TYPE           memory | redis (기본 memory)
  --redis-addr ADDR      Redis 주소 (기본 ${REDIS_ADDR}, 여러 개는 쉼표)
  --install-redis        dnf 로 Redis 를 설치하고 활성화 (인터넷/내부 저장소 필요)
  --admin-password PW    관리자 초기 비밀번호 (생략 시 무작위 생성)
  --open-firewall        firewalld 에서 공개 포트(8800/tcp) 개방
  --open-admin-firewall  firewalld 에서 관리 콘솔 포트 개방 (권장하지 않음)
  --selinux-nginx        SELinux: nginx 가 TrafficGate 로 프록시할 수 있게 허용
  --tune-sysctl          대량 접속용 커널 파라미터 적용 (/etc/sysctl.d/90-trafficgate.conf)
  --no-start             서비스를 시작하지 않음
  --force                지원 OS 확인을 건너뜀
  -h, --help             도움말
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --listen) LISTEN="$2"; shift 2 ;;
    --admin-listen) ADMIN_LISTEN="$2"; shift 2 ;;
    --store) STORE="$2"; shift 2 ;;
    --redis-addr) REDIS_ADDR="$2"; shift 2 ;;
    --install-redis) INSTALL_REDIS=1; shift ;;
    --admin-password) ADMIN_PASSWORD="$2"; shift 2 ;;
    --open-firewall) OPEN_FIREWALL=1; shift ;;
    --open-admin-firewall) OPEN_ADMIN_FIREWALL=1; shift ;;
    --selinux-nginx) SELINUX_NGINX=1; shift ;;
    --tune-sysctl) TUNE_SYSCTL=1; shift ;;
    --no-start) START=0; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "알 수 없는 옵션: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "root 권한이 필요합니다 (sudo ./install.sh)"
[[ "$STORE" == "memory" || "$STORE" == "redis" ]] || die "--store 는 memory 또는 redis 입니다"
[[ -x "$BIN_SRC" ]] || die "바이너리를 찾을 수 없습니다: $BIN_SRC"

# ---- OS 확인 ----
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  os_ver="${VERSION_ID:-0}"
  case "${ID:-}:${os_ver%%.*}" in
    rocky:9|rhel:9|almalinux:9|centos:9|ol:9) info "OS: ${PRETTY_NAME}" ;;
    *)
      if [[ $FORCE -eq 1 ]]; then
        warn "지원 대상(Rocky/RHEL 9)이 아닙니다: ${PRETTY_NAME:-unknown} — --force 로 계속"
      else
        die "지원 대상(Rocky Linux 9 / RHEL 9 계열)이 아닙니다: ${PRETTY_NAME:-unknown} (무시하려면 --force)"
      fi ;;
  esac
fi

if ! "$BIN_SRC" version >/dev/null 2>&1; then
  die "이 서버에서 바이너리를 실행할 수 없습니다 (CPU 아키텍처 확인: $(uname -m))"
fi
NEW_VERSION="$("$BIN_SRC" version)"
if command -v rpm >/dev/null 2>&1 && rpm -q trafficgate >/dev/null 2>&1; then
  die "RPM 패키지로 설치되어 있습니다. 업그레이드는 'dnf upgrade ./trafficgate-*.rpm' 을 사용하세요"
fi
HAS_SYSTEMD=0
[[ -d /run/systemd/system ]] && HAS_SYSTEMD=1

UPGRADE=0
if [[ -x "$BIN_DST" ]]; then
  UPGRADE=1
  info "기존 설치 발견: $("$BIN_DST" version 2>/dev/null || echo unknown) → ${NEW_VERSION}"
else
  info "설치: ${NEW_VERSION}"
fi

# ---- Redis (선택) ----
if [[ $INSTALL_REDIS -eq 1 ]]; then
  info "Redis 설치"
  dnf -y install redis
  if [[ $HAS_SYSTEMD -eq 1 ]]; then systemctl enable --now redis; fi
fi

# ---- 사용자/디렉터리 ----
getent group trafficgate >/dev/null || groupadd --system trafficgate
if ! getent passwd trafficgate >/dev/null; then
  useradd --system --gid trafficgate --home-dir "$DATA_DIR" --no-create-home \
    --shell /sbin/nologin --comment "TrafficGate" trafficgate
  info "시스템 사용자 trafficgate 생성"
fi
install -d -m 0750 -o root -g trafficgate "$CONF_DIR"
install -d -m 0750 -o trafficgate -g trafficgate "$DATA_DIR"

# ---- 바이너리 ----
if [[ $UPGRADE -eq 1 ]]; then cp -p "$BIN_DST" "${BIN_DST}.prev"; fi
install -m 0755 -o root -g root "$BIN_SRC" "${BIN_DST}.new"
mv -f "${BIN_DST}.new" "$BIN_DST"
info "바이너리 설치: $BIN_DST"

# ---- 설정 ----
if [[ ! -f "$CONF" ]]; then
  args=(init-config -out "$CONF" -listen "$LISTEN" -admin-listen "$ADMIN_LISTEN"
        -store "$STORE" -redis-addr "$REDIS_ADDR" -data-dir "$DATA_DIR" -password-file "$PW_FILE")
  [[ -n "$ADMIN_PASSWORD" ]] && args+=(-admin-password "$ADMIN_PASSWORD")
  "$BIN_DST" "${args[@]}" >/dev/null
  chown root:trafficgate "$CONF"
  chmod 0640 "$CONF"
  chmod 0600 "$PW_FILE"
  info "설정 파일 생성: $CONF"
else
  info "기존 설정 유지: $CONF"
fi
if ! "$BIN_DST" check-config -q -config "$CONF"; then
  die "설정 파일 오류 — 위 메시지를 확인해 수정한 뒤 다시 실행하세요"
fi
if [[ -f "${RES}/sysconfig.example" && ! -f /etc/sysconfig/trafficgate ]]; then
  install -m 0600 -o root -g root "${RES}/sysconfig.example" /etc/sysconfig/trafficgate
fi

# ---- systemd ----
install -m 0644 -o root -g root "${RES}/systemd/trafficgate.service" "$UNIT_DST"
info "systemd 유닛 설치: $UNIT_DST"

# ---- firewalld ----
if [[ -d /etc/firewalld ]]; then
  install -d /etc/firewalld/services
  install -m 0644 "${RES}/firewalld/trafficgate.xml" /etc/firewalld/services/trafficgate.xml
  pub_port="${LISTEN##*:}"
  if [[ "$pub_port" != "8800" ]]; then
    sed -i "s/port=\"8800\"/port=\"${pub_port}\"/" /etc/firewalld/services/trafficgate.xml
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --reload >/dev/null
    if [[ $OPEN_FIREWALL -eq 1 ]]; then
      firewall-cmd --permanent --add-service=trafficgate >/dev/null
      info "방화벽 개방: trafficgate (${pub_port}/tcp)"
    fi
    if [[ $OPEN_ADMIN_FIREWALL -eq 1 ]]; then
      firewall-cmd --permanent --add-port="${ADMIN_LISTEN##*:}/tcp" >/dev/null
      warn "관리 콘솔 포트(${ADMIN_LISTEN##*:}/tcp)를 열었습니다 — 접근 IP 제한(rich rule)을 권장합니다"
    fi
    firewall-cmd --reload >/dev/null
  elif [[ $OPEN_FIREWALL -eq 1 || $OPEN_ADMIN_FIREWALL -eq 1 ]]; then
    warn "firewalld 가 실행 중이 아니어서 방화벽 설정을 건너뜁니다"
  fi
fi

# ---- SELinux ----
if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then
  if command -v restorecon >/dev/null 2>&1; then
    restorecon -R "$BIN_DST" "$CONF_DIR" "$DATA_DIR" "$UNIT_DST" >/dev/null 2>&1 || true
  fi
  if [[ $SELINUX_NGINX -eq 1 ]]; then
    setsebool -P httpd_can_network_connect 1
    info "SELinux: httpd_can_network_connect=on (nginx → TrafficGate 프록시 허용)"
  fi
fi

# ---- sysctl ----
if [[ $TUNE_SYSCTL -eq 1 ]]; then
  install -m 0644 "${RES}/sysctl/90-trafficgate.conf" /etc/sysctl.d/90-trafficgate.conf
  sysctl --system >/dev/null
  info "커널 파라미터 적용: /etc/sysctl.d/90-trafficgate.conf"
fi

# ---- 시작 ----
if [[ $HAS_SYSTEMD -eq 1 ]]; then
  systemctl daemon-reload
  systemctl enable trafficgate.service >/dev/null 2>&1
  if [[ $START -eq 1 ]]; then
    if [[ $UPGRADE -eq 1 ]]; then systemctl restart trafficgate.service; else systemctl start trafficgate.service; fi
    if systemctl is-active --quiet trafficgate.service; then
      info "서비스 실행 중: systemctl status trafficgate"
    else
      systemctl status trafficgate.service --no-pager || true
      die "서비스 시작 실패 — journalctl -u trafficgate -e 로 로그를 확인하세요"
    fi
  fi
else
  warn "systemd 가 없는 환경입니다. 직접 실행: sudo -u trafficgate ${BIN_DST} serve -config ${CONF}"
fi

echo
echo "${c_bold}TrafficGate 설치 완료${c_off} (${NEW_VERSION})"
echo "  설정 파일   : ${CONF}"
echo "  데이터      : ${DATA_DIR}"
echo "  공개 주소   : http://${LISTEN/0.0.0.0/$(hostname -I 2>/dev/null | awk '{print $1}')}  (에이전트: /trafficgate.js)"
echo "  관리 콘솔   : http://${ADMIN_LISTEN}"
if [[ "$ADMIN_LISTEN" == 127.0.0.1:* ]]; then
  echo "                원격 접속: ssh -L ${ADMIN_LISTEN##*:}:127.0.0.1:${ADMIN_LISTEN##*:} <서버> 후 http://localhost:${ADMIN_LISTEN##*:}"
fi
if [[ -f "$PW_FILE" ]]; then
  echo "  초기 계정   : ${PW_FILE} (확인 후 삭제하세요)"
fi
echo "  로그        : journalctl -u trafficgate -f"
