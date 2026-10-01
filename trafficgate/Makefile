# TrafficGate 빌드
#   make build        정적 바이너리 (dist/trafficgate-<버전>-linux-<arch>/trafficgate)
#   make test         단위/통합 테스트 (redis-server 가 있으면 Redis 저장소도 검사)
#   make dist         배포 압축 파일 (바이너리 + 설치 스크립트 + 설정/문서)
#   make rpm          Rocky Linux 9 용 RPM
#   make e2e-rocky9   Docker 의 Rocky Linux 9 컨테이너에서 RPM/스크립트 설치 검증
#
#   GOARCH=arm64 make rpm   (aarch64 서버용)

VERSION ?= 1.0.0
RELEASE ?= 1
GOARCH  ?= amd64
COMMIT  := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
DATE    := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
PKG     := github.com/hali-linux/claude/trafficgate/internal/version
LDFLAGS := -s -w -X $(PKG).Version=$(VERSION) -X $(PKG).Commit=$(COMMIT) -X $(PKG).Date=$(DATE)
NAME    := trafficgate-$(VERSION)-linux-$(GOARCH)
OUT     := dist/$(NAME)

.PHONY: all build test vet lint dist rpm e2e-rocky9 clean

all: vet test dist

build:
	mkdir -p $(OUT)
	CGO_ENABLED=0 GOOS=linux GOARCH=$(GOARCH) go build -trimpath -ldflags "$(LDFLAGS)" -o $(OUT)/trafficgate ./cmd/trafficgate

vet:
	go vet ./...
	@test -z "$$(gofmt -l .)" || (echo "gofmt 필요:"; gofmt -l .; exit 1)

test:
	go test -race -count=1 ./...

lint: vet
	node --check internal/server/web/trafficgate.js
	node --check internal/server/web/admin/app.js
	shellcheck deploy/install.sh deploy/uninstall.sh scripts/*.sh

dist: build
	mkdir -p $(OUT)/deploy
	cp -r deploy/systemd deploy/firewalld deploy/nginx deploy/sysctl deploy/sysconfig.example $(OUT)/deploy/
	cp deploy/install.sh deploy/uninstall.sh $(OUT)/
	cp -r README.md docs examples $(OUT)/
	tar -C dist -czf dist/$(NAME).tar.gz $(NAME)
	cd dist && sha256sum $(NAME).tar.gz > $(NAME).tar.gz.sha256
	@echo "배포 파일: dist/$(NAME).tar.gz"

rpm: dist
	VERSION=$(VERSION) RELEASE=$(RELEASE) GOARCH=$(GOARCH) scripts/build-rpm.sh

e2e-rocky9: rpm
	VERSION=$(VERSION) GOARCH=$(GOARCH) scripts/e2e-rocky9.sh

clean:
	rm -rf dist
