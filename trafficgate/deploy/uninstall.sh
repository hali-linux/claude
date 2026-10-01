#!/usr/bin/env bash
# TrafficGate 제거 스크립트 (install.sh 로 설치한 경우)
#   sudo ./uninstall.sh          # 프로그램만 제거 (설정/데이터 유지)
#   sudo ./uninstall.sh --purge  # 설정, 데이터, 시스템 사용자까지 모두 삭제
set -euo pipefail

PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1
[[ $EUID -eq 0 ]] || { echo "root 권한이 필요합니다" >&2; exit 1; }

if [[ -d /run/systemd/system ]]; then
  systemctl disable --now trafficgate.service 2>/dev/null || true
fi
rm -f /etc/systemd/system/trafficgate.service
[[ -d /run/systemd/system ]] && systemctl daemon-reload

if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --remove-service=trafficgate >/dev/null 2>&1 || true
fi
rm -f /etc/firewalld/services/trafficgate.xml
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --reload >/dev/null 2>&1 || true
fi
rm -f /etc/sysctl.d/90-trafficgate.conf
rm -f /usr/bin/trafficgate /usr/bin/trafficgate.prev

if [[ $PURGE -eq 1 ]]; then
  rm -rf /etc/trafficgate /var/lib/trafficgate /etc/sysconfig/trafficgate
  if getent passwd trafficgate >/dev/null; then userdel trafficgate || true; fi
  if getent group trafficgate >/dev/null; then groupdel trafficgate 2>/dev/null || true; fi
  echo "TrafficGate 를 완전히 삭제했습니다."
else
  echo "TrafficGate 를 제거했습니다. 설정(/etc/trafficgate)과 데이터(/var/lib/trafficgate)는 남겨 두었습니다."
fi
