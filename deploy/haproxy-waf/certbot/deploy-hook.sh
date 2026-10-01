#!/bin/bash
# certbot --deploy-hook: 갱신된 Let's Encrypt 인증서를 HAProxy PEM으로 합치고 무중단 reload
set -euo pipefail
: "${RENEWED_LINEAGE:?certbot이 실행하는 스크립트입니다}"
domain=$(basename "$RENEWED_LINEAGE")
dst=/etc/haproxy/certs/$domain.pem
umask 077
cat "$RENEWED_LINEAGE/fullchain.pem" "$RENEWED_LINEAGE/privkey.pem" > "$dst.tmp"
mv -f "$dst.tmp" "$dst"
command -v restorecon >/dev/null && restorecon -q "$dst" || true
haproxy -c -q -f /etc/haproxy/haproxy.cfg && systemctl reload haproxy
