package modsec

// The exported callback lives in its own file: cgo forbids C definitions in
// the preamble of a file that uses //export.

/*
#include <stdint.h>
*/
import "C"

import "runtime/cgo"

// modsecGoLogCallback receives ModSecurity's per-rule log messages. data is
// the cgo.Handle of the Transaction passed to msc_new_transaction_with_id.
//
//export modsecGoLogCallback
func modsecGoLogCallback(data C.uintptr_t, msg *C.char) {
	t, ok := cgo.Handle(data).Value().(*Transaction)
	if !ok {
		return
	}
	t.Logs = append(t.Logs, C.GoString(msg))
}
