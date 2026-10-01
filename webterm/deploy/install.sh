#!/usr/bin/env bash
# WebTerm installer for Rocky Linux 9 (RHEL 9 / AlmaLinux 9 compatible).
#
# Installs httpd + mod_ssl, the WebTerm services and an HTTPS virtual host
# that proxies to the local web server.  Safe to run again for upgrades.
set -Eeuo pipefail

APP_DIR=/opt/webterm
CONF_DIR=/etc/webterm
CONF_FILE=$CONF_DIR/webterm.conf
SERVICE_USER=webterm
USERS_GROUP=webterm-users
HTTPD_CONF=/etc/httpd/conf.d/webterm.conf
DEFAULT_CERT=/etc/pki/tls/certs/webterm.crt
DEFAULT_KEY=/etc/pki/tls/private/webterm.key

SERVER_NAME=""
PORT=""
CERT_FILE=""
KEY_FILE=""
PYTHON=""
WHEELHOUSE=""
CONFIGURE_FIREWALL=1
ADD_USERS=()

usage() {
    cat <<'EOF'
사용법: sudo ./deploy/install.sh [옵션]

  --server-name NAME   접속할 도메인 또는 IP (기본: hostname -f)
  --port PORT          내부 웹 서버 포트 (기본: 8022)
  --cert FILE          TLS 인증서 (PEM). 생략하면 자체 서명 인증서를 만듭니다.
  --key FILE           TLS 개인 키 (PEM)
  --add-user USER      USER 를 로그인 허용 그룹(webterm-users)에 추가 (여러 번 사용 가능)
  --python PATH        사용할 Python 3.11+ 경로 (기본: python3.12 → python3.11)
  --wheelhouse DIR     인터넷 없이 설치: 미리 받아 둔 wheel 디렉터리
  --no-firewall        firewalld 설정을 건드리지 않음
  -h, --help           도움말
EOF
}

msg()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[경고]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[오류]\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "설치 중 오류가 발생했습니다 (line $LINENO)."' ERR

while [[ $# -gt 0 ]]; do
    case "$1" in
        --server-name) SERVER_NAME=${2:?}; shift 2 ;;
        --port) PORT=${2:?}; shift 2 ;;
        --cert) CERT_FILE=${2:?}; shift 2 ;;
        --key) KEY_FILE=${2:?}; shift 2 ;;
        --add-user) ADD_USERS+=("${2:?}"); shift 2 ;;
        --python) PYTHON=${2:?}; shift 2 ;;
        --wheelhouse) WHEELHOUSE=${2:?}; shift 2 ;;
        --no-firewall) CONFIGURE_FIREWALL=0; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "알 수 없는 옵션: $1" ;;
    esac
done

[[ $EUID -eq 0 ]] || die "root 권한으로 실행하세요: sudo $0"
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ -f $SRC_DIR/webterm/web.py ]] || die "소스 디렉터리를 찾을 수 없습니다: $SRC_DIR"
if [[ -n $CERT_FILE || -n $KEY_FILE ]]; then
    [[ -f $CERT_FILE && -f $KEY_FILE ]] || die "--cert 와 --key 를 함께, 존재하는 파일로 지정하세요."
fi
if [[ -n $PORT && ! $PORT =~ ^[0-9]+$ ]]; then die "--port 는 숫자여야 합니다."; fi
# --add-user only adds existing accounts to the login group; check them
# before anything is installed.
for user in "${ADD_USERS[@]}"; do
    if ! id -u "$user" >/dev/null 2>&1; then
        die "사용자 '$user' 계정이 이 서버에 없습니다. --add-user 는 기존 계정을 로그인 허용 그룹에 추가만 합니다.
       먼저 계정을 만들고 비밀번호를 설정한 뒤 다시 실행하세요:
         sudo useradd -m $user && sudo passwd $user"
    fi
done

# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in
    rocky:9*|rhel:9*|almalinux:9*|centos:9*|ol:9*) ;;
    *) warn "Rocky Linux 9 용 스크립트입니다 (감지된 OS: ${PRETTY_NAME:-unknown}). 계속 진행합니다." ;;
esac

# --------------------------------------------------------------- packages
msg "패키지 설치: httpd, mod_ssl, openssl, SELinux 도구, Python"
dnf -y install httpd mod_ssl openssl util-linux policycoreutils-python-utils
if [[ -z $PYTHON ]]; then
    if ! command -v python3.12 >/dev/null && ! command -v python3.11 >/dev/null; then
        dnf -y install python3.12 || dnf -y install python3.11 || true
    fi
    PYTHON=$(command -v python3.12 || command -v python3.11 || true)
