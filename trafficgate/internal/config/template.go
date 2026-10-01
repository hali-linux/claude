package config

import (
	"bytes"
	"strconv"
	"text/template"
)

// TemplateData 는 init-config 로 생성하는 설정 파일의 값이다.
type TemplateData struct {
	Listen        string
	AdminListen   string
	GateBasePath  string
	StoreType     string
	DataDir       string
	RedisAddrs    []string
	TokenSecret   string
	SessionSecret string
	AdminUser     string
	AdminHash     string
}

var configTemplate = template.Must(template.New("config").Funcs(template.FuncMap{"q": strconv.Quote}).Parse(`# =====================================================================
#  TrafficGate 설정 파일
#  - 변경 후 적용:  sudo systemctl restart trafficgate
#  - 문법 검사:    trafficgate check-config -config /etc/trafficgate/config.yaml
#  - 세그먼트(대기실)는 관리 콘솔/관리 API 에서 관리합니다.
#    아래 segments 항목은 "최초 기동 시 세그먼트가 하나도 없을 때"만 등록됩니다.
# =====================================================================

server:
  # 대기열 API, 대기 화면, JS 에이전트(/trafficgate.js)를 제공하는 공개 주소
  listen: {{q .Listen}}
  # 직접 HTTPS 를 제공하려면 인증서 경로를 지정합니다(보통은 nginx 에서 TLS 종료).
  tls_cert: ""
  tls_key: ""
  # X-Forwarded-For 를 신뢰할 프록시(nginx/L4) 대역. 실제 사용자 IP 판별과 요청 제한에 사용됩니다.
  trusted_proxies:
    - "127.0.0.1/32"
    - "::1/128"
  # 대기열 API 를 호출할 수 있는 웹사이트 Origin. "*" 는 모두 허용.
  # 예) ["https://www.example.com", "https://m.example.com"]
  cors_origins:
    - "*"
  # nginx 게이트 연동 시 TrafficGate 를 노출하는 공개 경로 접두사
  gate_base_path: {{q .GateBasePath}}
  # 통과 쿠키 Secure 속성: auto(HTTPS 요청일 때만) | always | never
  cookie_secure: "auto"
  # 통과 쿠키를 하위 도메인 전체에서 공유하려면 지정 (예: ".example.com")
  cookie_domain: ""

admin:
  # 관리 콘솔/관리 API/메트릭 주소. 기본값은 로컬 전용입니다.
  # 원격 접속이 필요하면 SSH 터널, 또는 "0.0.0.0:8801" + 방화벽 IP 제한을 사용하세요.
  listen: {{q .AdminListen}}
  tls_cert: ""
  tls_key: ""
  # 관리자 계정. 비밀번호 해시는 "trafficgate hash-password" 로 생성합니다.
  users:
    - username: {{q .AdminUser}}
      password_hash: {{q .AdminHash}}
  # 자동화(스크립트/CI)용 Bearer 토큰. 24자 이상. 예) openssl rand -hex 32
  api_tokens: []
  session_ttl: 12h
  # /metrics(Prometheus) 를 인증 없이 허용할지 여부
  metrics_public: true

security:
  # 통과 토큰 서명 키. 클러스터의 모든 노드, 토큰을 직접 검증하는 백엔드와 같은 값을 사용해야 합니다.
  # 환경 변수 TRAFFICGATE_TOKEN_SECRET 으로도 지정할 수 있습니다.
  token_secret: {{q .TokenSecret}}
  # 키 교체 중 아직 유효한 이전 키 (검증에만 사용)
  previous_token_secrets: []
  # 관리 콘솔 세션 서명 키 (환경 변수 TRAFFICGATE_SESSION_SECRET)
  session_secret: {{q .SessionSecret}}

store:
  # memory: 단일 서버 (재시작 시 대기열을 data_dir 에 저장/복원)
  # redis : 여러 서버가 대기열을 공유하는 클러스터/이중화 구성
  type: {{q .StoreType}}
  data_dir: {{q .DataDir}}
  redis:
    # 단일 Redis: ["127.0.0.1:6379"]
    # Sentinel : master_name 지정 + Sentinel 주소 목록
    # Cluster  : 여러 노드 주소 (master_name 비움)
    addrs:
{{- range .RedisAddrs}}
      - {{q .}}
{{- end}}
    master_name: ""
    username: ""
    # 환경 변수 TRAFFICGATE_REDIS_PASSWORD 로도 지정할 수 있습니다.
    password: ""
    db: 0
    tls: false
    key_prefix: "tg:"
    pool_size: 0   # 0 = CPU 수 x 10

queue:
  # 이 시간 동안 폴링하지 않은 대기자는 다른 사람의 입장을 막지 않습니다(순번은 유지).
  live_window: 30s
  # 이 시간 동안 폴링하지 않은 대기자는 이탈로 보고 대기열에서 제거합니다.
  wait_ttl: 5m
  # 클라이언트 폴링 간격 범위 (순번이 앞일수록 짧게, 뒤일수록 길게 자동 조정)
  min_poll_interval: 1s
  max_poll_interval: 10s
  sweep_interval: 1s
  # 클러스터에서 세그먼트 설정 변경을 확인하는 주기
  segment_refresh: 2s

rate_limit:
  # IP 별 요청 제한 (통신사 NAT 환경을 고려해 넉넉하게 설정하세요)
  enabled: true
  enter_per_minute: 120
  enter_burst: 60
  poll_per_minute: 600
  poll_burst: 120

log:
  level: info      # debug | info | warn | error
  format: text     # text | json
  access: false    # 요청별 접근 로그 (트래픽이 많으면 끄는 것을 권장)

segments:
  - id: default
    name: 기본 세그먼트
    mode: queue              # queue(대기열) | bypass(제어 해제) | block(차단)
    max_active: 100          # 진입 허용 수 (동시에 서비스에 들어가 있을 수 있는 사용자 수)
    active_ttl_sec: 30       # 입장 후 슬롯 자동 반환 시간
    pass_ttl_sec: 600        # 통과 토큰/쿠키 유효 시간
    max_waiting: 0           # 대기열 최대 인원 (0 = 무제한)
    url_patterns: []         # nginx 게이트 연동 시 제어할 경로 (예: ["/event/*"])
    title: 접속 대기 중입니다
    message: 현재 접속자가 많아 순서대로 입장하고 있습니다. 잠시만 기다려 주세요.
    block_message: 서비스 점검 중입니다. 잠시 후 다시 이용해 주세요.
    closed_message: 이벤트가 종료되었습니다.
`))

// Render 는 설정 파일 내용을 만든다.
func Render(d TemplateData) ([]byte, error) {
	if len(d.RedisAddrs) == 0 {
		d.RedisAddrs = []string{"127.0.0.1:6379"}
	}
	var buf bytes.Buffer
	if err := configTemplate.Execute(&buf, d); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
