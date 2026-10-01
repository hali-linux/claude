# HAProxy + ModSecurity WAF (Rocky Linux 9)

AWS에서 **Application Load Balancer(ALB)에 AWS WAF Web ACL을 연결**하는 구성을 Rocky Linux 9 서버 한 대에서 그대로 재현합니다.

- **HAProxy** = ALB: TLS 종료, HTTP→HTTPS 리다이렉트, 호스트 기반 라우팅, 대상 그룹 상태 확인, `X-Forwarded-*`
- **ModSecurity v3 + OWASP CRS 4** = AWS WAF: 관리형 규칙(SQLi, XSS, LFI, RCE, 스캐너 등) + 사용자 규칙
- **modsec-spoa** (이 디렉터리의 Go 프로그램): 두 프로그램을 잇는 SPOE 에이전트. ALB가 요청을 AWS WAF에 보내 판정을 받는 것과 같은 방식입니다.

```
                      ┌──────────────────────── HAProxy (≈ ALB) ─────────────────────────┐
 브라우저 ─HTTPS─▶ :443│ TLS 종료 → Web ACL 평가 ──────────────▶ 리스너 규칙(Host) ──▶ 대상 그룹 │──▶ Next.js 앱 :3000
                      │            │  ▲  IP 목록, 국가, 비율 제한,                 (상태 확인)     │
                      │            │  │  크기 제한은 HAProxy가 직접 평가                          │
                      └────────────┼──┼──────────────────────────────────────────────────────────┘
                         SPOE(요청)│  │판정 txn.waf.action=block, rule_id=942100 ...
                                   ▼  │
                      ┌────────────────────── modsec-spoa (≈ AWS WAF) ──────────────────┐
                      │ libmodsecurity v3 + OWASP CRS 4.25 + 사용자 규칙 → 판정, JSON 로그 │
                      └──────────────────────────────────────────────────────────────────┘
```

ModSecurity를 리버스 프록시 앞에 한 겹 더 두는 대신 **HAProxy가 요청을 검사기에 보내고 판정만 받아 집행**하므로, ALB+WAF처럼 차단·카운트 모드 전환, 장애 시 fail-open/closed, 본문 검사 한도 같은 동작을 HAProxy 쪽에서 일관되게 제어할 수 있습니다.

---

## 1. AWS 기능 대응표

