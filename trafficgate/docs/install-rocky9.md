# Rocky Linux 9 설치 가이드

## 1. 요구 사항

| 항목 | 내용 |
| --- | --- |
| OS | Rocky Linux 9.x (RHEL 9, AlmaLinux 9, Oracle Linux 9 호환) |
| CPU 아키텍처 | x86_64, aarch64 |
| 의존 패키지 | 없음 (정적 바이너리). Redis 클러스터 구성 시 Redis 6.2 이상 |
| 포트 | 8800/tcp 공개(대기열 API·대기 화면·JS 에이전트), 8801/tcp 관리 콘솔(기본 로컬 전용) |
| 시간 동기화 | `chronyd` (Rocky 9 기본). 클러스터 구성 시 노드 간 시각이 맞아야 합니다 |

권장 사양(단일 서버, 메모리 저장소): 2 vCPU / 2GB RAM. 측정 기준 초당 약 2만 5천 건(진입/폴링)을 처리하며,
평균 5초 간격 폴링이면 대기자 약 10만 명에 해당합니다. 실제 처리량은 `trafficgate bench` 로 측정하세요
([운영 가이드](operations.md#4-용량-산정)).

## 2. 설치

### 2.1 RPM 설치 (권장)

```bash
sudo dnf install -y ./trafficgate-1.0.0-1.el9.x86_64.rpm
```

RPM 이 하는 일:

- `/usr/bin/trafficgate` 설치, 시스템 사용자 `trafficgate` 생성
- `/etc/trafficgate/config.yaml` 생성(서명 키 무작위 생성) — 이미 있으면 유지
- 관리자 초기 비밀번호를 `/etc/trafficgate/initial-admin-password`(0600)에 저장
- systemd 유닛(`trafficgate.service`), firewalld 서비스 정의(`trafficgate`) 설치

```bash
sudo cat /etc/trafficgate/initial-admin-password
sudo systemctl enable --now trafficgate
sudo firewall-cmd --permanent --add-service=trafficgate
sudo firewall-cmd --reload
```

### 2.2 설치 스크립트 (압축 파일)

폐쇄망 서버에는 압축 파일 하나만 옮기면 됩니다.

```bash
tar xzf trafficgate-1.0.0-linux-amd64.tar.gz
cd trafficgate-1.0.0-linux-amd64
sudo ./install.sh --open-firewall
```

| 옵션 | 설명 |
| --- | --- |
| `--listen 0.0.0.0:8800` | 공개 서버 주소 |
| `--admin-listen 127.0.0.1:8801` | 관리 콘솔 주소 |
| `--store memory\|redis` | 저장소 (기본 memory) |
| `--redis-addr 10.0.0.5:6379` | Redis 주소(쉼표로 여러 개) |
| `--install-redis` | `dnf install redis` 후 활성화 |
| `--admin-password PW` | 관리자 초기 비밀번호 지정 |
| `--open-firewall` | firewalld 에서 공개 포트 개방 |
| `--selinux-nginx` | nginx → TrafficGate 프록시 허용(`httpd_can_network_connect`) |
| `--tune-sysctl` | 대량 접속용 커널 파라미터 적용 |
| `--no-start` | 서비스를 시작하지 않음 |

스크립트를 다시 실행하면 **업그레이드**로 동작합니다(설정·데이터 유지, 이전 바이너리는 `/usr/bin/trafficgate.prev` 로 보관).

### 2.3 설치 위치

| 경로 | 내용 |
| --- | --- |
| `/usr/bin/trafficgate` | 실행 파일 |
| `/etc/trafficgate/config.yaml` | 설정 파일 (0640 root:trafficgate) |
| `/etc/sysconfig/trafficgate` | 환경 변수 파일(선택, 비밀 값 주입용) |
| `/var/lib/trafficgate/` | 메모리 저장소 데이터 (`segments.json`, 종료 시 `state.json`) |
| `/usr/lib/systemd/system/trafficgate.service` (RPM)<br>`/etc/systemd/system/trafficgate.service` (스크립트) | systemd 유닛 |
| `/usr/lib/firewalld/services/trafficgate.xml` (RPM)<br>`/etc/firewalld/services/trafficgate.xml` (스크립트) | firewalld 서비스 정의 |

## 3. 설정 파일

`/etc/trafficgate/config.yaml` 의 각 항목에 한국어 설명이 들어 있습니다. 변경 후:

```bash
sudo trafficgate check-config            # 문법/값 검사
sudo systemctl restart trafficgate       # 적용 (메모리 저장소도 대기열 상태를 저장 후 복원)
```

자주 바꾸는 항목:

| 항목 | 기본값 | 설명 |
| --- | --- | --- |
| `server.listen` | `0.0.0.0:8800` | 공개 서버 |
| `server.trusted_proxies` | `127.0.0.1/32, ::1/128` | nginx/L4 가 다른 서버라면 그 IP 대역 추가 (실제 사용자 IP 판별) |
| `server.cors_origins` | `["*"]` | JS 에이전트를 쓰는 웹사이트 Origin 으로 제한 권장 |
| `server.gate_base_path` | `/__tg` | nginx 게이트 연동 시 공개 경로 |
| `admin.listen` | `127.0.0.1:8801` | 관리 콘솔. 빈 값이면 비활성 |
| `admin.users` | — | 관리자 계정 (`trafficgate hash-password` 로 해시 생성) |
| `admin.api_tokens` | `[]` | 자동화용 Bearer 토큰 |
| `security.token_secret` | 무작위 | 통과 토큰 서명 키 (클러스터 전 노드 동일) |
| `store.type` | `memory` | `memory` 단일 서버 / `redis` 클러스터 |
| `queue.live_window` | `30s` | 이 시간 폴링이 없으면 다른 사람의 입장을 막지 않음(순번 유지) |
| `queue.wait_ttl` | `5m` | 이 시간 폴링이 없으면 대기열에서 제거 |
| `rate_limit.*` | 진입 120/분 | IP 별 요청 제한 (통신사 NAT 를 고려해 넉넉하게) |

관리자 비밀번호 변경:

```bash
sudo trafficgate hash-password            # 새 비밀번호 두 번 입력 → 해시 출력
sudo vi /etc/trafficgate/config.yaml      # admin.users[].password_hash 교체
sudo systemctl restart trafficgate        # 기존 로그인 세션은 자동으로 무효화
sudo rm -f /etc/trafficgate/initial-admin-password
```

## 4. 방화벽 (firewalld)

```bash
sudo firewall-cmd --permanent --add-service=trafficgate     # 8800/tcp
sudo firewall-cmd --reload
```

nginx 뒤에서만 쓴다면 8800 은 열 필요가 없습니다(80/443 만 개방). 관리 콘솔(8801)을 원격에서 열어야 한다면
반드시 접속 IP 를 제한하세요.

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="10.0.0.0/8" port port="8801" protocol="tcp" accept'
```

## 5. SELinux

TrafficGate 는 `unconfined_service_t` 로 실행되며 SELinux enforcing 모드에서 추가 설정 없이 동작합니다.
nginx(`httpd_t`)가 TrafficGate 로 프록시하려면 다음이 필요합니다.

```bash
sudo setsebool -P httpd_can_network_connect 1
```

포트를 80/443 등 1024 미만으로 직접 바인드하려면 systemd drop-in 으로 권한을 줍니다.

```bash
sudo systemctl edit trafficgate
# [Service]
# AmbientCapabilities=CAP_NET_BIND_SERVICE
# CapabilityBoundingSet=CAP_NET_BIND_SERVICE
```

## 6. nginx 연동

Rocky 9 의 nginx 패키지에는 게이트 연동에 필요한 `auth_request` 모듈이 포함되어 있습니다.

```bash
sudo dnf install -y nginx
sudo cp /usr/share/doc/trafficgate/nginx/trafficgate-gate.conf /etc/nginx/conf.d/www.conf   # 게이트(코드 수정 없음)
# 또는 대기열 전용 도메인: trafficgate-server.conf
sudo nginx -t && sudo systemctl enable --now nginx
sudo setsebool -P httpd_can_network_connect 1
```

자세한 연동 방법은 [연동 가이드](integration.md)를 보세요.

## 7. Redis 클러스터 구성 (이중화)

여러 대의 TrafficGate 가 하나의 대기열을 공유합니다. 노드를 L4/nginx 로 분산하면 한 대가 죽어도 대기열이 유지됩니다.

```
                 ┌── TrafficGate #1 ──┐
  사용자 → L4/nginx┤                    ├── Redis (Sentinel 또는 Cluster)
                 └── TrafficGate #2 ──┘
```

1. Redis 준비 (Rocky 9 AppStream 의 Redis 6.2 이상)

   ```bash
   sudo dnf install -y redis
   sudo vi /etc/redis/redis.conf      # bind, requirepass, maxmemory-policy noeviction 설정
   sudo systemctl enable --now redis
   ```

   > `maxmemory-policy` 는 반드시 `noeviction` 이어야 합니다. 대기열 데이터가 임의로 지워지면 순번이 깨집니다.

2. 각 노드 설정 (`store` 와 `security` 는 모든 노드가 같아야 함)

   ```yaml
   security:
     token_secret: "모든 노드 동일"
     session_secret: "모든 노드 동일"
   store:
     type: redis
     redis:
       addrs: ["10.0.0.5:6379"]          # Sentinel: master_name 지정 + Sentinel 주소들
       password: ""                      # 또는 /etc/sysconfig/trafficgate 의 TRAFFICGATE_REDIS_PASSWORD
       key_prefix: "tg:"
   ```

3. 세그먼트 설정은 Redis 에 저장되어 모든 노드에 2초 이내 반영됩니다. 관리 콘솔은 아무 노드에서나 사용해도 됩니다.

필요한 Redis 메모리는 대기자 1명당 약 380바이트입니다(100만 명 ≈ 400MB).

## 8. 업그레이드 / 롤백 / 제거

```bash
# RPM
sudo dnf upgrade -y ./trafficgate-1.1.0-1.el9.x86_64.rpm     # 설정 유지, 자동 재시작
sudo dnf downgrade -y ./trafficgate-1.0.0-1.el9.x86_64.rpm   # 롤백
sudo dnf remove -y trafficgate                               # 제거 (설정 파일은 .rpmsave 로 보존)

# 스크립트
sudo ./install.sh                                            # 새 버전 압축 파일에서 실행 = 업그레이드
sudo install -m 0755 /usr/bin/trafficgate.prev /usr/bin/trafficgate && sudo systemctl restart trafficgate   # 롤백
sudo ./uninstall.sh            # 제거 (설정/데이터 유지)
sudo ./uninstall.sh --purge    # 설정/데이터/사용자까지 삭제
```

메모리 저장소는 종료 시 대기열을 `/var/lib/trafficgate/state.json` 에 저장하고 시작 시 복원하므로,
재시작(수 초) 동안 대기자는 순번을 잃지 않습니다. 대기 화면은 일시적 오류를 자동으로 재시도합니다.
