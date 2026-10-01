# TrafficGate — 가상 대기실(트래픽 제어) 서버

접속이 한꺼번에 몰릴 때 사용자를 **가상 대기실**에 순서대로 세워, 서비스가 감당할 수 있는 만큼만 들여보내는
트래픽 제어 서버입니다. STCLab **NetFUNNEL** 과 같은 방식(세그먼트, 진입 허용 수, 대기 순번, 기본/구간 제어,
사전/사후 대기실)으로 동작하며, **Rocky Linux 9** 서버에 RPM 또는 설치 스크립트로 바로 설치해 운영할 수 있습니다.

> TrafficGate 는 NetFUNNEL 의 동작 방식을 참고해 새로 구현한 독립 소프트웨어이며, STCLab 및 NetFUNNEL 과 관계가 없습니다.
> NetFUNNEL 의 코드, API, 프로토콜과 호환되지 않습니다.

```
            ┌──────────── 브라우저 ────────────┐
            │  trafficgate.js (대기 화면/순번)  │
            └──────┬───────────────────┬───────┘
     ① 진입/폴링   │                   │ ③ 통과 토큰과 함께 요청
                   ▼                   ▼
          ┌─────────────────┐   ┌───────────────┐  ② (선택) nginx auth_request 로
          │   TrafficGate   │◀──│     nginx      │     통과 쿠키 확인 → 없으면 대기 화면
          │ (Go 단일 바이너리)│   └───────┬───────┘
          └───────┬─────────┘           ▼
        메모리 or Redis          ┌───────────────┐
        (단일 / 클러스터)        │  웹 애플리케이션 │  ← 진입 허용 수만큼만 동시에 들어옴
                                 └───────────────┘
```

## 주요 기능

| 기능 | 설명 |
| --- | --- |
| 세그먼트(대기실) | 페이지·기능별로 독립된 대기열. 진입 허용 수(동시 입장 인원)를 실시간 변경 |
| 엄격한 선착순 | 순위 트리(메모리) / Lua 스크립트(Redis)로 원자적으로 처리, 진입 허용 수를 절대 넘지 않음 |
| 이탈자 자동 정리 | 폴링을 멈춘 대기자는 다른 사람을 막지 않고, 일정 시간 후 제거. 새로고침해도 순번 유지 |
| 기본 제어 | `TrafficGate.start()` → 작업 → `TrafficGate.complete()` (NetFUNNEL nfStart/nfStop 방식) |
| 구간 제어 | 여러 페이지(결제 과정 등)에 걸쳐 슬롯 유지: `hold` + `keepAlive` + `complete` |
| 코드 수정 없는 적용 | nginx `auth_request` 게이트 + 세그먼트 URL 패턴(`/event/*`)으로 경로 단위 보호 |
| 사전 대기실 | 오픈 시각 전 도착자는 카운트다운 화면, 오픈 시 자동 입장. 순번 무작위 섞기(매크로 선점 완화) |
| 사후 대기실 | 종료 시각 이후 종료 안내 및 지정 URL 로 이동 |
| 차단 / 제어 해제 | 점검 시 즉시 차단, 트래픽이 적을 때는 대기 없이 통과 |
| 통과 토큰 | HMAC 서명 토큰(쿠키/헤더)으로 대기열 우회 방지. 서버 API 또는 Java/Node/Python 에서 직접 검증 |
| 관리 콘솔 | 실시간 대기/입장/처리량/예상 대기 시간 그래프, 세그먼트 편집, 연동 코드 생성 |
| 모니터링 | Prometheus `/metrics`, 헬스 체크(`/healthz`, `/readyz`), journald 로그, 관리자 작업 감사 로그 |
| 이중화 | Redis(단일/Sentinel/Cluster) 공유 저장소로 여러 대 구성, 설정 변경 자동 동기화 |
| 보호 기능 | IP 별 요청 제한, 대기열 최대 인원, 장애 시 통과(fail-open) 옵션 |
| 운영 편의 | 정적 단일 바이너리(외부 의존성 없음, 폐쇄망 설치 가능), systemd 보안 강화, 무중단에 가까운 재시작(대기열 상태 저장/복원), 부하 테스트 도구 내장 |

## 빠른 시작 — Rocky Linux 9

### 방법 1. RPM (권장)

```bash
sudo dnf install -y ./trafficgate-1.0.0-1.el9.x86_64.rpm
sudo cat /etc/trafficgate/initial-admin-password        # 관리자 초기 계정 확인
sudo systemctl enable --now trafficgate
sudo firewall-cmd --permanent --add-service=trafficgate && sudo firewall-cmd --reload   # 8800/tcp
```

### 방법 2. 압축 파일 + 설치 스크립트 (폐쇄망 포함)

```bash
tar xzf trafficgate-1.0.0-linux-amd64.tar.gz
cd trafficgate-1.0.0-linux-amd64
sudo ./install.sh --open-firewall
```

