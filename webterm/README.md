# WebTerm — Rocky Linux 9 용 웹 터미널 (CloudShell 스타일)

브라우저만 있으면 서버의 셸을 쓸 수 있는 웹 터미널입니다. AWS CloudShell 처럼
로그인하면 바로 터미널이 열리고, 탭을 여러 개 띄우거나 파일을 올리고 받을 수 있습니다.

- **Apache httpd** 가 HTTPS 와 WebSocket 을 받아 내부 서비스로 프록시합니다.
- 로그인은 **서버 계정(PAM)** 으로 합니다. `/etc/shadow` 계정은 물론, SSSD 로 연동된 LDAP/AD 계정도 됩니다.
- 로그인한 사용자 **본인 권한의 로그인 셸**(`runuser -l`, `su -` 와 같은 방식)이 열립니다.

## 주요 기능

| 기능 | 설명 |
| --- | --- |
| 터미널 | xterm.js 기반, 256색/트루컬러, 마우스, 한글 입출력, 창 크기 자동 조절 |
| 여러 탭 | 탭마다 독립된 셸 (기본 최대 6개), 탭 제목은 셸이 설정한 제목(`user@host:dir`) |
| 끊김 없는 세션 | 새로고침하거나 네트워크가 끊겨도 셸은 서버에서 계속 실행되고, 다시 연결하면 **놓친 출력까지 이어서** 보여 줍니다 (기본 15분 유지) |
| 파일 업로드 | 여러 파일, 드래그 앤 드롭(터미널 위에 놓기), 진행률, 덮어쓰기 확인, 업로드 위치 지정 |
| 파일 다운로드 | 경로를 입력해 내려받기 (`~/` = 홈 디렉터리) |
| 자동 로그아웃 | 입력이 없으면 1시간 뒤 종료, 2분 전에 경고 배너 표시 |
| 설정 | 글꼴 크기, 다크/라이트/시스템 테마, 커서 모양 (브라우저에 저장) |
| 단축키 | `Ctrl+Shift+C/V` 복사/붙여넣기, `Alt+Shift+N` 새 탭, `Alt+Shift+←/→` 탭 이동, `Alt+Shift+W` 탭 닫기 |

## 구조

```
 브라우저 ──HTTPS/WSS──▶ httpd :443 (mod_ssl, mod_proxy_wstunnel)
                           │  http://127.0.0.1:8022
                           ▼
                  webterm.service        ← 비특권 사용자 "webterm", systemd 샌드박스
                  (aiohttp: UI, 세션, WebSocket ↔ PTY 중계)
                           │  Unix 소켓 /run/webterm/helper.sock (0660 root:webterm)
                           ▼
                  webterm-helper.service ← root, 표준 라이브러리만 사용
                  (PAM 인증, runuser -l 로 셸 생성, 사용자 권한으로 파일 전송)
                           │  PTY master fd 를 SCM_RIGHTS 로 전달
                           ▼
                  사용자 로그인 셸 (bash, 사용자 권한)
```

인터넷에 노출되는 웹 서버는 **root 가 아닌** 전용 계정으로 동작하고, root 권한이
필요한 일(비밀번호 확인, 다른 사용자로 셸 실행)은 작은 헬퍼가 따로 처리합니다.

### 보안 설계