| AWS | 이 구성 | 위치 |
| --- | --- | --- |
| ALB HTTP:80 리스너 → HTTPS 301 | `frontend fe_http` | `haproxy/haproxy.cfg` |
| ALB HTTPS:443 리스너 + ACM 인증서 | `frontend fe_https`, `/etc/haproxy/certs/*.pem`(SNI), Let's Encrypt 자동 갱신 | `install.sh --letsencrypt` |
| 보안 정책 `ELBSecurityPolicy-TLS13-1-2-Res-2021-06` | TLS 1.2 이상, AEAD 암호만 | `global` |
| 리스너 규칙(host-header) → 대상 그룹 | `hosts.map` (Host → backend), 없는 Host는 404 | `/etc/haproxy/waf/hosts.map` |
| 대상 그룹 + 상태 확인 | `backend tg_family_photos`, `GET /api/health`, rise/fall, slow start | `haproxy.cfg` |
| least outstanding requests | `balance leastconn` | |
| 대상 등록 해제(deregistration delay) | `wafctl target drain tg_family_photos/app1` | |
| `X-Forwarded-For/Proto/Port`, `X-Amzn-Trace-Id` | 클라이언트 값은 삭제 후 HAProxy가 다시 작성, `X-Request-ID` | |
| `idle_timeout` 60초 | `timeout client 60s` | |
| ALB 접근 로그(S3) | `/var/log/haproxy/access.log` (JSON 한 줄, WAF 판정 포함) | rsyslog |
| CloudWatch 지표 | `http://127.0.0.1:8404/stats`, `/metrics`(Prometheus) | `frontend fe_stats` |
| **Web ACL 연결 / 규칙 동작 Block·Count** | 호스트별 `block` / `count` / `off` | `waf-mode.map`, `wafctl mode` |
| 기본 동작 Allow | 어떤 규칙에도 안 걸리면 통과 | |
| IP set + Allow / Block | `ip-allowlist.lst`, `ip-blocklist.lst` (런타임 추가/삭제) | `wafctl ip ...` |
| AWSManagedRulesAmazonIpReputationList | `ip-reputation.lst` ← Spamhaus DROP, 매일 자동 갱신 | `wafctl update-ipsets` |
| Geo match | `geo_mode` block/allow + `geo-countries.lst` (DB-IP Lite) | `wafctl update-geoip` |
| Rate-based rule (5분 창) | IP당 전체 요청 / 로그인·가입 POST 한도 → 429 | `waf-limits.map` |
| AWSManagedRulesCommonRuleSet / SQLi / Linux / PHP 등 | OWASP CRS 4.25 (PL1, 이상 점수 방식) | `modsecurity/crs-setup.conf` |
| AWSManagedRulesKnownBadInputsRuleSet | Log4Shell(CRS) + Java 역직렬화, Spring4Shell, 취약 경로, Host localhost | `rules.d/before-crs/10-known-bad-inputs.conf` |
| 사용자 정의 규칙 | Next.js 전용 규칙(미들웨어 우회 CVE-2025-29927, 미사용 Server Action·이미지 최적화 차단) | `rules.d/before-crs/20-app-family-photos.conf` |
| 규칙 제외 / Rule action override | `ctl:ruleRemoveTargetById`, `SecRuleRemoveById` | `rules.d/*` |
| 본문 검사 한도 + Oversize handling | 앞 64KB 검사, 넘으면 차단(업로드 경로는 본문 검사만 생략) | `haproxy.cfg [6]`, `body-skip-paths.lst` |
| SizeRestrictions_BODY | 업로드 최대 35MB, 그 외 64KB | `waf-limits.map` |
| 사용자 지정 차단 응답 | 403/429/413/503 한국어 페이지, API는 앱과 같은 `{error, code}` JSON | `haproxy/pages/` |
| Labels | `attack-sqli`, `KnownBadInputs:Spring4Shell` … → 로그, `X-WAF-Labels` 헤더 | |
| Count 모드 + 헤더 삽입 | `X-WAF-Action: block-rules` 헤더로 앱에 전달 | |
| ALB `waf.fail_open.enabled` | `fail_open` (기본 false: 에이전트 장애 시 503) | `waf-settings.map` |
| AWS WAF 로그 (CloudWatch/S3) | `/var/log/modsec-spoa/waf.log` — `terminatingRuleId`, `ruleGroupList`, `labels`, `httpRequest` 형식, 쿠키·인증 헤더·비밀번호 마스킹 | `modsec-spoa` |
| Shield Standard (연결 폭주) | IP당 10초 새 연결 300 / 동시 연결 200 초과 시 TLS 전에 거부 | `haproxy.cfg` |

---

## 2. 디렉터리 구성