fi
[[ -n $PYTHON && -x $PYTHON ]] || die "Python 3.11 이상을 찾을 수 없습니다 (dnf install python3.12)."
"$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 11))' \
    || die "$PYTHON 은 3.11 미만입니다. --python 으로 3.11 이상을 지정하세요."
msg "Python: $PYTHON ($("$PYTHON" -V 2>&1))"

# ---------------------------------------------------------- users, groups
msg "시스템 사용자($SERVICE_USER)와 로그인 허용 그룹($USERS_GROUP) 준비"
getent group "$USERS_GROUP" >/dev/null || groupadd "$USERS_GROUP"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir /var/lib/webterm --no-create-home \
        --shell /sbin/nologin --comment "WebTerm web server" "$SERVICE_USER"
fi
for user in "${ADD_USERS[@]}"; do
    usermod -aG "$USERS_GROUP" "$user"
    msg "  $user → $USERS_GROUP 그룹에 추가"
    # Warn about accounts that still could not log in.
    login_shell=$(getent passwd "$user" | cut -d: -f7)
    case $login_shell in
        */nologin|*/false|"") warn "$user 의 로그인 셸이 '${login_shell:-없음}' 이라 로그인할 수 없습니다: sudo usermod -s /bin/bash $user" ;;
    esac
    if [[ $(id -u "$user") -eq 0 ]]; then
        warn "$user 는 UID 0 이라 기본 설정(allow_root = no)에서는 로그인이 차단됩니다."
    fi
    case $(passwd -S "$user" 2>/dev/null | awk '{print $2}') in
        LK|L|NP) warn "$user 계정에 비밀번호가 없거나 잠겨 있어 로그인할 수 없습니다: sudo passwd $user" ;;
    esac
done

# ---------------------------------------------------------- application
msg "애플리케이션 설치: $APP_DIR"
install -d -m 0755 "$APP_DIR"
rm -rf "$APP_DIR/webterm.new"
cp -r "$SRC_DIR/webterm" "$APP_DIR/webterm.new"
find "$APP_DIR/webterm.new" -name '__pycache__' -type d -prune -exec rm -rf {} +
rm -rf "$APP_DIR/webterm"
mv "$APP_DIR/webterm.new" "$APP_DIR/webterm"
install -m 0644 "$SRC_DIR/requirements.txt" "$SRC_DIR/README.md" "$APP_DIR/"
chown -R root:root "$APP_DIR/webterm"
find "$APP_DIR/webterm" -type d -exec chmod 0755 {} +
find "$APP_DIR/webterm" -type f -exec chmod 0644 {} +

if [[ -x $APP_DIR/venv/bin/python ]] && \
   [[ $("$APP_DIR/venv/bin/python" -c 'import sys; print(sys.version_info[:2])') == $("$PYTHON" -c 'import sys; print(sys.version_info[:2])') ]]; then
    :
else
    rm -rf "$APP_DIR/venv"
    "$PYTHON" -m venv "$APP_DIR/venv"
fi
PIP=("$APP_DIR/venv/bin/python" -m pip install --disable-pip-version-check --quiet)
if [[ -n $WHEELHOUSE ]]; then
    "${PIP[@]}" --no-index --find-links "$WHEELHOUSE" -r "$APP_DIR/requirements.txt"
else
    "${PIP[@]}" -r "$APP_DIR/requirements.txt"
fi
chown -R root:root "$APP_DIR/venv"
chmod -R go-w "$APP_DIR/venv"
"$APP_DIR/venv/bin/python" -c 'import aiohttp' || die "aiohttp 설치에 실패했습니다."
# The web service runs with a read-only /opt, so precompile the bytecode now.
"$APP_DIR/venv/bin/python" -m compileall -q "$APP_DIR/webterm" >/dev/null

# -------------------------------------------------------------- config
install -d -m 0755 "$CONF_DIR"
if [[ -f $CONF_FILE ]]; then
    install -m 0644 "$SRC_DIR/deploy/webterm.conf" "$CONF_FILE.new"
    warn "기존 설정 파일을 유지합니다: $CONF_FILE (새 기본값: $CONF_FILE.new)"
    if [[ -n $PORT ]]; then
        sed -i -E "s/^[[:space:]]*listen_port[[:space:]]*=.*/listen_port = $PORT/" "$CONF_FILE"
    fi
else
    install -m 0644 "$SRC_DIR/deploy/webterm.conf" "$CONF_FILE"
    sed -i -E "s/^[[:space:]]*listen_port[[:space:]]*=.*/listen_port = ${PORT:-8022}/" "$CONF_FILE"
    msg "설정 파일 생성: $CONF_FILE"
