#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Rocky Linux 9: HAProxy(≈ ALB) + ModSecurity/OWASP CRS(≈ AWS WAF) 설치
#
#   sudo ./install.sh --domain photos.example.com [옵션]
#
# 옵션
#   --domain NAME          서비스 도메인 (필수). hosts.map, waf-mode.map, 인증서에 사용
#   --targets LIST         대상 그룹 서버 "host:port[,host:port...]" (기본 127.0.0.1:3000)
#   --mode block|count     초기 WAF 모드 (기본 block, 오탐 점검 기간에는 count)
#   --letsencrypt EMAIL    Let's Encrypt 인증서 발급(certbot, HTTP-01) 및 자동 갱신
#   --modsec-source        EPEL 패키지 대신 libmodsecurity를 소스로 빌드
#   --crs-version VER      OWASP CRS 버전 (기본 4.25.0)
#   --crs-tarball FILE     CRS 압축 파일을 내려받지 않고 이 파일 사용 (오프라인 설치)
#   --overwrite-config     수정된 설정 파일도 덮어쓰기 (기존 파일은 .bak.<시각> 으로 보관)
#   --skip-packages        dnf 패키지 설치 생략 (이미 설치된 경우)
#   --no-start             서비스를 시작하지 않음
#   --force-os             Rocky/RHEL/Alma 9가 아니어도 진행
#
# 환경변수
#   CRS_SHA256=<해시>      CRS 압축 파일 SHA-256 (지정하면 GPG 대신 해시로 검증)
#   CRS_SKIP_VERIFY=1      CRS 서명 검증 생략 (권장하지 않음)
#   MODSEC_VERSION=3.0.16  소스 빌드 시 libmodsecurity 버전
#
# 다시 실행해도 안전합니다. 운영 중 바뀌는 파일(/etc/haproxy/waf/*.map, *.lst)은
# 이미 있으면 건드리지 않고, 수정된 설정 파일은 덮어쓰지 않고 *.new 로 옆에 둡니다.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TS=$(date +%Y%m%d%H%M%S)

DOMAIN="" TARGETS="127.0.0.1:3000" WAF_MODE="block" LE_EMAIL=""
CRS_VERSION=${CRS_VERSION:-4.25.0} CRS_TARBALL="" CRS_SHA256=${CRS_SHA256:-} CRS_SKIP_VERIFY=${CRS_SKIP_VERIFY:-0}
MODSEC_VERSION=${MODSEC_VERSION:-3.0.16} MODSEC_SOURCE=0 MODSEC_PREFIX=""
SKIP_PACKAGES=0 NO_START=0 FORCE_OS=0 OVERWRITE=0
NEW_FILES=()

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m경고:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m오류:\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "${BASH_SOURCE[0]}:${LINENO} 에서 실패: ${BASH_COMMAND}"' ERR

usage() { sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=${2:-}; shift ;;
    --targets) TARGETS=${2:-}; shift ;;
    --mode) WAF_MODE=${2:-}; shift ;;
    --letsencrypt) LE_EMAIL=${2:-}; shift ;;
    --modsec-source) MODSEC_SOURCE=1 ;;
    --crs-version) CRS_VERSION=${2:-}; shift ;;
    --crs-tarball) CRS_TARBALL=${2:-}; shift ;;
    --overwrite-config) OVERWRITE=1 ;;
    --skip-packages) SKIP_PACKAGES=1 ;;
    --no-start) NO_START=1 ;;
    --force-os) FORCE_OS=1 ;;
    -h|--help) usage 0 ;;
    *) warn "알 수 없는 옵션: $1"; usage 2 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || die "root 권한으로 실행하세요 (sudo $0 ...)"