```
deploy/haproxy-waf/
├── install.sh                      # Rocky Linux 9 설치 스크립트 (다시 실행해도 안전)
├── haproxy/
│   ├── haproxy.cfg                 # ALB + Web ACL 평가 순서 → /etc/haproxy/haproxy.cfg
│   ├── waf-spoe.conf               # HAProxy ↔ modsec-spoa 연결(SPOE)
│   ├── waf/                        # 운영 중 바뀌는 목록/설정 (wafctl 이 수정) → /etc/haproxy/waf/
│   │   ├── waf-mode.map            #   호스트별 block | count | off
│   │   ├── waf-settings.map        #   fail_open, geo_mode
│   │   ├── waf-limits.map          #   비율 제한, 업로드 최대 크기
│   │   ├── hosts.map               #   Host → 대상 그룹
│   │   ├── ip-allowlist.lst / ip-blocklist.lst / ip-reputation.lst(.sources)
│   │   ├── geo-countries.lst / geoip-country.map
│   │   └── body-skip-paths.lst     #   본문 검사를 생략할 업로드 경로
│   ├── pages/                      # WAF 차단 페이지(요청 ID 표시)
│   └── errors-waf/                 # HAProxy 오류 페이지(502/503/504 등)
├── modsecurity/                    # → /etc/modsec-spoa/
│   ├── main.conf                   # Include 순서 = 규칙 우선순위
│   ├── modsecurity.conf            # 엔진 설정
│   ├── crs-setup.conf              # CRS 설정(편집증 수준, 허용 메서드 등)
│   └── rules.d/before-crs, after-crs
├── spoa/                           # modsec-spoa (Go + cgo, 외부 의존성 없음)
├── bin/wafctl                      # 운영 도구 (≈ aws wafv2 / elbv2 CLI)
├── systemd/  rsyslog/  logrotate/  sysconfig/  certbot/
└── tests/
    ├── waf-smoke-test.sh           # 정상 요청 통과 + 공격 차단을 외부에서 확인
    └── mock-backend.py             # 앱 대신 쓸 수 있는 에코 서버
```

설치 후 경로: 설정 `/etc/haproxy/`, `/etc/modsec-spoa/`, CRS `/usr/share/modsec-spoa/coreruleset-<버전>/`, 로그 `/var/log/haproxy/`, `/var/log/modsec-spoa/`.

---

## 3. 설치 (Rocky Linux 9)

요구 사항: Rocky Linux 9.4 이상(또는 RHEL/AlmaLinux 9), 인터넷 연결(dnf, GitHub), 80/443 포트, 메모리 1GB 이상.

```bash
git clone <이 저장소> && cd <저장소>/deploy/haproxy-waf

# 1) 우선 count 모드로 설치 (차단하지 않고 기록만) — 권장
sudo ./install.sh --domain photos.example.com --targets 127.0.0.1:3000 --mode count

# 2) DNS가 이 서버를 가리키면 Let's Encrypt 인증서 발급까지 한 번에
sudo ./install.sh --domain photos.example.com --mode count --letsencrypt admin@example.com
```

설치 스크립트가 하는 일:

1. EPEL·CRB 활성화, `haproxy`, `golang`, `socat` 등 설치
2. **libmodsecurity**: EPEL 패키지(3.0.8 이상)를 쓰고, 없으면 GitHub 릴리스(SHA-256 검증)로 `/usr/local/modsecurity`에 빌드 (`--modsec-source`로 강제)
3. `modsec-spoa` 빌드 → `/usr/local/bin/modsec-spoa`
4. **OWASP CRS 4.25.0** 다운로드 + GPG 서명 검증 (`CRS_SHA256=` 또는 `--crs-tarball`로 오프라인 설치 가능)
5. 설정 설치(기존 `haproxy.cfg`는 `haproxy.cfg.orig-<시각>`으로 백업), 도메인·대상 반영, IPv6가 없으면 IPv6 리스너 비활성화
6. 인증서가 없으면 임시 자체 서명 인증서 생성
7. rsyslog(`/var/log/haproxy/access.log`), logrotate, systemd 유닛(`modsec-spoa`, HAProxy 의존성, IP 평판 갱신 타이머)
8. **SELinux**: `haproxy_connect_any` 허용, 통계(8404)·peers(12346) 포트 라벨, `restorecon`
9. **firewalld**: http/https 허용
10. 규칙·설정 검증 후 서비스 시작, IP 평판 목록 첫 갱신

다시 실행하면 사용자가 고친 설정은 덮어쓰지 않고 `*.new` 파일로 옆에 둡니다(`--overwrite-config`로 덮어쓰기). `/etc/haproxy/waf/`의 목록·맵은 운영 상태이므로 처음에만 설치합니다.

### 앱 설정 (필수)

