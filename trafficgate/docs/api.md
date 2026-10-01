# API 레퍼런스

## 공개 API (server.listen, 기본 8800)

브라우저 에이전트가 호출하는 API 입니다. 모든 응답은 `Cache-Control: no-store` 이며, 허용된 Origin 에 CORS 헤더가 붙습니다.
대기열 상태 변경 요청은 본문 없는 `POST` 라서 CORS 사전 요청(preflight)이 생기지 않습니다.

### 진입 — `POST /api/v1/segments/{segment}/enter`

쿼리: `info=1`(세그먼트 제목/안내 문구 포함), `set_cookie=1`(통과 시 HttpOnly `tg_<세그먼트>` 쿠키 설정 — 같은 도메인으로 프록시된 경우)

```json
{"status":"WAIT","segment":"event","ticket":"Eq_M4kh_jGhlvHIi7xOOpA","position":128,"behind":3021,
 "waiting":3149,"eta_sec":42,"next_poll_ms":10000}
```

```json
{"status":"PASS","segment":"event","ticket":"Eq_M4kh_jGhlvHIi7xOOpA","waiting":0,"eta_sec":0,
 "active_ttl_sec":30,"waited_ms":41800,"token":"v1.eyJ...","token_ttl_sec":600}
```

### 상태 확인(폴링) — `POST /api/v1/segments/{segment}/tickets/{ticket}/poll`

진입과 같은 형식으로 응답합니다. 차례가 되면 이 요청에서 `PASS` 가 됩니다. 이미 입장한 티켓을 다시 폴링해도 `PASS`.

### 하트비트 — `POST /api/v1/segments/{segment}/tickets/{ticket}/alive`

입장한 티켓의 슬롯 유지 시간을 연장합니다(구간 제어). `{"ok":true}` / `{"ok":false}`(만료됨).

### 완료 — `POST /api/v1/segments/{segment}/tickets/{ticket}/complete`

입장한 티켓의 슬롯을 반환하거나, 대기 중인 티켓의 대기를 취소합니다. `{"ok":true}`.

### 상태 값

| status | 의미 | 클라이언트 동작 |
| --- | --- | --- |
| `PASS` | 입장 허용 (`bypass:true` 면 제어 해제 모드 통과) | `token` 보관 후 진행 |
| `WAIT` | 대기 중. `position`(내 순번), `behind`, `waiting`, `eta_sec`(-1 = 계산 불가) | `next_poll_ms` 후 다시 폴링 |
| `PRE_WAIT` | 오픈 전(사전 대기실). `open_in_ms` | `next_poll_ms` 후 다시 폴링 |
| `BLOCKED` | 차단 모드. `message` | 안내 표시 |
| `CLOSED` | 종료됨(사후 대기실). `message`, `redirect_url` | 안내 표시/이동 |
| `FULL` | 대기열이 가득 참 | `next_poll_ms` 후 다시 진입 |
| `EXPIRED` | 티켓을 찾을 수 없음(오래 폴링하지 않음 등) | 다시 진입 |
| `RATE_LIMITED` (HTTP 429) | IP 별 요청 제한 초과 | `next_poll_ms` 후 재시도 |

HTTP 오류: `400 invalid_ticket`, `404 segment_not_found`, `503 unavailable`(저장소 장애).

### 세그먼트 정보 — `GET /api/v1/segments/{segment}`

```json
{"id":"event","name":"오픈 이벤트","title":"접속 대기 중입니다","message":"...","mode":"queue",
 "open_at":"2026-10-01T10:00:00+09:00","pre_queue_random":true}
```

### 토큰 검증 — `POST /api/v1/verify`

본문: JSON `{"token":"...","segment":"..."}` 또는 폼 `token=...&segment=...` (`segment` 생략 시 세그먼트 확인 안 함)

- `200 {"valid":true,"segment":"event","ticket":"...","expires_at":1790000000}`
- `401 {"valid":false,"error":"invalid|expired|segment_mismatch"}`

### nginx 게이트

| 경로 | 설명 |
| --- | --- |
| `GET /gate/auth[?segment=ID]` | `auth_request` 용. 헤더 `X-Original-URI`. `204` 통과 / `401` 대기 필요. 응답 헤더 `X-TrafficGate-Segment` |
| 아무 경로 + 헤더 `X-TrafficGate-Wait: 1` | 대기 화면 HTML. 세그먼트는 `X-TrafficGate-Segment` 또는 `X-Original-URI` 의 URL 패턴으로 결정. HTML 을 받지 않는 요청(XHR)에는 `429` JSON |
| `GET /gate/wait?segment=ID&return=/path` | 명시적 대기 화면 (`return` 은 같은 사이트 경로만 허용) |

### 기타

| 경로 | 설명 |
| --- | --- |
| `GET /trafficgate.js` | JS 에이전트 (`ETag`, 5분 캐시) |
| `GET /healthz` | 프로세스 생존 확인 |
| `GET /readyz` | 저장소(Redis) 연결까지 확인. 실패 시 `503` — 로드밸런서 헬스 체크에 사용 |

---

## 관리 API (admin.listen, 기본 127.0.0.1:8801)

인증: `Authorization: Bearer <admin.api_tokens 의 토큰>` 또는 관리 콘솔 로그인 세션 쿠키.
세션 쿠키로 변경 요청을 보낼 때는 `X-Requested-With: TrafficGate` 헤더가 필요합니다(CSRF 방어). Bearer 토큰은 필요 없습니다.

