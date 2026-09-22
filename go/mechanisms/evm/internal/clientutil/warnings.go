package clientutil

import (
	"log"
	"sync"
)

// WarningSet logs each keyed warning at most once.
type WarningSet struct {
	seen sync.Map
}

// Warn logs message unless key has already been seen.
func (w *WarningSet) Warn(key string, message string) {
	if _, loaded := w.seen.LoadOrStore(key, struct{}{}); loaded {
		return
	}
	log.Print(message)
}