앱(`.env`)이 HAProxy 뒤에 있다는 것을 알려야 Rate Limit, CSRF 검사, Secure 쿠키가 올바르게 동작합니다.

```bash
APP_URL=https://photos.example.com
TRUST_PROXY=true        # X-Forwarded-For 사용 (HAProxy가 클라이언트 값을 지우고 새로 씀)
APP_BIND=127.0.0.1      # docker compose: 앱 포트를 localhost에만 공개
```

> **WAF 우회 주의**: 앱 포트(3000)가 외부에 열려 있으면 HAProxy/WAF를 거치지 않고 직접 접속할 수 있습니다. Docker가 공개한 포트는 **firewalld 규칙을 우회**하므로 `APP_BIND=127.0.0.1`을 꼭 설정하세요. 앱을 다른 서버에 둘 때는 그 서버의 3000 포트를 HAProxy 서버 IP에서만 허용하세요.

### 동작 확인

```bash
wafctl status                                                   # 에이전트·대상·모드·설정
./tests/waf-smoke-test.sh -k -r 127.0.0.1 https://photos.example.com   # block 모드에서 실행
tail -f /var/log/haproxy/access.log | jq -c '{status,uri,waf_action,waf_rule,waf_labels}'
```

`waf-smoke-test.sh`는 정상 요청 15종(한글 검색, Next.js RSC 이동, 따옴표가 든 비밀번호, 업로드 등)이 통과하고 공격 22종과 본문 검사 우회 시도 3종이 차단되는지 확인합니다. 앱이 없을 때는 `python3 tests/mock-backend.py`를 3000 포트에 띄워 WAF만 시험할 수 있습니다.

---

## 4. 요청 처리 순서 (Web ACL)

`haproxy.cfg`의 `fe_https`에서 위에서 아래로 평가하며, **처음 일치한 규칙**이 `txn.waf_action`에 기록됩니다.

| 순서 | 규칙 | 일치 시 동작 (`waf_action`) | 응답 |
| --- | --- | --- | --- |
| 0 | 호스트별 모드 (`waf-mode.map`) | `off`면 이후 전부 생략 | – |
| 1 | IP 허용 목록 | `allow-ipset`, 이후 규칙·비율 제한 생략 | 통과 |
| 2 | IP 차단 목록 | `block-ipset` | 403 |
| 3 | IP 평판 목록 | `block-reputation` | 403 |
| 4 | 국가 규칙 | `block-geo` | 403 |
| 5 | 비율 기반(로그인 POST → 전체) | `block-rate-auth`, `block-rate` | 429 |
| 6 | 크기 제한 | `block-size`, `block-oversize` | 413 |
| 7 | 관리형 규칙(ModSecurity) | `block-rules`, `redirect` | 403 |
| – | 에이전트 장애 | `error` (fail-closed) / `error-fail-open` | 503 / 통과 |
| – | 어디에도 해당 없음 | `allow` | 통과 |

- **block 모드**: 마지막 "적용" 블록에서 차단합니다. 차단이 정해지면 ModSecurity 검사는 생략합니다.
- **count 모드**: 모든 규칙을 평가하고 로그(`waf_mode=count`)와 `X-WAF-Action` 헤더만 남깁니다.
- API 경로(`/api/`)의 차단 응답은 앱과 같은 JSON(`{"error":"…","code":"WAF_BLOCKED","requestId":"…"}`)이라 화면에 토스트로 표시됩니다.

### 본문 검사와 우회 방지

AWS WAF처럼 본문 **앞부분(64KB)** 만 검사합니다. 검사기가 본문 전체를 확인할 수 없는 요청은 우회 시도로 보고 차단합니다(OversizeHandling = MATCH).

- 본문이 64KB를 넘음 → 413
- 헤더를 부풀려 본문 일부만 버퍼에 들어오게 함 → 413
- `Content-Length` 없이(chunked 등) 본문을 보냄 → 413 (브라우저 fetch는 항상 길이를 보냄)
- **예외**: `body-skip-paths.lst`의 업로드 경로(`/api/photos/upload`)는 본문(사진)만 검사하지 않고 헤더·URI·쿼리는 검사하며, 크기는 `max_upload_bytes`(35MB)로 제한합니다. 업로드 파일 자체는 앱이 매직 바이트·디코딩으로 검증합니다.

