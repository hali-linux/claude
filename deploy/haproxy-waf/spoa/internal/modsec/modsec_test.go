package modsec

import (
	"fmt"
	"strings"
	"sync"
	"testing"
)

const rules = `
SecRuleEngine On
SecRequestBodyAccess On
SecRule ARGS:q "@rx ^evil" "id:1,phase:2,deny,status:403,log,msg:'evil'"
SecRule ARGS:q "@streq warn" "id:2,phase:2,pass,log,msg:'warn'"
`

func newEngine(t *testing.T) *Engine {
	t.Helper()
	e := NewEngine("test")
	rs, err := LoadRules(RuleSource{Inline: rules})
	if err != nil {
		t.Fatal(err)
	}
	e.Reload(rs)
	return e
}

func run(t *testing.T, e *Engine, q string) (*Intervention, []string) {
	t.Helper()
	tx, err := e.NewTransaction("id-" + q)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Close()
	tx.ProcessConnection("192.0.2.1", 1234, "192.0.2.2", 443)
	tx.ProcessURI("/?q="+q, "GET", "1.1")
	tx.AddRequestHeader([]byte("Host"), []byte("example.com"))
	tx.AddRequestHeader([]byte("X-Empty"), nil)
	tx.ProcessRequestHeaders()
	tx.ProcessRequestBody()
	it := tx.Intervention()
	tx.ProcessLogging()
	return it, tx.Logs
}

func TestInterventionAndLogs(t *testing.T) {
	e := newEngine(t)
	if it, _ := run(t, e, "evil"); it == nil || it.Status != 403 || !strings.Contains(it.Log, `[id "1"]`) {
		t.Fatalf("intervention = %+v", it)
	}
	it, logs := run(t, e, "warn")
	if it != nil || len(logs) != 1 || !strings.Contains(logs[0], `[id "2"]`) {
		t.Fatalf("intervention = %+v, logs = %v", it, logs)
	}
	if it, logs := run(t, e, "fine"); it != nil || len(logs) != 0 {
		t.Fatalf("intervention = %+v, logs = %v", it, logs)
	}
}

func TestLoadRulesError(t *testing.T) {
	if _, err := LoadRules(RuleSource{Inline: `SecNoSuchDirective On`}); err == nil {
		t.Fatal("expected a parse error")
	}
	if _, err := LoadRules(RuleSource{Path: "/nonexistent/rules.conf"}); err == nil {
		t.Fatal("expected an error for a missing file")
	}
}

func TestNoRules(t *testing.T) {
	if _, err := NewEngine("test").NewTransaction("x"); err != ErrNoRules {
		t.Fatalf("err = %v, want ErrNoRules", err)
	}
}

func TestConcurrentTransactionsAndReload(t *testing.T) {
	e := newEngine(t)
	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				q := "fine"
				if i%3 == 0 {
					q = "evil"
				}
				tx, err := e.NewTransaction(fmt.Sprintf("%d-%d", g, i))
				if err != nil {
					errs <- err
					return
				}
				tx.ProcessURI("/?q="+q, "GET", "1.1")
				tx.ProcessRequestHeaders()
				tx.ProcessRequestBody()
				it := tx.Intervention()
				tx.Close()
				if (q == "evil") != (it != nil) {
					errs <- fmt.Errorf("q=%s intervention=%v", q, it)
					return
				}
			}
		}(g)
	}
	for i := 0; i < 5; i++ {
		rs, err := LoadRules(RuleSource{Inline: rules})
		if err != nil {
			t.Fatal(err)
		}
		e.Reload(rs)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
}
