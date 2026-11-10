package clientutil

import (
	"log"
	"sync"
)

// WarningSet logs each keyed warning at most once.
type WarningSet struct {
	seen sync.Map
}

// WarnMissingCapability logs a capability warning once per network and extension.
func (w *WarningSet) WarnMissingCapability(scheme string, network string, extension string, detail string) {
	key := network + "|" + extension
	if _, loaded := w.seen.LoadOrStore(key, struct{}{}); loaded {
		return
	}
	log.Printf(
		"[x402 %s] %s was advertised for %s, but %s; continuing without the extension",
		scheme,
		extension,
		network,
		detail,
	)
}