---

## 5. 운영 (wafctl)

`wafctl`은 HAProxy 런타임 API로 **재시작 없이** 바꾸고, 같은 내용을 파일에도 저장해 재시작 후에도 유지합니다.

```bash
# 모드 전환 (Web ACL 규칙 동작 Count ↔ Block)
wafctl mode photos.example.com count
wafctl mode photos.example.com block

# IP set
wafctl ip block 203.0.113.50          # CIDR 가능: 203.0.113.0/24
wafctl ip unblock 203.0.113.50
wafctl ip allow 198.51.100.7          # 사무실/모니터링 등 (모든 WAF 규칙 생략)
wafctl ip list block

# 설정
wafctl settings
wafctl set fail_open true             # 에이전트 장애 시에도 통과 (가용성 우선)
wafctl set rate_limit_ip 10000
wafctl set rate_limit_auth 20

# 비율 제한 현황 / 초기화
wafctl rate
wafctl rate reset 203.0.113.50

# 대상 그룹 (무중단 배포: drain → 배포 → ready)
wafctl targets
wafctl target drain tg_family_photos/app1
wafctl target ready tg_family_photos/app1

# WAF 로그 요약 (차단 규칙·라벨·IP·URI 상위 + 최근 이벤트)
wafctl events --since 24h --blocked

# 목록 갱신 (타이머가 자동 실행)
wafctl update-ipsets
wafctl update-geoip
```

### 규칙 변경

```bash
sudo vi /etc/modsec-spoa/rules.d/before-crs/20-app-family-photos.conf
sudo systemctl reload modsec-spoa      # 규칙 검사 후 무중단 교체. 잘못된 규칙이면 reload가 실패하고 기존 규칙 유지
sudo systemctl reload haproxy          # haproxy.cfg 변경 시 (haproxy -c 검사 후 무중단 reload)
```

### 오탐(false positive) 튜닝 절차

1. `count` 모드로 1~2주 운영합니다.
2. `wafctl events --since 7d --blocked`로 자주 걸리는 규칙(`terminatingRuleId`, `nonTerminatingMatchingRules`)과 경로를 봅니다. 사용자가 차단 페이지의 **요청 ID**를 알려주면 `grep <요청ID> /var/log/modsec-spoa/waf.log | jq`로 원인 규칙과 변수(`ARGS:json.description` 등)를 찾습니다.
3. 가능한 한 좁게 예외를 둡니다 — 경로 + 규칙 + 변수:
   ```
   SecRule REQUEST_FILENAME "@rx ^/api/photos/[a-z0-9]+$" \
       "id:10150,phase:1,pass,nolog,t:none,ctl:ruleRemoveTargetById=942100;ARGS:json.description"
   ```
4. `systemctl reload modsec-spoa` 후 `block` 모드로 전환합니다.

이미 들어 있는 앱 전용 예외: 로그인·가입·비밀번호 변경의 비밀번호 필드는 CRS 검사에서 제외합니다(사용자가 `' OR 1=1` 같은 문자를 비밀번호로 써도 로그인 가능). 앱은 Prisma 파라미터 바인딩과 bcrypt만 쓰므로 이 값이 쿼리나 HTML로 가지 않습니다.

---

## 6. 로그

### 접근 로그 (`/var/log/haproxy/access.log`, ≈ ALB access log)

```json
{"time":"01/Oct/2026:14:09:58 +0000","listener":"https","client_ip":"203.0.113.9","country":"KR","host":"photos.example.com",
 "method":"GET","uri":"/api/photos?q=...","proto":"HTTP/2.0","status":403,"request_ms":5,"target_ms":-1,"total_ms":6,
 "target_group":"tg_family_photos","target":"<NOSRV>","tls":"TLSv1.3","request_id":"91286482-dd69-...",
 "waf_mode":"block","waf_action":"block-rules","waf_rule":"949110","waf_rules":"942100,942190",
 "waf_labels":"attack-sqli","waf_score":"10","waf_body":"none","waf_ms":"4"}
```