[ -n "$DOMAIN" ] || die "--domain 을 지정하세요 (예: --domain photos.example.com)"
[[ $DOMAIN =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] || die "도메인 형식이 올바르지 않습니다: $DOMAIN"
DOMAIN=${DOMAIN,,}
[[ $WAF_MODE =~ ^(block|count|off)$ ]] || die "--mode 는 block, count, off 중 하나입니다"
[[ $CRS_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "CRS 버전 형식이 올바르지 않습니다: $CRS_VERSION"
IFS=',' read -r -a TARGET_LIST <<< "$TARGETS"
for t in "${TARGET_LIST[@]}"; do
  [[ $t =~ ^([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):[0-9]{1,5}$ ]] || die "--targets 형식은 host:port 입니다: $t"
done

version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
tmpdir=$(mktemp -d); trap 'rm -rf "$tmpdir"' EXIT

# ── 1. 운영체제 ──────────────────────────────────────────────────────────────
check_os() {
  log "운영체제 확인"
  # shellcheck disable=SC1091
  . /etc/os-release
  info "$PRETTY_NAME"
  case "$ID:${VERSION_ID%%.*}" in
    rocky:9|rhel:9|almalinux:9|centos:9) ;;
    *) [ "$FORCE_OS" -eq 1 ] || die "Rocky Linux 9 용 스크립트입니다 (--force-os 로 무시 가능)" ;;
  esac
}

# ── 2. 패키지 ───────────────────────────────────────────────────────────────
install_packages() {
  [ "$SKIP_PACKAGES" -eq 1 ] && { log "패키지 설치 생략 (--skip-packages)"; return; }
  log "패키지 설치 (EPEL, CRB, HAProxy, Go, 빌드 도구)"
  if ! rpm -q epel-release >/dev/null 2>&1; then
    dnf -y install epel-release || dnf -y install "https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm"
  fi
  dnf -y install dnf-plugins-core
  # libmodsecurity-devel, yajl-devel 등이 CRB(CodeReady Builder)에 의존합니다.
  dnf config-manager --set-enabled crb 2>/dev/null \
    || subscription-manager repos --enable "codeready-builder-for-rhel-9-$(arch)-rpms" 2>/dev/null \
    || warn "CRB 저장소를 켜지 못했습니다"
  dnf -y install haproxy socat openssl rsyslog logrotate curl tar gzip gnupg2 python3 \
    policycoreutils-python-utils golang gcc make pkgconf-pkg-config
}

# ── 3. libmodsecurity (ModSecurity v3) ───────────────────────────────────────
modsec_installed_version() {
  if pkg-config --exists modsecurity 2>/dev/null; then pkg-config --modversion modsecurity; return; fi
  if [ -f /usr/local/modsecurity/lib/pkgconfig/modsecurity.pc ]; then
    PKG_CONFIG_PATH=/usr/local/modsecurity/lib/pkgconfig pkg-config --modversion modsecurity; return
  fi
  return 1
}

install_libmodsecurity() {
  log "libmodsecurity (ModSecurity v3)"
  if [ "$MODSEC_SOURCE" -eq 0 ] && [ "$SKIP_PACKAGES" -eq 0 ]; then
    if dnf -y install libmodsecurity libmodsecurity-devel; then
      local v; v=$(rpm -q --qf '%{VERSION}' libmodsecurity)
      if version_ge "$v" 3.0.8; then info "EPEL libmodsecurity $v 사용"; return; fi
      warn "EPEL libmodsecurity $v 가 너무 오래되었습니다(3.0.8 이상 필요). 소스로 빌드합니다."
    else
      warn "EPEL에서 libmodsecurity를 설치하지 못했습니다. 소스로 빌드합니다."
    fi
    MODSEC_SOURCE=1
  fi
  if [ "$MODSEC_SOURCE" -eq 0 ]; then
    local v; v=$(modsec_installed_version) || die "libmodsecurity가 설치되어 있지 않습니다 (--skip-packages)"
    [ -d /usr/local/modsecurity/include/modsecurity ] && ! pkg-config --exists modsecurity 2>/dev/null && MODSEC_PREFIX=/usr/local/modsecurity
    info "설치된 libmodsecurity $v 사용 ${MODSEC_PREFIX:+($MODSEC_PREFIX)}"
    return
  fi
  build_modsecurity
}

build_modsecurity() {
  MODSEC_PREFIX=/usr/local/modsecurity
  if [ -f "$MODSEC_PREFIX/lib/libmodsecurity.so.3" ] && \
     [ "$(PKG_CONFIG_PATH=$MODSEC_PREFIX/lib/pkgconfig pkg-config --modversion modsecurity 2>/dev/null)" = "$MODSEC_VERSION" ]; then
    info "이미 빌드됨: $MODSEC_PREFIX ($MODSEC_VERSION)"; return
  fi
  info "ModSecurity $MODSEC_VERSION 소스 빌드 → $MODSEC_PREFIX (수 분 소요)"
  [ "$SKIP_PACKAGES" -eq 1 ] || dnf -y install gcc-c++ make autoconf automake libtool pcre2-devel libxml2-devel yajl-devel libcurl-devel
  local base="https://github.com/owasp-modsecurity/ModSecurity/releases/download/v$MODSEC_VERSION"
  local tgz="modsecurity-v$MODSEC_VERSION.tar.gz"
  curl -fsSL -o "$tmpdir/$tgz" "$base/$tgz"
  curl -fsSL -o "$tmpdir/$tgz.sha256" "$base/$tgz.sha256" || die "$tgz.sha256 을 내려받지 못했습니다"
  (cd "$tmpdir" && sha256sum -c "$tgz.sha256") || die "ModSecurity 압축 파일 SHA-256 불일치"
  tar -xzf "$tmpdir/$tgz" -C "$tmpdir"
  (cd "$tmpdir/modsecurity-v$MODSEC_VERSION" \
    && ./configure --prefix="$MODSEC_PREFIX" --with-pcre2 --disable-doxygen-doc --disable-examples >/dev/null \
    && make -j"$(nproc)" >/dev/null && make install >/dev/null)
  info "빌드 완료: $MODSEC_PREFIX"
}

# ── 4. WAF 에이전트 (modsec-spoa) ────────────────────────────────────────────
build_agent() {
  log "modsec-spoa 빌드"
  command -v go >/dev/null || die "Go가 없습니다 (dnf install golang)"
  local gov; gov=$(go env GOVERSION | sed 's/^go//')
  version_ge "$gov" 1.21 || die "Go 1.21 이상이 필요합니다 (현재 $gov)"
  make -C "$SRC/spoa" build ${MODSEC_PREFIX:+MODSEC_PREFIX=$MODSEC_PREFIX} >/dev/null
  install -m 0755 "$SRC/spoa/modsec-spoa" /usr/local/bin/modsec-spoa
  info "$(/usr/local/bin/modsec-spoa -version)"
}

# ── 5. OWASP Core Rule Set ───────────────────────────────────────────────────
install_crs() {
  log "OWASP CRS $CRS_VERSION"
  local dest=/usr/share/modsec-spoa/coreruleset-$CRS_VERSION
  if [ -d "$dest/rules" ]; then
    info "이미 설치됨: $dest"
  else
    local tgz="$tmpdir/crs.tar.gz"
    if [ -n "$CRS_TARBALL" ]; then
      cp "$CRS_TARBALL" "$tgz"
    else
      curl -fsSL -o "$tgz" "https://github.com/coreruleset/coreruleset/archive/refs/tags/v$CRS_VERSION.tar.gz"
    fi
    if [ -n "$CRS_SHA256" ]; then
      echo "$CRS_SHA256  $tgz" | sha256sum -c - >/dev/null || die "CRS SHA-256 불일치"
      info "SHA-256 검증 완료"
    elif [ "$CRS_SKIP_VERIFY" = 1 ]; then
      warn "CRS 서명 검증을 생략했습니다 (CRS_SKIP_VERIFY=1)"
    elif [ -n "$CRS_TARBALL" ]; then
      die "--crs-tarball 은 CRS_SHA256=<해시> 로 검증하거나 CRS_SKIP_VERIFY=1 을 지정하세요"
    else
      # CRS 프로젝트 서명(GPG)으로 검증
      curl -fsSL -o "$tgz.asc" "https://github.com/coreruleset/coreruleset/releases/download/v$CRS_VERSION/coreruleset-$CRS_VERSION.tar.gz.asc" \
        || die "CRS 서명 파일을 내려받지 못했습니다. CRS_SHA256=<해시> 로 검증하세요"
      curl -fsSL -o "$tmpdir/crs-key.asc" https://coreruleset.org/security.asc || die "CRS 공개키를 내려받지 못했습니다"
      export GNUPGHOME="$tmpdir/gnupg"; mkdir -m 700 "$GNUPGHOME"
      gpg --batch --quiet --import "$tmpdir/crs-key.asc" 2>/dev/null
      gpg --batch --verify "$tgz.asc" "$tgz" 2>/dev/null || die "CRS GPG 서명 검증 실패"
      unset GNUPGHOME
      info "GPG 서명 검증 완료"
    fi
    mkdir -p "$tmpdir/crs"
    tar -xzf "$tgz" -C "$tmpdir/crs"
    local top; top=$(find "$tmpdir/crs" -mindepth 1 -maxdepth 2 -type d -name rules -printf '%h\n' | head -1)
    [ -n "$top" ] && [ -f "$top/rules/REQUEST-949-BLOCKING-EVALUATION.conf" ] || die "CRS 압축 파일 구조를 알 수 없습니다"
    mkdir -p /usr/share/modsec-spoa
    rm -rf "$dest.tmp"; mkdir -p "$dest.tmp"
    # 규칙과 설정 예시, 라이선스만 설치 (테스트·도구 디렉터리 제외)
    cp -a "$top/rules" "$dest.tmp/"
    for f in crs-setup.conf.example LICENSE LICENSE.md CHANGES.md README.md; do
      [ -e "$top/$f" ] && cp -a "$top/$f" "$dest.tmp/"
    done
    mv "$dest.tmp" "$dest"
    chmod -R u=rwX,go=rX "$dest"
    info "설치: $dest"
  fi
  mkdir -p /etc/modsec-spoa
  ln -sfn "$dest" /etc/modsec-spoa/crs
}

# ── 6. 설정 파일 ─────────────────────────────────────────────────────────────
# 새 파일은 설치, 같은 파일은 그대로, 사용자가 수정한 파일은 *.new 로 옆에 둡니다.
install_cfg() { # src dst mode
  local src=$1 dst=$2 mode=${3:-0644}
  if [ -e "$dst" ] && ! cmp -s "$src" "$dst"; then
    if [ "$OVERWRITE" -eq 1 ]; then
      cp -a "$dst" "$dst.bak.$TS"
    else
      install -m "$mode" "$src" "$dst.new"; NEW_FILES+=("$dst.new"); return
    fi
  fi
  install -D -m "$mode" "$src" "$dst"
}

# 운영 중 wafctl 이 바꾸는 파일: 없을 때만 설치
install_state() { # src dst
  [ -e "$2" ] || install -D -m 0644 "$1" "$2"
}

render_haproxy_cfg() { # → $tmpdir/haproxy.cfg
  local out=$tmpdir/haproxy.cfg servers="" i=1 t
  for t in "${TARGET_LIST[@]}"; do servers+="    server app$i $t"$'\n'; i=$((i + 1)); done
  awk -v servers="$servers" '
    /# BEGIN targets/ { print; printf "%s", servers; skip=1; next }
    /# END targets/   { skip=0 }
    !skip' "$SRC/haproxy/haproxy.cfg" > "$out"
  if [ ! -s /proc/net/if_inet6 ]; then
    sed -i -E 's/^(\s*bind :::.*)$/#\1  # IPv6 미지원으로 비활성화(install.sh)/' "$out"
    info "IPv6가 없어 IPv6 리스너를 비활성화했습니다"
  fi
}

install_configs() {
  log "설정 파일 설치"
  getent group modsec-spoa >/dev/null || groupadd -r modsec-spoa
  getent passwd modsec-spoa >/dev/null || useradd -r -g modsec-spoa -d /var/lib/modsec-spoa -s /sbin/nologin -c "ModSecurity SPOE agent" modsec-spoa
  install -d -m 0755 /etc/modsec-spoa /etc/modsec-spoa/rules.d /etc/modsec-spoa/rules.d/before-crs /etc/modsec-spoa/rules.d/after-crs
  install -d -m 0750 -o modsec-spoa -g modsec-spoa /var/lib/modsec-spoa /var/lib/modsec-spoa/tmp /var/lib/modsec-spoa/data /var/log/modsec-spoa
  install -d -m 0755 /etc/haproxy /etc/haproxy/waf /etc/haproxy/pages /etc/haproxy/errors-waf
  install -d -m 0700 /etc/haproxy/certs

  # ModSecurity
  local f
  for f in main.conf modsecurity.conf crs-setup.conf; do install_cfg "$SRC/modsecurity/$f" "/etc/modsec-spoa/$f"; done
  for f in "$SRC"/modsecurity/rules.d/*/*; do
    install_cfg "$f" "/etc/modsec-spoa/rules.d/$(basename "$(dirname "$f")")/$(basename "$f")"
  done

  # HAProxy: 패키지 기본 설정은 한 번만 백업하고 교체
  render_haproxy_cfg
  if [ -f /etc/haproxy/haproxy.cfg ] && ! grep -q "modsec-spoa" /etc/haproxy/haproxy.cfg; then
    cp -a /etc/haproxy/haproxy.cfg "/etc/haproxy/haproxy.cfg.orig-$TS"
    info "기존 haproxy.cfg 백업: /etc/haproxy/haproxy.cfg.orig-$TS"
    install -m 0644 "$tmpdir/haproxy.cfg" /etc/haproxy/haproxy.cfg
  else
    install_cfg "$tmpdir/haproxy.cfg" /etc/haproxy/haproxy.cfg
  fi
  install_cfg "$SRC/haproxy/waf-spoe.conf" /etc/haproxy/waf-spoe.conf
  for f in "$SRC"/haproxy/pages/*; do install_cfg "$f" "/etc/haproxy/pages/$(basename "$f")"; done
  for f in "$SRC"/haproxy/errors-waf/*; do install_cfg "$f" "/etc/haproxy/errors-waf/$(basename "$f")"; done

  # WAF 목록/맵 (운영 상태)
  sed "s/^photos\.example\.com block$/$DOMAIN $WAF_MODE/" "$SRC/haproxy/waf/waf-mode.map" > "$tmpdir/waf-mode.map"
  sed "s/^photos\.example\.com /$DOMAIN /" "$SRC/haproxy/waf/hosts.map" > "$tmpdir/hosts.map"
  install_state "$tmpdir/waf-mode.map" /etc/haproxy/waf/waf-mode.map
  install_state "$tmpdir/hosts.map" /etc/haproxy/waf/hosts.map
  for f in "$SRC"/haproxy/waf/*; do
    case "$(basename "$f")" in waf-mode.map|hosts.map) continue ;; esac
    install_state "$f" "/etc/haproxy/waf/$(basename "$f")"
  done
  grep -q "^$DOMAIN " /etc/haproxy/waf/hosts.map || { echo "$DOMAIN tg_family_photos" >> /etc/haproxy/waf/hosts.map; info "hosts.map 에 $DOMAIN 추가"; }
  grep -q "^$DOMAIN " /etc/haproxy/waf/waf-mode.map || echo "$DOMAIN $WAF_MODE" >> /etc/haproxy/waf/waf-mode.map

  # 도구
  install -m 0755 "$SRC/bin/wafctl" /usr/local/bin/wafctl
  install -D -m 0755 "$SRC/certbot/deploy-hook.sh" /usr/local/libexec/haproxy-waf/certbot-deploy-hook
  install -D -m 0644 "$SRC/README.md" /usr/local/share/doc/haproxy-waf/README.md 2>/dev/null || true
  install_state "$SRC/sysconfig/modsec-spoa" /etc/sysconfig/modsec-spoa
}

# ── 7. TLS 인증서 ────────────────────────────────────────────────────────────
setup_tls() {
  log "TLS 인증서"
  if compgen -G "/etc/haproxy/certs/*.pem" >/dev/null; then
    info "기존 인증서 사용: $(ls /etc/haproxy/certs/*.pem | tr '\n' ' ')"; return
  fi
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=$DOMAIN" \
    -addext "subjectAltName=DNS:$DOMAIN" -keyout "$tmpdir/key.pem" -out "$tmpdir/cert.pem" 2>/dev/null
  (umask 077; cat "$tmpdir/cert.pem" "$tmpdir/key.pem" > "/etc/haproxy/certs/$DOMAIN.pem")
  warn "임시 자체 서명 인증서를 만들었습니다. 운영에서는 --letsencrypt EMAIL 또는 실제 인증서를 /etc/haproxy/certs/ 에 두세요."
}

# ── 8. SELinux / 방화벽 ──────────────────────────────────────────────────────
setup_selinux() {
  command -v getenforce >/dev/null && [ "$(getenforce)" != "Disabled" ] || { log "SELinux 비활성 — 건너뜀"; return; }
  log "SELinux 설정 ($(getenforce))"
  # HAProxy → 앱(3000), WAF 에이전트(12345) 연결과 peers(12346)/통계(8404) 포트 사용 허용
  setsebool -P haproxy_connect_any 1
  local p
  for p in 8404 12346; do
    semanage port -a -t http_port_t -p tcp "$p" 2>/dev/null || true
  done
  restorecon -R /etc/haproxy /etc/modsec-spoa /var/log/modsec-spoa /var/lib/modsec-spoa \
    /usr/local/bin/modsec-spoa /usr/local/bin/wafctl /usr/local/libexec/haproxy-waf 2>/dev/null || true
  [ -d /var/log/haproxy ] && restorecon -R /var/log/haproxy || true
  [ -d /usr/local/modsecurity ] && restorecon -R /usr/local/modsecurity || true
}

setup_firewall() {
  if command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld; then
    log "firewalld: http, https 허용"
    firewall-cmd --quiet --permanent --add-service=http --add-service=https
    firewall-cmd --quiet --reload
  else
    log "firewalld 비활성 — 80/443 포트가 열려 있는지 직접 확인하세요"
  fi
}

# ── 9. 로그 ──────────────────────────────────────────────────────────────────
setup_logging() {
  log "로그 (rsyslog, logrotate)"
  install -d -m 0755 /var/log/haproxy
  # Ubuntu 계열처럼 rsyslog가 권한을 낮추는 경우 디렉터리 소유자를 맞춥니다.
  if grep -qsE '^\s*\$PrivDropToUser\s+syslog' /etc/rsyslog.conf; then chown syslog:adm /var/log/haproxy; fi
  local conf=$tmpdir/49-haproxy-waf.conf others=(/etc/rsyslog.conf) f
  for f in /etc/rsyslog.d/*.conf; do [ "$f" = /etc/rsyslog.d/49-haproxy-waf.conf ] || others+=("$f"); done
  # imudp 모듈을 다른 설정에서 이미 로드했다면 다시 로드하지 않습니다(중복 로드 오류 방지).
  if grep -qsE '^\s*(module\(load="imudp"|\$ModLoad imudp)' "${others[@]}"; then
    sed 's|^# @@MODULE_IMUDP@@$|# (imudp 모듈은 다른 설정에서 이미 로드됨)|' "$SRC/rsyslog/49-haproxy-waf.conf" > "$conf"
  else
    sed 's|^# @@MODULE_IMUDP@@$|module(load="imudp")|' "$SRC/rsyslog/49-haproxy-waf.conf" > "$conf"
  fi
  install_cfg "$conf" /etc/rsyslog.d/49-haproxy-waf.conf
  install_cfg "$SRC/logrotate/haproxy-waf" /etc/logrotate.d/haproxy-waf
}

# ── 10. systemd ──────────────────────────────────────────────────────────────
install_units() {
  log "systemd 유닛"
  local u
  for u in modsec-spoa.service waf-update-ipsets.service waf-update-ipsets.timer waf-update-geoip.service waf-update-geoip.timer; do
    install_cfg "$SRC/systemd/$u" "/etc/systemd/system/$u"
  done
  install -d /etc/systemd/system/haproxy.service.d
  install_cfg "$SRC/systemd/haproxy.service.d/10-waf.conf" /etc/systemd/system/haproxy.service.d/10-waf.conf
  systemctl daemon-reload
}

# ── 11. 검증 및 시작 ─────────────────────────────────────────────────────────
start_services() {
  log "설정 검증"
  (cd /etc/modsec-spoa && runuser -u modsec-spoa -- /usr/local/bin/modsec-spoa -t -rules /etc/modsec-spoa/main.conf)
  haproxy -c -q -f /etc/haproxy/haproxy.cfg && info "haproxy.cfg OK"
  [ "$NO_START" -eq 1 ] && { log "서비스 시작 생략 (--no-start)"; return; }

  log "서비스 시작"
  systemctl restart rsyslog
  systemctl enable --now modsec-spoa.service
  systemctl enable haproxy.service
  if systemctl is-active --quiet haproxy; then systemctl reload haproxy; else systemctl start haproxy; fi
  systemctl enable --now waf-update-ipsets.timer
  sleep 2
  /usr/local/bin/wafctl update-ipsets || warn "IP 평판 목록을 지금 받지 못했습니다(타이머가 매일 다시 시도합니다)"
}

setup_letsencrypt() {
  [ -n "$LE_EMAIL" ] || return 0
  log "Let's Encrypt 인증서 발급 ($DOMAIN)"
  [ "$NO_START" -eq 0 ] || die "--letsencrypt 는 HAProxy가 실행 중이어야 합니다 (--no-start 와 함께 쓸 수 없음)"
  [ "$SKIP_PACKAGES" -eq 1 ] || dnf -y install certbot
  # HAProxy(:80)가 /.well-known/acme-challenge/ 를 127.0.0.1:8888 의 certbot으로 넘깁니다.
  certbot certonly --standalone --non-interactive --agree-tos -m "$LE_EMAIL" -d "$DOMAIN" \
    --http-01-address 127.0.0.1 --http-01-port 8888 \
    --deploy-hook /usr/local/libexec/haproxy-waf/certbot-deploy-hook
  systemctl enable --now certbot-renew.timer 2>/dev/null || warn "certbot-renew.timer 를 켜지 못했습니다(자동 갱신 확인 필요)"
}

summary() {
  log "완료"
  cat <<EOF
    HTTPS 리스너   https://$DOMAIN  →  대상: ${TARGETS}
    WAF 모드       $(grep "^$DOMAIN " /etc/haproxy/waf/waf-mode.map | awk '{print $2}')   (wafctl mode $DOMAIN count|block)
    상태           wafctl status
    접근 로그      /var/log/haproxy/access.log   (JSON, ≈ ALB access log)
    WAF 로그       /var/log/modsec-spoa/waf.log  (JSON, ≈ AWS WAF logs)
    통계           curl -s http://127.0.0.1:8404/stats

    앱(.env)에 다음을 설정하세요:
      APP_URL=https://$DOMAIN
      TRUST_PROXY=true
      APP_BIND=127.0.0.1      # docker compose: 3000 포트를 외부에 열지 않음(WAF 우회 방지)

    점검:  $SRC/tests/waf-smoke-test.sh -k -r 127.0.0.1 https://$DOMAIN
EOF
  if [ ${#NEW_FILES[@]} -gt 0 ]; then
    warn "수정된 설정 파일은 덮어쓰지 않았습니다. 새 버전과 비교해 반영하세요:"
    printf '      %s\n' "${NEW_FILES[@]}"
  fi
}

check_os
install_packages
install_libmodsecurity
build_agent
install_crs
install_configs
setup_tls
setup_logging
install_units
setup_selinux
setup_firewall
start_services
setup_letsencrypt
summary
