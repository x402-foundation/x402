package clientutil

import (
	"bytes"
	"log"
	"strings"
	"sync"
	"testing"
)

func TestWarningSetWarnsOncePerKeyConcurrently(t *testing.T) {
	var logs bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previous) })

	warnings := &WarningSet{}
	var wg sync.WaitGroup
	for range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			warnings.WarnMissingCapability("scheme", "network", "extension", "first warning")
		}()
	}
	wg.Wait()
	warnings.WarnMissingCapability("scheme", "other-network", "extension", "second warning")

	output := logs.String()
	if count := strings.Count(output, "first warning"); count != 1 {
		t.Fatalf("expected one warning for the first key, got %d: %q", count, output)
	}
	if count := strings.Count(output, "second warning"); count != 1 {
		t.Fatalf("expected one warning for the second key, got %d: %q", count, output)
	}
}