시작/중지, 대상 상태 변화, SPOE 오류는 `/var/log/haproxy/admin.log`에 남습니다.

### WAF 로그 (`/var/log/modsec-spoa/waf.log`, ≈ AWS WAF logs)

규칙에 하나라도 걸린 요청만 기록합니다(`/etc/sysconfig/modsec-spoa`의 `-waf-log-allowed`로 전체 기록).

```json
{"timestamp":1790863804203,"webaclId":"haproxy-modsecurity","terminatingRuleId":"949110",
 "terminatingRuleType":"MANAGED_RULE_GROUP","action":"BLOCK","mode":"block","httpSourceId":"photos.example.com",
 "ruleGroupList":[{"ruleGroupId":"OWASP_CRS",
   "terminatingRule":{"ruleId":"949110","action":"BLOCK","msg":"Inbound Anomaly Score Exceeded (Total Score: 10)"},
   "nonTerminatingMatchingRules":[{"ruleId":"942100","action":"COUNT","msg":"SQL Injection Attack Detected via libinjection",
     "data":"Matched Data: sUEnk found within ARGS:q: ...","severity":"CRITICAL","tags":["attack-sqli","paranoia-level/1"]}]}],
 "labels":[{"name":"attack-sqli"}],"anomalyScore":10,"requestBodySize":0,"bodyInspection":"none",
 "httpRequest":{"clientIp":"203.0.113.9","headers":[{"name":"cookie","value":"[REDACTED]"}],
   "uri":"/api/photos","args":"q=...","httpVersion":"HTTP/2.0","httpMethod":"GET","requestId":"91286482-dd69-..."}}
```

- `action`: `BLOCK`, `COUNT`(count 모드에서 차단 대상이었음), `ALLOW`, `ERROR`
- 개인정보 보호: `Cookie`·`Authorization` 헤더 값과, 쿠키·비밀번호·토큰 변수를 인용한 `data`는 `[REDACTED]`로 기록합니다. 요청 본문은 기록하지 않습니다(ModSecurity 감사 로그는 꺼 둠).
- 두 로그 모두 30일 보관(logrotate), 요청 ID로 서로 연결됩니다.

---

## 7. 장애 대응 (fail-open / fail-closed)

| 상황 | 동작 |
| --- | --- |
| 에이전트 중지·응답 없음 (`fail_open false`, 기본) | 1초(`timeout processing`) 후 503, 상태 확인이 에이전트를 DOWN으로 표시하면 즉시 503 |
| 같은 상황 (`fail_open true`) | 검사 없이 통과, `waf_action=error-fail-open`으로 기록 |
| 검사 요청이 SPOE 프레임보다 큼 | `fail_open`과 무관하게 413 (우회 시도로 간주) |
| 규칙 파일 오류로 reload | reload 실패, 기존 규칙으로 계속 동작 |
| 에이전트 비정상 종료 | systemd가 2초 후 재시작 (`Restart=on-failure`) |

가족 사진처럼 보안이 우선이면 기본값(fail-closed)을, 가용성이 우선이면 `wafctl set fail_open true`를 쓰세요.

---

## 8. AWS와 다른 점 / 한계