fi
conf_value() {  # conf_value <key> <default>
    local value
    value=$(sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*([^[:space:]#]*).*/\\1/p" "$CONF_FILE" | tail -n 1)
    printf '%s' "${value:-$2}"
}
PORT=$(conf_value listen_port 8022)
MAX_UPLOAD=$(conf_value max_upload_bytes 1073741824)
if (( MAX_UPLOAD > 2147483647 )); then MAX_UPLOAD=2147483647; fi  # httpd maximum
# Validate the configuration with the real loader before touching services.
(cd "$APP_DIR" && "$APP_DIR/venv/bin/python" -c \
    'import sys; from webterm.config import load_config; load_config(sys.argv[1])' "$CONF_FILE") \
    || die "설정 파일 오류: $CONF_FILE"

if [[ ! -f /etc/pam.d/webterm ]]; then
    install -m 0644 "$SRC_DIR/deploy/pam.d-webterm" /etc/pam.d/webterm
    msg "PAM 설정 생성: /etc/pam.d/webterm"
fi

# ----------------------------------------------------------------- SELinux
if command -v getenforce >/dev/null && [[ $(getenforce) != Disabled ]]; then
    msg "SELinux: httpd → 127.0.0.1:$PORT 프록시 허용"
    if ! semanage port -a -t http_port_t -p tcp "$PORT" >/dev/null 2>&1; then
        semanage port -m -t http_port_t -p tcp "$PORT"
    fi
    setsebool -P httpd_can_network_relay 1
fi

# ----------------------------------------------------------------- systemd
msg "systemd 서비스 등록: webterm-helper, webterm"
sed "s|@PYTHON@|$PYTHON|g" "$SRC_DIR/deploy/webterm-helper.service" > /etc/systemd/system/webterm-helper.service
install -m 0644 "$SRC_DIR/deploy/webterm.service" /etc/systemd/system/webterm.service
chmod 0644 /etc/systemd/system/webterm-helper.service
systemctl daemon-reload
systemctl enable webterm-helper.service webterm.service >/dev/null
systemctl restart webterm-helper.service
systemctl restart webterm.service

# --------------------------------------------------------------------- TLS
# On upgrades keep the server name and certificate of the existing vhost
# (e.g. a Let's Encrypt certificate) unless new ones were given.
if [[ -f $HTTPD_CONF ]]; then
    directive() { sed -n -E "s/^[[:space:]]*$1[[:space:]]+([^[:space:]]+).*/\\1/p" "$HTTPD_CONF" | head -n 1; }
    old_name=$(directive ServerName)
    old_cert=$(directive SSLCertificateFile)
    old_key=$(directive SSLCertificateKeyFile)
    if [[ -z $SERVER_NAME && -n $old_name ]]; then SERVER_NAME=$old_name; fi
    if [[ -z $CERT_FILE && -f $old_cert && -f $old_key ]]; then
        CERT_FILE=$old_cert
        KEY_FILE=$old_key
    fi
fi
if [[ -z $SERVER_NAME ]]; then
    SERVER_NAME=$(hostname -f 2>/dev/null || hostname)
fi
is_ip() { [[ $1 =~ ^[0-9]+(\.[0-9]+){3}$ || $1 == *:* ]]; }
if [[ -z $CERT_FILE ]]; then
    CERT_FILE=$DEFAULT_CERT
    KEY_FILE=$DEFAULT_KEY
    if [[ ! -f $CERT_FILE || ! -f $KEY_FILE ]]; then
        msg "자체 서명 TLS 인증서 생성: $CERT_FILE"
        san="DNS:localhost,IP:127.0.0.1"
        if is_ip "$SERVER_NAME"; then san="IP:$SERVER_NAME,$san"; else san="DNS:$SERVER_NAME,$san"; fi
        for ip in $(hostname -I 2>/dev/null || true); do
            [[ $ip == "$SERVER_NAME" ]] || san="$san,IP:$ip"
        done
        (umask 077; openssl req -x509 -newkey rsa:3072 -sha256 -days 825 -nodes \
            -keyout "$KEY_FILE" -out "$CERT_FILE" -subj "/CN=$SERVER_NAME" \
            -addext "subjectAltName=$san" \
            -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
            -addext "extendedKeyUsage=serverAuth" 2>/dev/null)
        chmod 0644 "$CERT_FILE"
        chmod 0600 "$KEY_FILE"
        command -v restorecon >/dev/null && restorecon -F "$CERT_FILE" "$KEY_FILE" || true
    fi
fi

# ------------------------------------------------------------------- httpd
msg "httpd 가상 호스트 설정: $HTTPD_CONF (https://$SERVER_NAME/)"
if [[ -f $HTTPD_CONF ]]; then
    cp -p "$HTTPD_CONF" "$HTTPD_CONF.bak"
    warn "기존 httpd 설정을 $HTTPD_CONF.bak 으로 백업했습니다 (직접 수정한 내용이 있다면 옮겨 주세요)."
fi
sed -e "s|@SERVER_NAME@|$SERVER_NAME|g" \
    -e "s|@PORT@|$PORT|g" \
    -e "s|@CERT_FILE@|$CERT_FILE|g" \
    -e "s|@KEY_FILE@|$KEY_FILE|g" \
    -e "s|@MAX_UPLOAD@|$MAX_UPLOAD|g" \
    "$SRC_DIR/deploy/httpd-webterm.conf" > "$HTTPD_CONF"
chmod 0644 "$HTTPD_CONF"

# mod_ssl's default /etc/httpd/conf.d/ssl.conf uses localhost.crt/.key, which
# Rocky Linux only creates when httpd starts for the first time
# (httpd-init.service).  On a server where httpd was installed but never
# started they do not exist yet and "httpd -t" fails, so create them now.
SSL_CONF=/etc/httpd/conf.d/ssl.conf
LOCAL_CERT=/etc/pki/tls/certs/localhost.crt
LOCAL_KEY=/etc/pki/tls/private/localhost.key
if [[ -f $SSL_CONF ]] \
   && grep -Eq "^[[:space:]]*SSLCertificateFile[[:space:]]+$LOCAL_CERT" "$SSL_CONF" \
   && [[ ! -s $LOCAL_CERT || ! -s $LOCAL_KEY ]]; then
    msg "mod_ssl 기본 인증서 생성: $LOCAL_CERT (httpd 를 처음 시작할 때 만들어지는 파일)"
    systemctl start httpd-init.service >/dev/null 2>&1 || true
    if [[ ! -s $LOCAL_CERT || ! -s $LOCAL_KEY ]]; then
        (umask 077; openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
            -keyout "$LOCAL_KEY" -out "$LOCAL_CERT" \
            -subj "/CN=$(hostname -f 2>/dev/null || hostname)" 2>/dev/null)
        chmod 0644 "$LOCAL_CERT"
        if command -v restorecon >/dev/null; then restorecon -F "$LOCAL_CERT" "$LOCAL_KEY"; fi
    fi
fi
httpd -t || die "httpd 설정 검사 실패: 위 메시지에 나온 파일과 줄 번호를 확인하세요."
systemctl enable httpd.service >/dev/null
systemctl restart httpd.service

# ---------------------------------------------------------------- firewall
if [[ $CONFIGURE_FIREWALL -eq 1 ]] && systemctl is-active --quiet firewalld; then
    msg "firewalld: http, https 허용"
    firewall-cmd --quiet --permanent --add-service=http --add-service=https
    firewall-cmd --quiet --reload
fi

# ------------------------------------------------------------------- check
msg "동작 확인"
ok=1
for unit in webterm-helper webterm httpd; do
    if systemctl is-active --quiet "$unit"; then
        printf '  %-16s active\n' "$unit"
    else
        printf '  %-16s \033[1;31m%s\033[0m\n' "$unit" "$(systemctl is-active "$unit" || true)"
        ok=0
    fi
done
proxy_ok=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsSk --noproxy "*" --resolve "$SERVER_NAME:443:127.0.0.1" "https://$SERVER_NAME/api/session" 2>/dev/null \
        | grep -q '"authenticated"'; then
        proxy_ok=1
        break
    fi
    sleep 1
done
if [[ $proxy_ok -eq 1 ]]; then
    printf '  %-16s ok\n' "https proxy"
else
    printf '  %-16s \033[1;31mfailed\033[0m\n' "https proxy"
    ok=0
fi

cat <<EOF

설치가 끝났습니다.

  접속 주소      https://$SERVER_NAME/
  로그인 허용    $USERS_GROUP 그룹 구성원 (추가: usermod -aG $USERS_GROUP <사용자>)
  설정 파일      $CONF_FILE
  서비스 로그    journalctl -u webterm -u webterm-helper -f
  httpd 로그     /var/log/httpd/webterm_access.log, webterm_error.log
EOF
if [[ $CERT_FILE == "$DEFAULT_CERT" ]]; then
    cat <<EOF

  ※ 자체 서명 인증서를 사용 중이라 브라우저에 경고가 표시됩니다.
    도메인이 있다면 Let's Encrypt 인증서로 교체하세요 (README 참고).
EOF
fi
if [[ ${#ADD_USERS[@]} -eq 0 ]] && [[ -z $(getent group "$USERS_GROUP" | cut -d: -f4) ]]; then
    warn "아직 $USERS_GROUP 그룹에 사용자가 없습니다: usermod -aG $USERS_GROUP <사용자>"
fi
[[ $ok -eq 1 ]] || warn "일부 서비스가 실행 중이 아닙니다. journalctl -u webterm -u webterm-helper 를 확인하세요."
