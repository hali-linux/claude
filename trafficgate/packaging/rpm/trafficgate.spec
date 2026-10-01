# TrafficGate RPM 스펙 — Rocky Linux 9 / RHEL 9
#
# 사전 빌드된 정적 바이너리 배포 파일(make dist)로 패키징한다.
#   make rpm                       (scripts/build-rpm.sh 가 아래 매크로를 넘겨준다)
#   rpmbuild -bb --define "tg_version 1.0.0" --define "tg_goarch amd64" trafficgate.spec
#
# Go 툴체인 없이도 패키징할 수 있고, 폐쇄망(오프라인) 설치에 그대로 사용할 수 있다.

%global debug_package %{nil}
%global __strip /bin/true
%{!?tg_version: %global tg_version 1.0.0}
%{!?tg_goarch: %global tg_goarch amd64}
%{!?tg_release: %global tg_release 1}
%global tg_unitdir /usr/lib/systemd/system

Name:           trafficgate
Version:        %{tg_version}
Release:        %{tg_release}%{?dist}
Summary:        Virtual waiting room (traffic control) server
License:        Proprietary
URL:            https://github.com/hali-linux/claude/tree/main/trafficgate
Source0:        trafficgate-%{tg_version}-linux-%{tg_goarch}.tar.gz
ExclusiveArch:  x86_64 aarch64
Requires(pre):  shadow-utils

%description
TrafficGate 는 접속 폭주 시 사용자를 가상 대기실에 순서대로 세워 서비스 장애를 막는
트래픽 제어 서버입니다. 세그먼트별 진입 허용 수, 사전/사후 대기실, 차단/우회 모드,
JS 에이전트(기본/구간 제어), nginx auth_request 게이트, 관리 콘솔, Prometheus 메트릭,
단일 서버(메모리) 및 Redis 클러스터 구성을 지원합니다.

%prep
%setup -q -n trafficgate-%{tg_version}-linux-%{tg_goarch}

%build
# 사전 빌드된 정적 바이너리를 사용한다.

%install
install -D -m 0755 trafficgate %{buildroot}/usr/bin/trafficgate
install -D -m 0644 deploy/systemd/trafficgate.service %{buildroot}%{tg_unitdir}/trafficgate.service
install -D -m 0644 deploy/firewalld/trafficgate.xml %{buildroot}/usr/lib/firewalld/services/trafficgate.xml
install -D -m 0600 deploy/sysconfig.example %{buildroot}/etc/sysconfig/trafficgate
install -d -m 0750 %{buildroot}/etc/trafficgate
install -d -m 0750 %{buildroot}/var/lib/trafficgate
touch %{buildroot}/etc/trafficgate/config.yaml
touch %{buildroot}/etc/trafficgate/initial-admin-password

%pre
getent group trafficgate >/dev/null || groupadd --system trafficgate
getent passwd trafficgate >/dev/null || \
    useradd --system --gid trafficgate --home-dir /var/lib/trafficgate --no-create-home \
            --shell /sbin/nologin --comment "TrafficGate" trafficgate
exit 0

%post
if [ ! -s /etc/trafficgate/config.yaml ]; then
    /usr/bin/trafficgate init-config -force -out /etc/trafficgate/config.yaml \
        -password-file /etc/trafficgate/initial-admin-password >/dev/null 2>&1 || :
fi
chown root:trafficgate /etc/trafficgate/config.yaml 2>/dev/null || :
chmod 0640 /etc/trafficgate/config.yaml 2>/dev/null || :
if [ -d /run/systemd/system ]; then
    systemctl daemon-reload >/dev/null 2>&1 || :
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --reload >/dev/null 2>&1 || :
fi
if [ "$1" -eq 1 ]; then
    cat <<'EOF'

TrafficGate 설치 완료
  시작        : systemctl enable --now trafficgate
  설정 파일   : /etc/trafficgate/config.yaml
  초기 계정   : /etc/trafficgate/initial-admin-password (확인 후 삭제)
  관리 콘솔   : http://127.0.0.1:8801 (원격: ssh -L 8801:127.0.0.1:8801 <서버>)
  방화벽 개방 : firewall-cmd --permanent --add-service=trafficgate && firewall-cmd --reload
  문서        : /usr/share/doc/trafficgate/

EOF
fi
exit 0

%preun
if [ "$1" -eq 0 ] && [ -d /run/systemd/system ]; then
    systemctl --no-reload disable --now trafficgate.service >/dev/null 2>&1 || :
fi
exit 0

%postun
if [ -d /run/systemd/system ]; then
    systemctl daemon-reload >/dev/null 2>&1 || :
    if [ "$1" -ge 1 ]; then
        systemctl try-restart trafficgate.service >/dev/null 2>&1 || :
    fi
fi
exit 0

%files
%doc README.md docs examples
%doc deploy/nginx deploy/sysctl deploy/install.sh deploy/uninstall.sh
/usr/bin/trafficgate
%{tg_unitdir}/trafficgate.service
/usr/lib/firewalld/services/trafficgate.xml
%config(noreplace) %attr(0600,root,root) /etc/sysconfig/trafficgate
%dir %attr(0750,root,trafficgate) /etc/trafficgate
%ghost %config(noreplace) %attr(0640,root,trafficgate) /etc/trafficgate/config.yaml
%ghost %attr(0600,root,root) /etc/trafficgate/initial-admin-password
%dir %attr(0750,trafficgate,trafficgate) /var/lib/trafficgate

%changelog
* Thu Oct 01 2026 TrafficGate <trafficgate@localhost> - 1.0.0-1
- 최초 릴리스