```bash
TOKEN=...   # admin.api_tokens
H="Authorization: Bearer $TOKEN"
```

| 메서드 · 경로 | 설명 |
| --- | --- |
| `POST /api/login` `{"username","password"}` | 로그인 (세션 쿠키 발급, IP 당 분당 10회 제한) |
| `POST /api/logout` | 로그아웃 |
| `GET /api/me` | 현재 사용자 |
| `GET /api/system` | 버전, 저장소 상태, 가동 시간 등 |
| `GET /api/stats[?series=0]` | 전체 세그먼트 실시간 통계(+최근 5분 시계열) |
| `GET /api/segments` | 세그먼트 목록 |
| `POST /api/segments` | 세그먼트 생성 (`201`, 중복 `409`) |
| `GET /api/segments/{id}` | 세그먼트 조회 |
| `PUT /api/segments/{id}` | 전체 교체 (보내지 않은 필드는 기본값) |
| `PATCH /api/segments/{id}` | 보낸 필드만 변경 |
| `DELETE /api/segments/{id}` | 삭제 (대기열·통계 포함) |
| `POST /api/segments/{id}/reset` | 대기열과 입장 슬롯 비우기 (누적 통계 유지) |
| `GET /metrics` | Prometheus 메트릭 (`admin.metrics_public: false` 면 인증 필요) |

예시:

```bash
# 이벤트 세그먼트 생성
curl -s -X POST -H "$H" -H 'Content-Type: application/json' http://127.0.0.1:8801/api/segments -d '{
  "id": "event", "name": "오픈 이벤트", "max_active": 300, "active_ttl_sec": 30,
  "url_patterns": ["/event/*"], "open_at": "2026-10-01T10:00:00+09:00", "pre_queue_random": true,
  "title": "오픈 이벤트 대기 중", "message": "순서대로 입장합니다."
}'

# 진입 허용 수 변경 / 차단 / 제어 해제
curl -s -X PATCH -H "$H" http://127.0.0.1:8801/api/segments/event -d '{"max_active": 500}'
curl -s -X PATCH -H "$H" http://127.0.0.1:8801/api/segments/event -d '{"mode": "block", "block_message": "점검 중입니다"}'
curl -s -X PATCH -H "$H" http://127.0.0.1:8801/api/segments/event -d '{"mode": "bypass"}'

# 현재 대기/입장 인원
curl -s -H "$H" 'http://127.0.0.1:8801/api/stats?series=0' | python3 -m json.tool
```

### 세그먼트 필드

| 필드 | 형식 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `id` | 문자열 | 필수 | 영문/숫자/`-`/`_`, 1~64자 |
| `name` | 문자열 | `id` | 표시 이름 |
| `mode` | `queue`/`bypass`/`block` | `queue` | 동작 방식 |
| `max_active` | 정수 ≥ 0 | 0 | 진입 허용 수 (0 = 입장 일시 정지) |
| `active_ttl_sec` | 1~86400 | 30 | 슬롯 자동 반환 시간 |
| `pass_ttl_sec` | 10~604800 | 600 | 통과 토큰 유효 시간 |
| `max_waiting` | 정수 ≥ 0 | 0 | 대기열 최대 인원 (0 = 무제한) |
| `url_patterns` | 문자열 배열 | `[]` | 게이트 URL 패턴 (`*` 는 `/` 포함 임의 문자열) |
| `open_at` / `close_at` | RFC 3339 | 없음 | 사전/사후 대기실 시각 |
| `pre_queue_random` | 불리언 | `false` | 오픈 전 도착자 순번 무작위 |
| `title`, `message`, `block_message`, `closed_message` | 문자열 | — | 대기 화면 문구 |
| `closed_url` | URL 또는 경로 | — | 종료 후 이동 주소 |

---

## Prometheus 메트릭

| 메트릭 | 종류 | 설명 |
| --- | --- | --- |
| `trafficgate_waiting{segment}` | gauge | 대기자 수 |
| `trafficgate_waiting_live{segment}` | gauge | 최근 폴링한 대기자 수 |
| `trafficgate_active{segment}` | gauge | 입장 중 |
| `trafficgate_max_active{segment}` | gauge | 진입 허용 수 |
| `trafficgate_admit_rate{segment}` | gauge | 초당 입장 수(최근 30초) |
| `trafficgate_enter_rate{segment}` | gauge | 초당 신규 진입 수 |
| `trafficgate_avg_wait_seconds{segment}` | gauge | 최근 입장자 평균 대기 시간 |
| `trafficgate_eta_seconds{segment}` | gauge | 신규 진입자 예상 대기 시간 |
| `trafficgate_segment_mode{segment}` | gauge | 0 queue, 1 bypass, 2 block |
| `trafficgate_{entered,admitted,completed,expired,abandoned,cancelled,rejected}_total{segment}` | counter | 누적 (클러스터 전체) |
| `trafficgate_wait_ms_total{segment}` | counter | 입장자 대기 시간 합 |
| `trafficgate_{blocked,closed}_responses_total{segment}` | counter | 이 노드의 차단/종료 응답 수 |
| `trafficgate_rate_limited_total` | counter | 이 노드의 요청 제한 거절 수 |
| `trafficgate_http_requests_total{route,code}` | counter | 이 노드의 HTTP 요청 수 |
| `trafficgate_build_info{version,store}` | gauge | 빌드 정보 |
| `go_goroutines`, `go_memstats_heap_alloc_bytes`, `process_uptime_seconds` | gauge | 프로세스 |
