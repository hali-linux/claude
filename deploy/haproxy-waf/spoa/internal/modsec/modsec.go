// Package modsec is a minimal cgo binding for libmodsecurity v3 (the
// ModSecurity C API: modsecurity/modsecurity.h, rules_set.h, transaction.h).
//
// One Engine (msc_init) and one RulesSet are shared by all goroutines; each
// request gets its own Transaction. Rule sets can be swapped at runtime
// (Engine.Reload) without interrupting in-flight transactions.
package modsec

/*
#cgo LDFLAGS: -lmodsecurity
#include <stdint.h>
#include <stdlib.h>
#include <modsecurity/modsecurity.h>
#include <modsecurity/rules_set.h>
#include <modsecurity/transaction.h>
#include <modsecurity/intervention.h>

extern void modsecGoLogCallback(uintptr_t data, char *msg);

static void modsec_log_cb(void *data, const void *msg) {
	if (data == NULL || msg == NULL) return;
	modsecGoLogCallback((uintptr_t)data, (char *)msg);
}

static void modsec_set_log_cb(ModSecurity *ms) {
	msc_set_log_cb(ms, modsec_log_cb);
}

static Transaction *modsec_new_tx(ModSecurity *ms, RulesSet *rules, char *id, uintptr_t handle) {
	return msc_new_transaction_with_id(ms, rules, id, (void *)handle);
}

static int modsec_rules_add_file(RulesSet *rules, const char *file, char **err) {
	const char *e = NULL;
	int ret = msc_rules_add_file(rules, file, &e);
	*err = (char *)e;
	return ret;
}

static int modsec_rules_add(RulesSet *rules, const char *text, char **err) {
	const char *e = NULL;
	int ret = msc_rules_add(rules, text, &e);
	*err = (char *)e;
	return ret;
}
*/
import "C"

import (
	"errors"
	"fmt"
	"runtime/cgo"
	"strings"
	"sync"
	"unsafe"
)

// Engine wraps a ModSecurity instance and the active rule set.
type Engine struct {
	ms    *C.ModSecurity
	mu    sync.RWMutex // held for reading by every live transaction
	rules *C.RulesSet
	nrule int
}

// NewEngine initializes libmodsecurity. connector is reported in
// ModSecurity's logs (e.g. "modsec-spoa/1.0").
func NewEngine(connector string) *Engine {
	e := &Engine{ms: C.msc_init()}
	cs := C.CString(connector)
	defer C.free(unsafe.Pointer(cs))
	C.msc_set_connector_info(e.ms, cs)
	C.modsec_set_log_cb(e.ms)
	return e
}

// Version returns libmodsecurity's identification string.
func (e *Engine) Version() string { return C.GoString(C.msc_who_am_i(e.ms)) }

// RuleSource is a rules file path or, when Inline is set, rule text.
type RuleSource struct {
	Path   string
	Inline string
}

// LoadRules parses the given sources into a new rule set without touching
// the active one. Use Reload to activate it.
func LoadRules(sources ...RuleSource) (*RuleSet, error) {
	rs := C.msc_create_rules_set()
	total := 0
	for _, src := range sources {
		var cerr *C.char
		var ret C.int
		if src.Inline != "" {
			cs := C.CString(src.Inline)
			ret = C.modsec_rules_add(rs, cs, &cerr)
			C.free(unsafe.Pointer(cs))
		} else {
			cs := C.CString(src.Path)
			ret = C.modsec_rules_add_file(rs, cs, &cerr)
			C.free(unsafe.Pointer(cs))
		}
		if ret < 0 {
			msg := "unknown error"
			if cerr != nil {
				msg = strings.TrimSpace(C.GoString(cerr))
				C.free(unsafe.Pointer(cerr))
			}
			C.msc_rules_cleanup(rs)
			where := src.Path
			if where == "" {
				where = "inline rules"
			}
			return nil, fmt.Errorf("modsecurity: %s: %s", where, msg)
		}
		total += int(ret)
	}
	return &RuleSet{p: rs, n: total}, nil
}

// RuleSet is a parsed, not yet active, set of rules.
type RuleSet struct {
	p *C.RulesSet
	n int
}

// Count is the number of rules parsed.
func (r *RuleSet) Count() int { return r.n }

// Close frees a rule set that was never activated.
func (r *RuleSet) Close() {
	if r.p != nil {
		C.msc_rules_cleanup(r.p)
		r.p = nil
	}
}

// Reload activates rs. It waits for in-flight transactions that use the
// previous rule set, then frees it.
func (e *Engine) Reload(rs *RuleSet) {
	e.mu.Lock()
	old := e.rules
	e.rules, e.nrule = rs.p, rs.n
	rs.p = nil
	e.mu.Unlock()
	if old != nil {
		C.msc_rules_cleanup(old)
	}
}