- **CAPTCHA·Challenge, Bot Control, ATP(계정 탈취 방지)** 동작은 없습니다. 비율 제한과 CRS 스캐너 탐지(913xxx)로 일부 대신합니다.
- **IP 평판**은 Spamhaus DROP(범죄 조직 장악 대역)만 씁니다. Amazon 위협 인텔리전스만큼 넓지 않습니다. 다른 목록을 쓰려면 `ip-reputation.sources`에 URL을 추가하세요(사설망·지나치게 넓은 대역은 자동 제외).
- **국가 데이터**는 DB-IP Lite(CC BY 4.0, "IP Geolocation by DB-IP")입니다. 메모리를 아끼려고 `geo-countries.lst`의 국가 대역만 적재합니다(`--all`로 전체).
- **단일 서버**: HAProxy·에이전트가 한 대에 있습니다. 이중화하려면 서버 두 대 + keepalived(VRRP) 가상 IP와 `peers`에 상대 서버를 추가하세요. 에이전트는 상태가 없어 HAProxy `backend spoe_modsecurity`에 여러 대를 둘 수 있습니다.
- 응답 본문은 검사하지 않습니다(ALB용 AWS WAF와 동일).
- HAProxy 2.4는 연결 단계에서 변수를 쓸 수 없어 연결 한도(10초 300 / 동시 200)는 `haproxy.cfg`에서 직접 바꿉니다.
- **ModSecurity 파서 주의**: 주석·빈 줄을 모두 지운(minified) CRS 사본은 libmodsecurity 3.0.12~3.0.16에서 "Expecting an action" 오류가 납니다. 반드시 공식 CRS 릴리스를 그대로 쓰세요(설치 스크립트가 그렇게 합니다).

---

## 9. 검증한 내용

이 구성은 아래 환경에서 실제로 실행해 확인했습니다.

| 항목 | 결과 |
| --- | --- |
| `haproxy -c` 설정 검사 | HAProxy 2.4.36(Rocky 9 계열), 2.8.16, 3.0.29, 3.2.25 통과 |
| 스모크 테스트(정상 15 + 공격 22 + 우회 3 + 413/429) | HAProxy 2.4 / 2.8 / 3.2 × libmodsecurity 3.0.12 / 3.0.16 × CRS 4.25.0 모두 통과 |
| systemd 환경 | `install.sh` 전체 실행(재실행 시 변경 없음), `Type=notify` 기동, 잘못된 규칙 reload 시 기존 규칙 유지, logrotate 후 로그 재오픈, HAProxy reload 후 비율 카운터 유지 |
| 운영 | count/off 모드, IP 차단·허용, 국가 allow/block, 평판 목록(빈 피드는 기존 목록 유지), fail-open/closed, 대상 drain |
| 부하 중 규칙 교체 | 8개 연결로 2,400요청 처리 중 5회 reload → 오류 0 |
| 에이전트 단위 테스트 | `cd spoa && make test` (SPOP 프로토콜, ModSecurity 바인딩, 판정·로그 마스킹, `-race`) |

검증하지 못한 부분: 작업 환경에서 Rocky/EPEL 미러와 GitHub에 접속할 수 없어 **`dnf` 설치 단계, EPEL `libmodsecurity` 패키지, CRS GPG 서명 다운로드, SELinux·firewalld 설정은 실제 Rocky 9에서 실행해 보지 못했습니다.** (같은 단계를 Ubuntu 24.04 systemd 컨테이너에서 `--skip-packages`로 실행해 나머지 흐름을 확인했습니다.) 처음 설치할 때는 `--mode count`로 시작해 `wafctl status`와 스모크 테스트로 확인한 뒤 `block`으로 바꾸세요.

---

## 10. 제거

```bash
sudo systemctl disable --now modsec-spoa waf-update-ipsets.timer waf-update-geoip.timer
sudo rm -f /etc/systemd/system/{modsec-spoa.service,waf-update-*.{service,timer}} /etc/systemd/system/haproxy.service.d/10-waf.conf
sudo cp /etc/haproxy/haproxy.cfg.orig-* /etc/haproxy/haproxy.cfg && sudo systemctl daemon-reload && sudo systemctl restart haproxy
sudo rm -rf /etc/modsec-spoa /usr/share/modsec-spoa /usr/local/bin/{modsec-spoa,wafctl} /etc/rsyslog.d/49-haproxy-waf.conf /etc/logrotate.d/haproxy-waf
```