설치 후 확인:

```bash
systemctl status trafficgate
curl -s http://127.0.0.1:8800/healthz
journalctl -u trafficgate -f
```

관리 콘솔은 보안을 위해 기본적으로 서버 내부(`127.0.0.1:8801`)에서만 열립니다. PC 에서는 SSH 터널로 접속합니다.

```bash
ssh -L 8801:127.0.0.1:8801 user@서버   # 그다음 브라우저에서 http://localhost:8801
```

### 방법 3. 소스에서 빌드

Go 1.24 이상이 필요합니다.

```bash
cd trafficgate
make test        # 테스트 (redis-server 가 있으면 Redis 저장소도 함께 검사)
make dist        # dist/trafficgate-<버전>-linux-amd64.tar.gz
make rpm         # dist/trafficgate-<버전>-1.el9.x86_64.rpm   (rpmbuild 필요)
GOARCH=arm64 make rpm   # aarch64 서버용
```

## 웹사이트에 붙이기

가장 간단한 방법은 링크에 속성을 하나 추가하는 것입니다.

```html
<script src="https://wait.example.com/trafficgate.js"></script>
<a href="/event/buy" data-tg-segment="event">구매하기</a>          <!-- 클릭 → 대기 → 이동 -->

<!-- /event/buy 페이지: 로드가 끝나면 슬롯 반환 -->
<script src="https://wait.example.com/trafficgate.js" data-complete="event"></script>
```

애플리케이션을 수정할 수 없다면 nginx 게이트를 사용합니다([deploy/nginx/trafficgate-gate.conf](deploy/nginx/trafficgate-gate.conf)).
자세한 내용은 [연동 가이드](docs/integration.md)를 보세요. 관리 콘솔의 **연동 가이드** 버튼을 누르면 세그먼트에 맞는 코드가 생성됩니다.

## 문서

| 문서 | 내용 |
| --- | --- |
| [docs/install-rocky9.md](docs/install-rocky9.md) | Rocky Linux 9 설치, 설정 파일, SELinux/firewalld, Redis 클러스터 구성, 업그레이드/제거 |
| [docs/integration.md](docs/integration.md) | JS 에이전트(기본/구간 제어), nginx 게이트, 백엔드 토큰 검증 |
| [docs/operations.md](docs/operations.md) | 운영(이벤트 준비, 모니터링, 용량 산정, 튜닝, 장애 대응, 보안 점검) |
| [docs/api.md](docs/api.md) | 공개 API / 관리 API / 메트릭 레퍼런스 |
| [examples/](examples/) | 데모 페이지, Python/Node/Java 토큰 검증 예제 |

## 디렉터리 구조

```
trafficgate/
├── cmd/trafficgate/          CLI (serve, init-config, hash-password, check-config, bench)
├── internal/
│   ├── queue/                대기열 엔진, 메모리 저장소(순위 트리), Redis 저장소(Lua)
│   ├── server/               HTTP 서버 (공개 API, nginx 게이트, 관리 API, 메트릭)
│   │   └── web/              JS 에이전트(trafficgate.js), 관리 콘솔(정적 파일, 바이너리에 내장)
│   ├── config/               설정 파일 해석/검증, 설정 템플릿
│   ├── token/                통과 토큰 (HMAC-SHA256)
│   ├── auth/                 관리자 비밀번호(PBKDF2), 세션
│   └── bench/                부하 테스트 도구
├── deploy/                   install.sh, systemd 유닛, nginx/firewalld/sysctl 설정
├── packaging/rpm/            RPM 스펙
├── scripts/                  RPM 빌드, Rocky 9 컨테이너 설치 검증
├── docs/                     문서
└── examples/                 예제
```

## 검증 범위

- `make test`: 메모리·Redis 저장소 공통 동작 테스트(선착순, 만료, 이탈, 사전 대기실, 동시성), HTTP API/게이트/관리 API/CSRF 통합 테스트
- `make e2e-rocky9`: Rocky Linux 9 컨테이너에서 RPM 설치, 설치 스크립트 설치/업그레이드/제거, 서비스 기동, 부하 테스트

## 제한 사항

- 대기자는 폴링(기본 1~10초 간격, 순번에 따라 자동 조절)으로 순번을 확인합니다. 체류 시간이 매우 짧은(1~2초) 작업에서는
  빈 슬롯이 다음 폴링까지 잠시 비어 있을 수 있어 처리량이 이론치보다 낮게 나옵니다.
- SMS/앱 푸시 같은 오프라인 대기 알림은 없습니다(브라우저 탭 제목 변경과 이미 허용된 브라우저 알림만 지원).
- JS 에이전트만 쓰면 스크립트를 우회하는 봇을 막을 수 없습니다. 중요한 API 는 반드시 서버에서 통과 토큰을 검증하거나 nginx 게이트를 사용하세요.
