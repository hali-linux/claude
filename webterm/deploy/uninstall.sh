#!/usr/bin/env bash
# Remove WebTerm.  Configuration, certificates, the webterm user and the
# webterm-users group are kept unless --purge is given.  httpd is not removed.
set -Eeuo pipefail

PURGE=0
case "${1:-}" in
    --purge) PURGE=1 ;;
    "") ;;
    -h|--help) echo "사용법: sudo $0 [--purge]"; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
esac
[[ $EUID -eq 0 ]] || { echo "root 권한으로 실행하세요." >&2; exit 1; }

msg() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

msg "서비스 중지"
systemctl disable --now webterm.service webterm-helper.service 2>/dev/null || true
rm -f /etc/systemd/system/webterm.service /etc/systemd/system/webterm-helper.service
systemctl daemon-reload

msg "httpd 설정 제거"
rm -f /etc/httpd/conf.d/webterm.conf
if systemctl is-active --quiet httpd; then
    httpd -t && systemctl reload httpd
fi

msg "애플리케이션 제거: /opt/webterm"
rm -rf /opt/webterm
rm -f /etc/pam.d/webterm

if [[ $PURGE -eq 1 ]]; then
    msg "설정/인증서/계정 삭제 (--purge)"
    port=$(sed -n -E 's/^[[:space:]]*listen_port[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' /etc/webterm/webterm.conf 2>/dev/null | tail -n 1)
    rm -rf /etc/webterm
    rm -f /etc/httpd/conf.d/webterm.conf.bak
    rm -f /etc/pki/tls/certs/webterm.crt /etc/pki/tls/private/webterm.key
    if [[ -n $port ]] && command -v semanage >/dev/null; then
        semanage port -d -t http_port_t -p tcp "$port" 2>/dev/null || true
    fi
    id -u webterm >/dev/null 2>&1 && userdel webterm || true
    getent group webterm-users >/dev/null && groupdel webterm-users || true
else
    echo "설정(/etc/webterm), 인증서, webterm 사용자/그룹은 남겨 두었습니다. 모두 지우려면 --purge"
fi
msg "완료"