- **HTTPS 강제**: HTTP 는 HTTPS 로 리다이렉트, HSTS 헤더
- **권한 분리**: 웹 서버는 권한 없음(`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, 시스템 콜 필터 등). 헬퍼는 로그인에 성공한 사용자에게만 발급한 토큰으로만 셸/파일 작업을 수행하며, 소켓에 연결한 프로세스의 UID 도 검사합니다(`SO_PEERCRED`).
- **로그인 정책**: `webterm-users` 그룹 구성원만 허용, root(UID 0) 로그인 차단, 로그인 셸이 없는 계정(`nologin`) 차단, PAM 계정 검사(만료·잠금·`/etc/nologin`)
- **무차별 대입 방지**: IP·사용자 이름별로 10분 안에 5회 실패하면 15분 차단. 존재하지 않는/허용되지 않은 계정도 동일한 응답과 비슷한 지연 시간
- **세션**: 256비트 임의 세션 ID, `HttpOnly; Secure; SameSite=Strict` 쿠키, 서버 메모리에만 저장, 유휴/최대 수명 만료
- **CSRF·교차 출처 차단**: 상태를 바꾸는 요청과 WebSocket 은 `Origin` 검사 + CSRF 토큰, `Sec-Fetch-Site: cross-site` 거부
- **브라우저 보안 헤더**: 엄격한 CSP(외부 스크립트·인라인 스크립트·eval 불가), `frame-ancestors 'none'`, `nosniff`, `no-referrer`
- **파일 전송**: 헬퍼가 로그인한 사용자 권한(setuid)으로 작업 프로세스를 실행하므로, 셸에서 할 수 없는 일은 업로드/다운로드로도 할 수 없습니다. 업로드는 임시 파일에 받은 뒤 완료 시에만 원자적으로 바꿔치기합니다.
- **터미널 출력 속 링크**: `http(s)` 링크만 새 탭(`noopener`)으로 열고, 숨은 링크(OSC 8)는 열기 전에 확인
- **감사 로그**: 로그인 성공/실패(원격 IP 포함), 셸 시작/종료, 파일 업로드/다운로드가 journald 에 기록되고, PAM(`pam_unix`) 로그는 `/var/log/secure` 에 `rhost=` 와 함께 남습니다.

## 설치 (Rocky Linux 9)

요구 사항: Rocky Linux 9 (RHEL/AlmaLinux 9 호환), root 권한, 인터넷(패키지 설치용 — 오프라인 설치는 아래 참고).

```bash
sudo dnf -y install git
git clone <이 저장소 URL> webterm-src
cd webterm-src/webterm

# 도메인(또는 서버 IP)과 로그인을 허용할 사용자를 지정해 설치
sudo ./deploy/install.sh --server-name shell.example.com --add-user alice
```

설치가 끝나면 브라우저에서 `https://shell.example.com/` 로 접속해 `alice` 계정으로 로그인합니다.
자체 서명 인증서를 쓰는 동안은 브라우저 경고가 뜹니다(아래 “정식 인증서” 참고).

### install.sh 가 하는 일

1. `httpd`, `mod_ssl`, `openssl`, `policycoreutils-python-utils`, `python3.12`(없으면 `python3.11`) 설치
2. 시스템 사용자 `webterm`, 로그인 허용 그룹 `webterm-users` 생성 (`--add-user` 로 지정한 사용자를 그룹에 추가)
3. `/opt/webterm` 에 애플리케이션과 Python 가상환경(aiohttp) 설치
4. `/etc/webterm/webterm.conf`(설정), `/etc/pam.d/webterm`(PAM) 생성 — 이미 있으면 유지
5. SELinux: 내부 포트(8022)를 `http_port_t` 로 등록, `httpd_can_network_relay` 켜기
6. systemd 서비스 `webterm-helper`, `webterm` 등록 및 시작
7. TLS 인증서가 없으면 자체 서명 인증서 생성 (`/etc/pki/tls/certs/webterm.crt`)
8. `/etc/httpd/conf.d/webterm.conf` 가상 호스트 생성 → `httpd -t` 검사 → httpd 시작
9. firewalld 가 켜져 있으면 http/https 허용
10. 서비스와 HTTPS 프록시 동작 확인

| 옵션 | 설명 |
| --- | --- |
| `--server-name NAME` | 접속 도메인 또는 IP (기본: `hostname -f`) |
| `--port PORT` | 내부 웹 서버 포트 (기본 8022) |
| `--cert FILE --key FILE` | 사용할 TLS 인증서/개인 키 (PEM) |
| `--add-user USER` | 로그인 허용 그룹에 추가 (여러 번 사용 가능) |
| `--python PATH` | Python 3.11+ 경로 지정 |
| `--wheelhouse DIR` | 오프라인 설치용 wheel 디렉터리 |
| `--no-firewall` | firewalld 를 건드리지 않음 |

> 이 스크립트는 전용 가상 호스트(`*:80`, `*:443`)를 만들기 때문에 **httpd 의 기본 사이트가 됩니다.**
> 이미 다른 웹사이트를 운영 중인 서버라면 아래 “기존 웹사이트의 하위 경로에 붙이기”를 참고하세요.

### 업그레이드 / 제거

```bash
cd webterm-src && git pull && cd webterm
sudo ./deploy/install.sh            # 설정·인증서·서버 이름은 그대로 유지됩니다

sudo ./deploy/uninstall.sh          # 서비스·프로그램 제거 (설정/인증서/계정 유지)
sudo ./deploy/uninstall.sh --purge  # 설정, 인증서, webterm 계정/그룹까지 삭제
```

업그레이드 시 `webterm` 서비스가 재시작되므로 열려 있던 터미널은 종료됩니다.

### 오프라인 설치

인터넷이 되는 Rocky Linux 9 에서 wheel 을 받아 함께 복사합니다.

```bash
python3.12 -m pip download -r requirements.txt -d wheelhouse
# 대상 서버에서 (httpd, mod_ssl, python3.12 등은 로컬 저장소/ISO 로 설치)
sudo ./deploy/install.sh --wheelhouse ./wheelhouse --server-name 10.0.0.5
```

## 사용자 관리

```bash
sudo usermod -aG webterm-users bob       # 로그인 허용 (즉시 적용)
sudo gpasswd -d bob webterm-users        # 허용 해제 (새 로그인부터 적용)
```

root 로 직접 로그인할 수는 없습니다(기본값). 일반 계정으로 로그인한 뒤 `sudo` 를 사용하세요.

## 정식 인증서 (Let's Encrypt)

도메인이 서버를 가리키고 80 포트가 열려 있다면:

```bash
sudo dnf -y install epel-release
sudo dnf -y install certbot
sudo certbot certonly --webroot -w /var/www/html -d shell.example.com \
     --deploy-hook "systemctl reload httpd"

sudo ./deploy/install.sh --server-name shell.example.com \
     --cert /etc/letsencrypt/live/shell.example.com/fullchain.pem \
     --key  /etc/letsencrypt/live/shell.example.com/privkey.pem
```

HTTP 가상 호스트는 `/.well-known/acme-challenge/` 경로만 리다이렉트하지 않으므로 자동 갱신도 그대로 동작합니다.
사내 CA 인증서도 같은 방법(`--cert/--key`)으로 적용합니다.

## 설정

`/etc/webterm/webterm.conf` 를 수정한 뒤 `sudo systemctl restart webterm-helper webterm` 으로 적용합니다.

| 항목 | 기본값 | 설명 |
| --- | --- | --- |
| `[web] title` | `WebTerm` | 화면에 표시되는 이름 |
| `[web] login_notice` | 안내문 | 로그인 화면 하단 문구 |
| `[web] session_idle_timeout` | `3600` | 입력이 없을 때 로그아웃까지 시간(초), `0` = 사용 안 함 |
| `[web] session_max_lifetime` | `43200` | 로그인 최대 유지 시간(초) |
| `[web] detach_timeout` | `900` | 브라우저가 끊긴 뒤 셸을 유지하는 시간(초) |
| `[web] max_terminals` | `6` | 로그인당 최대 탭 수 |
| `[web] max_upload_bytes` | `1073741824` | 업로드 최대 크기 (변경 후 `install.sh` 재실행 시 httpd 에도 반영) |
| `[web] login_max_failures` / `login_lockout` | `5` / `900` | 로그인 실패 제한 |
| `[web] cookie_path` | `/` | 하위 경로에 배치할 때 그 경로 |
| `[web] allowed_origins` | (비움) | 여러 도메인으로 접속한다면 허용할 Origin 목록 |
| `[helper] allowed_groups` | `webterm-users` | 로그인 허용 그룹 (쉼표로 여러 개) |
| `[helper] denied_users` | `root` | 로그인 금지 사용자 |
| `[helper] allow_root` | `no` | UID 0 로그인 허용 여부 |
| `[helper] lang` | (비움) | 셸의 LANG. 한글이 깨지면 `ko_KR.UTF-8` 또는 `C.UTF-8` |

접속 가능한 네트워크를 제한하려면 `/etc/httpd/conf.d/webterm.conf` 의 `Require ip` 예시 주석을 해제하세요.

## 기존 웹사이트의 하위 경로(`/webterm/`)에 붙이기

`install.sh` 로 설치한 뒤 `/etc/httpd/conf.d/webterm.conf` 를 지우고(또는 이름을 `.disabled` 로 바꾸고),
운영 중인 HTTPS 가상 호스트 안에 다음을 넣습니다.

```apache
ProxyPreserveHost On
RequestHeader set X-Forwarded-Proto "https"
RedirectMatch 301 "^/webterm$" "/webterm/"
ProxyPass        "/webterm/ws/" "ws://127.0.0.1:8022/ws/" timeout=3600
ProxyPass        "/webterm/"    "http://127.0.0.1:8022/" timeout=300
ProxyPassReverse "/webterm/"    "http://127.0.0.1:8022/"
```

그리고 `/etc/webterm/webterm.conf` 에서 `cookie_path = /webterm/` 로 바꾼 뒤
`sudo systemctl restart webterm && sudo systemctl reload httpd`.
(같은 도메인의 다른 웹 애플리케이션에 취약점이 있으면 WebTerm 세션도 위험해질 수 있으므로,
가능하면 전용 서브도메인을 권장합니다.)

## 운영

```bash
systemctl status webterm webterm-helper httpd
journalctl -u webterm -u webterm-helper -f      # 로그인/세션/파일 전송 로그
tail -f /var/log/httpd/webterm_access.log /var/log/httpd/webterm_error.log
grep webterm /var/log/secure                    # PAM 인증 로그
```

로그 예:

```
webterm-helper: authentication failure; user=alice rhost=203.0.113.7 pam=Authentication failure
webterm-helper: authentication refused; user=bob rhost=203.0.113.7 reason=not a member of webterm-users
webterm-helper: session start; user=alice rhost=203.0.113.7 pid=4242
webterm-helper: file upload dir='~' name='data.csv' size=1048576; user=alice rhost=203.0.113.7 status=0
```

## 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| `503 Service Unavailable` | `systemctl status webterm` · SELinux 거부 여부 `sudo ausearch -m avc -ts recent` (필요하면 `sudo setsebool -P httpd_can_network_connect 1`) |
| 로그인이 계속 실패 | 사용자가 `webterm-users` 그룹인지(`id alice`), 로그인 셸이 `nologin` 이 아닌지, `journalctl -u webterm-helper` 의 `reason=` |
| “인증 서비스에 연결할 수 없습니다” | `systemctl status webterm-helper`, `/run/webterm/helper.sock` 존재 여부 |
| “로그인 실패가 너무 많습니다” | 15분 후 재시도하거나 `systemctl restart webterm` (모든 세션 종료됨) |
| 한글이 깨지거나 입력이 이상함 | 셸에서 `locale` 확인 → `[helper] lang = ko_KR.UTF-8` (`dnf install glibc-langpack-ko`) |
| 연결이 자주 끊김 | 중간 프록시/방화벽의 유휴 시간 제한 확인. 브라우저는 25초마다 ping 을 보내고 끊기면 자동 재연결합니다 |
| 브라우저 인증서 경고 | 자체 서명 인증서 사용 중 → Let's Encrypt 또는 사내 CA 인증서 적용 |

## 개발 · 테스트

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -t .
```

테스트는 root 없이도 돌아가도록, 헬퍼의 root 전용 부분(PAM, `runuser`, setuid)만 대체하고
실제 Unix 소켓·fd 전달·웹 서버·WebSocket·파일 전송 경로를 그대로 사용합니다.

```
webterm/
├── webterm/
│   ├── web.py            웹 서버 (aiohttp): UI, 로그인 세션, WebSocket, 파일 API
│   ├── terminal.py       PTY 입출력, 스크롤백 버퍼, 재접속 시 이어 보기
│   ├── helper.py         root 헬퍼: PAM 인증, 로그인 정책, 셸 생성, 파일 작업
│   ├── helper_client.py  웹 서버 → 헬퍼 통신 (SCM_RIGHTS 로 fd 수신)
│   ├── fileops.py        사용자 권한으로 실행되는 업로드/다운로드 작업
│   ├── pam.py            libpam ctypes 바인딩
│   ├── ratelimit.py      로그인 실패 제한
│   ├── config.py         설정 파일 로더
│   └── static/           프런트엔드 (HTML/CSS/JS, xterm.js 6.0 포함)
├── deploy/
│   ├── install.sh / uninstall.sh
│   ├── webterm.conf              기본 설정
│   ├── httpd-webterm.conf        httpd 가상 호스트 템플릿
│   ├── webterm.service / webterm-helper.service
│   └── pam.d-webterm
└── tests/
```

xterm.js 는 MIT 라이선스이며 `webterm/static/vendor/xterm/LICENSE` 에 고지가 있습니다.
