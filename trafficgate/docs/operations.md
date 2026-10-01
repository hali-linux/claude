# 운영 가이드

## 1. 일상 운영 명령

```bash
systemctl status trafficgate            # 상태
systemctl restart trafficgate           # 재시작 (메모리 저장소도 대기열 저장/복원)
journalctl -u trafficgate -f            # 로그 실시간
journalctl -u trafficgate --since "10 min ago" -p warning   # 최근 경고 이상
trafficgate check-config                # 설정 검사
curl -s http://127.0.0.1:8800/readyz    # 저장소 연결까지 확인
curl -s http://127.0.0.1:8801/metrics | grep '^trafficgate_'   # 메트릭
```

관리자 작업(세그먼트 생성/변경/삭제/초기화, 로그인 성공/실패)은 사용자 이름과 함께 로그에 남습니다.

```bash
journalctl -u trafficgate | grep -E '세그먼트|로그인'
```

## 2. 이벤트 준비 체크리스트

1. **진입 허용 수 산정**: 백엔드가 버티는 동시 처리량을 부하 테스트로 확인하고 그 70~80% 로 설정
   - `초당 입장 수 ≈ 진입 허용 수 ÷ 평균 체류 시간`
2. **세그먼트 생성**: 오픈 시각(`open_at`), 사전 순번 무작위(`pre_queue_random`), 대기 문구, 종료 시각 설정
3. **연동 확인**: 스테이징에서 `max_active: 0` 으로 대기 화면이 뜨는지, 1 이상으로 올리면 입장하는지 확인
4. **우회 차단**: 중요한 API 에서 통과 토큰 검증(또는 nginx 게이트) 적용 여부 확인
5. **용량 확인**: `trafficgate bench` 로 예상 대기자 수만큼 부하 테스트(아래 4장)
6. **모니터링**: 관리 콘솔/그래프, Prometheus 경보 준비(아래 3장)
7. **비상 수단 숙지**: 관리 콘솔에서 진입 허용 수 즉시 조정, 차단 모드, 입장 일시 정지(0)

이벤트 중 조정 가이드:

| 현상 | 조치 |
| --- | --- |
| 백엔드 응답이 느려짐/오류 증가 | 진입 허용 수를 낮춤 (즉시 반영, 이미 입장한 사용자는 유지) |
| 백엔드 여유, 대기가 길어짐 | 진입 허용 수를 단계적으로 올림 |
| 긴급 점검 | `mode: block` (대기자 포함 모두 차단 안내) 또는 `max_active: 0` (대기열 유지, 입장만 정지) |
| 입장 중 숫자가 줄지 않음 | 슬롯 반환(`complete`) 누락 의심 → 연동 코드 확인, 임시로 `active_ttl_sec` 단축 |
| 대기열이 계속 늘기만 함 | `admit_rate` 확인. 0 이면 진입 허용 수/모드 확인 |

## 3. 모니터링

### 관리 콘솔

세그먼트별 대기·입장·초당 입장·평균 대기·신규 예상 대기 시간과 최근 5분 그래프를 2초마다 갱신합니다.

### Prometheus

```yaml
scrape_configs:
  - job_name: trafficgate
    static_configs:
      - targets: ['10.0.0.11:8801', '10.0.0.12:8801']   # admin.listen 을 내부망에 열었을 때
```

경보 예시:

```yaml
groups:
  - name: trafficgate
    rules:
      - alert: TrafficGateDown
        expr: up{job="trafficgate"} == 0
        for: 1m
      - alert: TrafficGateQueueStuck          # 대기자는 있는데 입장이 멈춤
        expr: max by (segment) (trafficgate_waiting_live) > 0 and max by (segment) (trafficgate_admit_rate) == 0
        for: 2m
      - alert: TrafficGateLongWait
        expr: max by (segment) (trafficgate_eta_seconds) > 900
        for: 5m
      - alert: TrafficGateSlotLeak            # complete 없이 만료되는 비율이 높음
        expr: rate(trafficgate_expired_total[5m]) > 0.5 * rate(trafficgate_admitted_total[5m])
        for: 10m
```

`*_total` 카운터와 대기/입장 수는 클러스터 전체 값이므로 여러 노드를 수집하면 `max by (segment)` 로 묶으세요.
`trafficgate_http_requests_total`, `trafficgate_rate_limited_total` 은 노드별 값이므로 `sum` 합니다.

## 4. 용량 산정

부하는 주로 대기자의 폴링입니다. 서버는 순번에 따라 폴링 간격을 1~10초로 조절합니다(앞 순번일수록 짧게).

```
초당 요청 수 ≈ 대기자 수 ÷ 평균 폴링 간격(약 5~8초) + 신규 진입 수
```

측정값 (TrafficGate 프로세스 2 CPU, 부하 발생기를 같은 머신에서 실행, nginx 미경유):

| 저장소 | 진입 | 폴링 | p99 지연 | 메모리 |
| --- | --- | --- | --- | --- |
| 메모리 | 약 25,000 req/s | 약 27,000 req/s | 약 12ms | 대기자 25만 명에 RSS 약 170MB |
| Redis (노드 1대, Redis 1 CPU) | 약 12,600 req/s | 약 14,500 req/s | 약 14ms | Redis 대기자 1명당 약 380바이트 |

