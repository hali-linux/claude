# modsec-spoa: HAProxy SPOE agent for ModSecurity v3 (libmodsecurity)
#
#   make            build ./modsec-spoa
#   make test       run unit tests (needs libmodsecurity)
#   make install    install to $(DESTDIR)$(BINDIR)
#
# libmodsecurity installed under a custom prefix (source build):
#   make MODSEC_PREFIX=/usr/local/modsecurity

GO            ?= go
PREFIX        ?= /usr/local
BINDIR        ?= $(PREFIX)/bin
VERSION       ?= 1.0.0
MODSEC_PREFIX ?=

ifneq ($(MODSEC_PREFIX),)
export CGO_CFLAGS  += -I$(MODSEC_PREFIX)/include
export CGO_LDFLAGS += -L$(MODSEC_PREFIX)/lib -Wl,-rpath,$(MODSEC_PREFIX)/lib
endif
export CGO_ENABLED = 1
# Never download a newer Go toolchain implicitly.
export GOTOOLCHAIN = local

.PHONY: build test install clean

build:
	$(GO) build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o modsec-spoa .

test:
	$(GO) vet ./...
	$(GO) test -count=1 ./...

install: build
	install -D -m 0755 modsec-spoa $(DESTDIR)$(BINDIR)/modsec-spoa

clean:
	rm -f modsec-spoa
