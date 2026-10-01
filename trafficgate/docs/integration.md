# 연동 가이드

TrafficGate 를 서비스에 붙이는 방법은 세 가지입니다. 목적에 맞게 고르거나 함께 사용합니다.

| 방법 | 코드 수정 | 우회 방지 | 적합한 경우 |
| --- | --- | --- | --- |
| [A. JS 에이전트](#a-js-에이전트) | 페이지에 스크립트 추가 | 토큰 검증을 함께 쓰면 ✓ | 버튼 클릭/주문/결제 같은 "행동" 단위 제어 |
| [B. nginx 게이트](#b-nginx-게이트-코드-수정-없음) | 없음 (nginx 설정만) | ✓ (HttpOnly 쿠키) | 특정 URL 진입 자체를 제어, 레거시 시스템 |
| [C. 백엔드 토큰 검증](#c-백엔드-토큰-검증) | 서버 코드 추가 | ✓ | A 와 함께 중요한 API 를 보호 |

## 핵심 개념

- **세그먼트**: 하나의 대기실. 관리 콘솔에서 만들고 ID(예: `event`)로 참조합니다.
- **진입 허용 수(max_active)**: 동시에 서비스 안에 들어가 있을 수 있는 사용자 수. 초과하면 대기합니다.
- **슬롯 반환**: 작업이 끝나면 `complete` 로 자리를 돌려줘야 다음 대기자가 들어옵니다.
  반환하지 않으면 **슬롯 유지 시간(active_ttl_sec)** 뒤 자동 반환됩니다.
- **통과 토큰**: 입장 시 발급되는 서명 토큰. 유효 시간(pass_ttl_sec) 동안 서버가 "대기열을 거쳐 온 사용자"임을 확인할 수 있습니다.

처리량 계산: `초당 입장 수 ≈ 진입 허용 수 ÷ 평균 체류 시간(초)`.
예) 주문 처리에 평균 5초, 서버가 초당 40건을 감당 → 진입 허용 수 200.

---

## A. JS 에이전트

```html
<script src="https://wait.example.com/trafficgate.js"></script>
```

스크립트 주소에서 대기열 서버 주소를 자동으로 알아냅니다. 다른 주소를 쓰려면 `data-server="https://..."`.
대기열 API 는 CORS 로 호출되므로 설정의 `server.cors_origins` 에 웹사이트 주소를 넣으세요.

### A-1. 기본 제어 (NetFUNNEL nfStart / nfStop 방식)

부하가 큰 작업 **직전**에 대기열을 통과시키고, 작업이 끝나면 슬롯을 반환합니다.

```html
<button id="buy">구매하기</button>
<script>
document.getElementById('buy').addEventListener('click', function () {
  TrafficGate.start('event').then(function (pass) {
    // 통과: 무거운 페이지로 이동하거나 API 호출
    location.href = '/event/buy';
  }).catch(function (err) {
    // err.status: 'BLOCKED' | 'CLOSED' | 'CANCELLED'
  });
});
</script>
```

이동한 페이지에서 로드가 끝나면 슬롯을 반환합니다.

```html
<script src="https://wait.example.com/trafficgate.js" data-complete="event"></script>
<!-- 또는 원하는 시점에: TrafficGate.complete('event'); -->
```

API 호출을 보호하는 경우:

```js
const pass = await TrafficGate.start('order');
try {
  await fetch('/api/order', { method: 'POST', headers: { 'X-TrafficGate-Token': pass.token }, body });
} finally {
  TrafficGate.complete('order');
}
```

### A-2. 코드 없이 링크/버튼에 적용

```html
<a href="/event/buy" data-tg-segment="event">구매하기</a>
<form action="/order" method="post">
  <button type="submit" data-tg-segment="order">주문하기</button>   <!-- 통과 후 폼 제출 -->
</form>
```

### A-3. 페이지 진입 대기

```html
<script src="https://wait.example.com/trafficgate.js" data-segment="event" data-auto="basic"></script>
```

페이지를 열면 대기 화면이 덮이고, 통과 후 페이지 로드가 끝나면 슬롯을 반환합니다.

> 주의: 이 방식은 페이지 HTML 이 이미 서버에서 만들어진 뒤 동작합니다. 페이지 생성 자체가 무거워 서버를 보호해야 한다면
> 이전 페이지의 링크에 A-1/A-2 를 적용하거나 [nginx 게이트](#b-nginx-게이트-코드-수정-없음)를 사용하세요.

### A-4. 구간 제어 (여러 페이지에 걸친 과정)

결제처럼 여러 단계를 거치는 동안 슬롯을 유지합니다. 진행 중에는 하트비트로 슬롯 유지 시간을 연장합니다.

```html
<!-- 구간 시작: 통과 후 슬롯을 계속 유지 -->
<a href="/order/step1" data-tg-segment="order" data-tg-hold="true">주문하기</a>
<!-- 또는 TrafficGate.start('order', { hold: true }) -->

<!-- 중간 페이지들: 슬롯 유지 -->
<script src="https://wait.example.com/trafficgate.js" data-keepalive="order"></script>

<!-- 마지막 페이지(주문 완료): 슬롯 반환 -->
<script src="https://wait.example.com/trafficgate.js" data-complete="order"></script>
```

티켓 정보는 브라우저 탭의 `sessionStorage` 에 저장되므로 같은 탭, 같은 사이트(Origin) 안에서 이어집니다.

### A-5. API 레퍼런스

| 함수 | 설명 |
| --- | --- |
| `TrafficGate.start(segment, options?) → Promise<pass>` | 대기열 진입. 통과하면 `{segment, ticket, token, bypass, waitedMs, failOpen}` 으로 resolve |
| `TrafficGate.complete(segment) → Promise<boolean>` | 슬롯 반환(대기 중이면 대기 취소). `TrafficGate.stop` 과 같음 |
| `TrafficGate.keepAlive(segment) → boolean` | 구간 중간 페이지에서 하트비트 시작 |
| `TrafficGate.token(segment) → string \| null` | 유효한 통과 토큰 |
| `TrafficGate.go(segment, url, options?)` | 통과 후 `url` 로 이동 |
| `TrafficGate.configure(options)` | 전역 옵션 변경 |

`options`:

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `server` | 스크립트 주소 | 대기열 서버 주소 |
| `ui` | `true` | 대기 화면 표시. `false` 면 `onProgress` 로 직접 그리기 |
| `lang` | 페이지 `lang` | `ko` / `en` |
| `color` | `#2563eb` | 대기 화면 강조 색 |
| `hold` | `false` | 구간 제어(통과 후 하트비트로 슬롯 유지) |
| `cookie` | `true` | 통과 시 `tg_<세그먼트>` 쿠키 저장(같은 사이트 백엔드/nginx 검증용) |
| `failOpen` | `true` | 대기열 서버에 연속 4회 연결 실패 시 통과 처리(서비스 중단 방지) |
| `onProgress(r)` | — | 대기 상태 갱신 시 호출 (`r.position`, `r.behind`, `r.eta_sec`, `r.waiting`) |
| `onPass(pass)`, `onBlock(r)`, `onClosed(r)`, `onCancel()`, `onError(err)` | — | 콜백 |

대기 화면 동작:

- 새로고침하거나 같은 탭에서 다시 들어와도 **순번 유지**(sessionStorage)
- 순번이 앞일수록 자주, 뒤일수록 드물게 폴링(서버가 간격 지정)
- 탭이 백그라운드에 있다가 돌아오면 즉시 갱신, 차례가 되면 탭 제목에 "입장 차례입니다" 표시
- 오픈 시각 전에는 카운트다운(사전 대기실), 종료 후에는 종료 안내와 지정 URL 이동(사후 대기실)
- "대기 취소" 버튼, 다크 모드, 모바일 화면, 스크린리더 대응. Shadow DOM 으로 사이트 CSS 와 충돌하지 않음

---

## B. nginx 게이트 (코드 수정 없음)

nginx 의 `auth_request` 로 보호 경로의 모든 요청에서 통과 쿠키를 확인합니다. 쿠키가 없으면 **원래 URL 그대로**
대기 화면을 보여주고, 차례가 되면 HttpOnly 통과 쿠키를 발급한 뒤 같은 URL 을 다시 불러옵니다.

전체 예시: [deploy/nginx/trafficgate-gate.conf](../deploy/nginx/trafficgate-gate.conf)

```nginx
upstream trafficgate { server 127.0.0.1:8800; keepalive 128; }

location ^~ /__tg/ {                          # 대기 화면이 쓰는 에이전트/API
    proxy_pass http://trafficgate/;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location = /__tg_auth {                       # 통과 쿠키 검사
    internal;
    proxy_pass http://trafficgate/gate/auth;  # ?segment=event 로 고정하거나, 생략하면 URL 패턴 매칭
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-URI $request_uri;
}
location @tg_wait {                           # 대기 화면
    proxy_pass http://trafficgate;
    proxy_set_header X-TrafficGate-Wait 1;
    proxy_set_header X-Original-URI $request_uri;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
location /event/ {                            # 보호할 경로
    auth_request /__tg_auth;
    error_page 401 = @tg_wait;
    proxy_pass http://backend;
}
```

세그먼트 결정:

- `auth_request` 주소에 `?segment=ID` 를 붙이면 그 세그먼트로 고정합니다.
- 생략하면 관리 콘솔에서 세그먼트에 지정한 **URL 패턴**(예: `/event/*`, `/goods/*.do`)과 요청 경로를 비교해
  가장 구체적인 세그먼트를 고릅니다. 일치하는 세그먼트가 없으면 통과입니다. → nginx 를 다시 읽지 않고 관리 콘솔에서 제어 경로를 바꿀 수 있습니다.

게이트 모드의 슬롯: 브라우저 페이지 이동만으로는 "작업 끝"을 알 수 없으므로, 입장 후 **슬롯 유지 시간** 동안 슬롯을 점유합니다.
따라서 `초당 입장 수 ≈ 진입 허용 수 ÷ 슬롯 유지 시간` 입니다. 예) 300 ÷ 30초 = 초당 10명.
한 번 통과한 사용자는 통과 토큰 유효 시간(기본 10분) 동안 다시 대기하지 않습니다.

API(XHR/fetch) 요청이 보호 경로에 걸리면 HTML 대신 `429` JSON(`{"status":"WAIT", "wait_url": ...}`)을 돌려줍니다.

장애 시 통과(fail-open): TrafficGate 에 연결할 수 없을 때 대기 없이 통과시키려면 보호 location 에 다음을 추가합니다.

```nginx
error_page 500 502 503 504 = @tg_bypass;   # @tg_bypass 는 backend 로 바로 프록시
```

---

## C. 백엔드 토큰 검증

JS 에이전트만으로는 스크립트를 실행하지 않는 봇이 대기열을 건너뛸 수 있습니다. 중요한 API 는 서버에서 통과 토큰을 확인하세요.
토큰은 `pass.token`(JS) 또는 `tg_<세그먼트>` 쿠키로 전달됩니다.

### C-1. 검증 API

```bash
curl -X POST http://127.0.0.1:8800/api/v1/verify \
  -H 'Content-Type: application/json' \
  -d '{"token":"v1.eyJ...","segment":"order"}'
# 200 {"valid":true,"segment":"order","ticket":"...","expires_at":1790000000}
# 401 {"valid":false,"error":"expired" | "invalid" | "segment_mismatch"}
```

### C-2. 직접 검증 (권장 — 네트워크 호출 없음)

토큰 형식:

```
v1.<payload>.<signature>
payload   = base64url(JSON {"s": 세그먼트, "t": 티켓, "iat": 발급 시각, "exp": 만료 시각})
signature = base64url(HMAC-SHA256(security.token_secret, "v1." + payload))
(base64url 은 패딩 없음)
```

검증 순서: ① `v1` 접두사 확인 ② 서명을 상수 시간 비교 ③ `exp` > 현재 시각 ④ `s` 가 기대한 세그먼트.

예제 코드: [Python](../examples/verify/verify.py) · [Node.js](../examples/verify/verify.js) · [Java](../examples/verify/TrafficGateToken.java)

`token_secret` 을 바꿀 때는 이전 값을 `security.previous_token_secrets` 에 잠시 남겨 두면 이미 발급된 토큰이 계속 유효합니다.

---

## 세그먼트 설계 팁

| 상황 | 권장 설정 |
| --- | --- |
| 한정판/티켓 오픈 | `open_at` 으로 사전 대기실, `pre_queue_random: true` 로 매크로 선점 완화, `max_waiting` 으로 대기열 상한 |
| 수강신청/예약 | 구간 제어(`hold`)로 신청 완료까지 슬롯 유지, `active_ttl_sec` 은 한 단계 최대 소요 시간 × 2 |
| 상시 보호 | 평소에는 `mode: bypass`, 트래픽 급증 시 관리 콘솔에서 `queue` 로 전환 |
| 점검 | `mode: block` + `block_message` |
| 입장 일시 정지 | `max_active: 0` (대기열은 유지, 아무도 입장하지 않음) |
| 이벤트 종료 | `close_at` + `closed_message` + `closed_url` |