→ 2 CPU 단일 서버에서 평균 5초 간격 폴링 기준 대기자 약 10만 명을 감당합니다. 그 이상은 Redis 모드로 노드를 늘리세요
(Redis 는 단일 스레드이므로 Redis 서버의 CPU 1개 성능이 클러스터 전체 상한입니다).

실제 환경에서 직접 측정하세요.

```bash
# 사용자 5만 명이 초당 2,000명씩 도착, 입장 후 5초 체류
trafficgate bench -url http://127.0.0.1:8800 -segment loadtest -users 50000 -rate 2000 -hold 5s
```

> 한 대의 부하 발생기에서 테스트하면 모든 요청이 같은 IP 이므로 `rate_limit` 에 걸립니다.
> 테스트 전용 세그먼트와 함께, 테스트 동안 `rate_limit.enabled: false` 로 두세요.

## 5. 튜닝

| 항목 | 권장 |
| --- | --- |
| 파일 디스크립터 | systemd 유닛에 `LimitNOFILE=1048576` 기본 설정 |
| 커널 | `install.sh --tune-sysctl` 또는 `deploy/sysctl/90-trafficgate.conf` (somaxconn, 포트 범위, TIME_WAIT 재사용) |
| nginx | upstream `keepalive 128~256`, `proxy_http_version 1.1`, `proxy_set_header Connection ""` (연결 재사용) |
| 폴링 간격 | 서버 부하가 높으면 `queue.max_poll_interval` 을 늘림 (`live_window` 는 그 2배 이상) |
| 이탈 판정 | 모바일 백그라운드 탭을 고려해 `wait_ttl` 은 5분 이상 유지 |
| 접근 로그 | `log.access: false` 유지 (폴링 로그가 매우 많음). 필요하면 nginx 접근 로그 사용 |

## 6. 장애 대응

| 상황 | 영향 | 대응 |
| --- | --- | --- |
| TrafficGate 프로세스 종료 | systemd 가 2초 후 자동 재시작. 메모리 모드는 정상 종료 시 대기열 저장/복원 | `journalctl -u trafficgate` 로 원인 확인 |
| 서버 장애(메모리 모드) | 대기열 유실. JS 에이전트는 연속 실패 시 통과 처리(fail-open), nginx 는 `@tg_bypass` 설정 시 통과 | 이중화가 필요하면 Redis 모드 |
| Redis 장애 | 대기열 API 가 `503`, `/readyz` 실패 → 로드밸런서에서 제외 | Redis Sentinel 로 자동 전환 구성 권장 |
| 노드 1대 장애(Redis 모드) | 다른 노드가 같은 대기열로 계속 서비스 | 로드밸런서 헬스 체크는 `/readyz` 사용 |
| 슬롯이 반환되지 않음 | 입장 중 숫자가 진입 허용 수에 고정 | `active_ttl_sec` 경과 후 자동 반환. 급하면 관리 콘솔 "대기열 초기화" |
| 시계 오차(클러스터) | 만료/이탈 판정 오차 | `chronyc tracking` 확인 |

fail-open(장애 시 통과)과 fail-closed(장애 시 차단)는 서비스 성격에 따라 정하세요. 기본은 서비스 중단을 막는 fail-open 입니다.
JS 에이전트는 `failOpen: false`, nginx 는 `@tg_bypass` 를 빼면 fail-closed 가 됩니다.

## 7. 백업

| 대상 | 방법 |
| --- | --- |
| 설정 | `/etc/trafficgate/config.yaml` (서명 키 포함 — 안전하게 보관) |
| 세그먼트 (메모리 모드) | `/var/lib/trafficgate/segments.json` |
| 세그먼트 (Redis 모드) | `GET /api/segments` 결과 저장, 복원은 `POST /api/segments` |

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8801/api/segments > segments-$(date +%F).json
```

대기열 자체(순번)는 일시적인 데이터이므로 백업하지 않습니다.

## 8. 보안 점검

- [ ] 관리 콘솔(8801)은 로컬 또는 사내망에서만 접근 (방화벽/SSH 터널)
- [ ] 초기 비밀번호 파일 삭제, 관리자 비밀번호 변경
- [ ] `server.cors_origins` 를 실제 웹사이트 주소로 제한
- [ ] `server.trusted_proxies` 에 실제 프록시 대역만 등록 (그 외 `X-Forwarded-For` 는 무시됨)
- [ ] 중요한 API 에 통과 토큰 검증 적용
- [ ] `security.token_secret` 노출 시 교체 (`previous_token_secrets` 로 무중단 교체)
- [ ] HTTPS 사용 (nginx TLS 종료 또는 `server.tls_cert`)
- [ ] `systemd-analyze security trafficgate` 로 서비스 격리 상태 확인

보안 설계 요약:

- 티켓 ID 128비트 난수, 통과 토큰 HMAC-SHA256 서명(세그먼트·만료 시각 포함)
- 관리자 비밀번호 PBKDF2-SHA256(60만 회), 세션 쿠키 HMAC 서명 + HttpOnly + SameSite=Strict, 비밀번호 변경 시 기존 세션 무효화
- 관리 API CSRF 방어(사용자 정의 헤더 + Origin 확인), 로그인 시도 제한, 엄격한 CSP
- 대기 화면 리다이렉트는 같은 사이트 경로만 허용(오픈 리다이렉트 방지), 사용자 입력은 모두 textContent 로 출력
- systemd: 전용 사용자, 권한(capability) 없음, 읽기 전용 파일 시스템, 시스템 콜 필터