// RuleCount returns the number of rules in the active rule set.
func (e *Engine) RuleCount() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.nrule
}

// ErrNoRules is returned when no rule set has been activated.
var ErrNoRules = errors.New("modsecurity: no rules loaded")

// Transaction is one HTTP transaction. It must be closed with Close.
type Transaction struct {
	e      *Engine
	tx     *C.Transaction
	handle cgo.Handle
	// Logs receives one entry per rule match message emitted by
	// ModSecurity (the classic "ModSecurity: Warning. ... [id "..."]" line).
	Logs []string
}

// NewTransaction starts a transaction with the given unique id.
func (e *Engine) NewTransaction(id string) (*Transaction, error) {
	e.mu.RLock()
	if e.rules == nil {
		e.mu.RUnlock()
		return nil, ErrNoRules
	}
	t := &Transaction{e: e}
	t.handle = cgo.NewHandle(t)
	cid := C.CString(id)
	t.tx = C.modsec_new_tx(e.ms, e.rules, cid, C.uintptr_t(t.handle))
	C.free(unsafe.Pointer(cid))
	if t.tx == nil {
		t.handle.Delete()
		e.mu.RUnlock()
		return nil, errors.New("modsecurity: cannot create transaction")
	}
	return t, nil
}

// Close frees the transaction. It is safe to call more than once.
func (t *Transaction) Close() {
	if t.tx == nil {
		return
	}
	C.msc_transaction_cleanup(t.tx)
	t.tx = nil
	t.handle.Delete()
	t.e.mu.RUnlock()
}

var zero = []byte{0}

// bytesPtr returns a C pointer to b's data. Empty slices map to a valid
// (non-NULL) pointer because libmodsecurity builds std::strings from them.
func bytesPtr(b []byte) *C.uchar {
	if len(b) == 0 {
		return (*C.uchar)(unsafe.Pointer(&zero[0]))
	}
	return (*C.uchar)(unsafe.Pointer(&b[0]))
}

// ProcessConnection records client and server addresses (phase 0).
func (t *Transaction) ProcessConnection(clientIP string, clientPort int, serverIP string, serverPort int) {
	cc, cs := C.CString(clientIP), C.CString(serverIP)
	C.msc_process_connection(t.tx, cc, C.int(clientPort), cs, C.int(serverPort))
	C.free(unsafe.Pointer(cc))
	C.free(unsafe.Pointer(cs))
}

// ProcessURI records the request line. uri includes the query string;
// version is e.g. "1.1" or "2.0".
func (t *Transaction) ProcessURI(uri, method, version string) {
	cu, cm, cv := C.CString(uri), C.CString(method), C.CString(version)
	C.msc_process_uri(t.tx, cu, cm, cv)
	C.free(unsafe.Pointer(cu))
	C.free(unsafe.Pointer(cm))
	C.free(unsafe.Pointer(cv))
}

// AddRequestHeader adds one request header.
func (t *Transaction) AddRequestHeader(name, value []byte) {
	C.msc_add_n_request_header(t.tx, bytesPtr(name), C.size_t(len(name)), bytesPtr(value), C.size_t(len(value)))
}

// ProcessRequestHeaders runs phase 1.
func (t *Transaction) ProcessRequestHeaders() { C.msc_process_request_headers(t.tx) }

// AppendRequestBody feeds request body bytes.
func (t *Transaction) AppendRequestBody(b []byte) {
	if len(b) > 0 {
		C.msc_append_request_body(t.tx, bytesPtr(b), C.size_t(len(b)))
	}
}

// ProcessRequestBody runs phase 2. It must be called even without a body:
// most CRS rules (ARGS, headers, ...) run in phase 2.
func (t *Transaction) ProcessRequestBody() { C.msc_process_request_body(t.tx) }

// ProcessLogging runs phase 5 (logging rules, audit log).
func (t *Transaction) ProcessLogging() { C.msc_process_logging(t.tx) }

// Intervention is a disruptive action requested by the rules.
type Intervention struct {
	Status int
	URL    string
	Log    string
}

// Intervention returns the pending disruptive intervention, if any.
func (t *Transaction) Intervention() *Intervention {
	var it C.ModSecurityIntervention
	it.status = 200
	if C.msc_intervention(t.tx, &it) == 0 {
		return nil
	}
	out := &Intervention{Status: int(it.status)}
	if it.url != nil {
		out.URL = C.GoString(it.url)
		C.free(unsafe.Pointer(it.url))
	}
	if it.log != nil {
		out.Log = C.GoString(it.log)
		C.free(unsafe.Pointer(it.log))
	}
	return out
}
