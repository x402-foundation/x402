package storage

import (
	"context"
	"errors"
	"testing"
)

const (
	delegatedNetwork   = "eip155:84532"
	delegatedChannelId = "0xabc1230000000000000000000000000000000000000000000000000000000001"
)

func TestInMemoryDelegatedAuthStore_BindAndGetCopy(t *testing.T) {
	store := NewInMemoryDelegatedAuthStore()
	created, err := store.Bind(context.Background(), DelegatedAuthBinding{
		ChannelId:      delegatedChannelId,
		Network:        delegatedNetwork,
		CallerIdentity: "tenant-a",
	})
	if err != nil || !created {
		t.Fatalf("Bind: created=%v err=%v", created, err)
	}
	row, err := store.Get(context.Background(), delegatedChannelId, delegatedNetwork)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if row == nil || row.CallerIdentity != "tenant-a" || row.ChannelId != delegatedChannelId || row.Network != delegatedNetwork {
		t.Fatalf("row = %+v", row)
	}
	row.CallerIdentity = "mutated"
	again, err := store.Get(context.Background(), delegatedChannelId, delegatedNetwork)
	if err != nil {
		t.Fatalf("Get after mutate: %v", err)
	}
	if again.CallerIdentity != "tenant-a" {
		t.Fatalf("stored row mutated: %q", again.CallerIdentity)
	}
}

func TestInMemoryDelegatedAuthStore_RepeatBindIsIdempotent(t *testing.T) {
	store := NewInMemoryDelegatedAuthStore()
	binding := DelegatedAuthBinding{ChannelId: delegatedChannelId, Network: delegatedNetwork, CallerIdentity: "tenant-a"}
	created, err := store.Bind(context.Background(), binding)
	if err != nil || !created {
		t.Fatalf("Bind: created=%v err=%v", created, err)
	}
	created, err = store.Bind(context.Background(), binding)
	if err != nil || created {
		t.Fatalf("repeat Bind: created=%v err=%v", created, err)
	}
}

func TestInMemoryDelegatedAuthStore_RejectsSecondIdentity(t *testing.T) {
	store := NewInMemoryDelegatedAuthStore()
	if _, err := store.Bind(context.Background(), DelegatedAuthBinding{ChannelId: delegatedChannelId, Network: delegatedNetwork, CallerIdentity: "tenant-a"}); err != nil {
		t.Fatalf("Bind: %v", err)
	}
	_, err := store.Bind(context.Background(), DelegatedAuthBinding{ChannelId: delegatedChannelId, Network: delegatedNetwork, CallerIdentity: "tenant-b"})
	var conflict *DelegatedAuthIdentityConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("err = %v, want DelegatedAuthIdentityConflictError", err)
	}
}

func TestInMemoryDelegatedAuthStore_GetOmitsOpenToken(t *testing.T) {
	store := NewInMemoryDelegatedAuthStore()
	if _, err := store.Bind(context.Background(), DelegatedAuthBinding{ChannelId: delegatedChannelId, Network: delegatedNetwork, CallerIdentity: "tenant-a", OpenToken: "tok"}); err != nil {
		t.Fatalf("Bind: %v", err)
	}
	row, err := store.Get(context.Background(), delegatedChannelId, delegatedNetwork)
	if err != nil || row == nil || row.OpenToken != "" {
		t.Fatalf("Get: row=%+v err=%v", row, err)
	}
}

func TestInMemoryDelegatedAuthStore_RevertBindAllowsRebind(t *testing.T) {
	store := NewInMemoryDelegatedAuthStore()
	if _, err := store.Bind(context.Background(), DelegatedAuthBinding{ChannelId: delegatedChannelId, Network: delegatedNetwork, CallerIdentity: "tenant-a", OpenToken: "tok"}); err != nil {
		t.Fatalf("Bind: %v", err)
	}
	if err := store.RevertBind(context.Background(), delegatedChannelId, delegatedNetwork, "tok"); err != nil {
		t.Fatalf("RevertBind: %v", err)
	}
	row, err := store.Get(context.Background(), delegatedChannelId, delegatedNetwork)
	if err != nil || row != nil {
		t.Fatalf("Get after revert: row=%+v err=%v", row, err)
	}
	if _, err := store.Bind(context.Background(), DelegatedAuthBinding{ChannelId: delegatedChannelId, Network: delegatedNetwork, CallerIdentity: "tenant-b"}); err != nil {
		t.Fatalf("rebind: %v", err)
	}
	row, err = store.Get(context.Background(), delegatedChannelId, delegatedNetwork)
	if err != nil || row == nil || row.CallerIdentity != "tenant-b" {
		t.Fatalf("row after rebind = %+v err=%v", row, err)
	}
}

func TestInMemoryDelegatedAuthStore_RevertBindKeepsRowOnTokenMismatch(t *testing.T) {
	store := NewInMemoryDelegatedAuthStore()
	if _, err := store.Bind(context.Background(), DelegatedAuthBinding{ChannelId: delegatedChannelId, Network: delegatedNetwork, CallerIdentity: "tenant-a", OpenToken: "tok"}); err != nil {
		t.Fatalf("Bind: %v", err)
	}
	for _, token := range []string{"", "other"} {
		if err := store.RevertBind(context.Background(), delegatedChannelId, delegatedNetwork, token); err != nil {
			t.Fatalf("RevertBind(%q): %v", token, err)
		}
		if row, _ := store.Get(context.Background(), delegatedChannelId, delegatedNetwork); row == nil {
			t.Fatalf("RevertBind(%q) deleted the binding", token)
		}
	}
}

func TestInMemoryDelegatedAuthStore_SameIdentityRebindDisablesRevert(t *testing.T) {
	store := NewInMemoryDelegatedAuthStore()
	binding := DelegatedAuthBinding{ChannelId: delegatedChannelId, Network: delegatedNetwork, CallerIdentity: "tenant-a", OpenToken: "tok"}
	if _, err := store.Bind(context.Background(), binding); err != nil {
		t.Fatalf("Bind: %v", err)
	}
	binding.OpenToken = "tok-b"
	if created, err := store.Bind(context.Background(), binding); err != nil || created {
		t.Fatalf("re-Bind: created=%v err=%v", created, err)
	}
	for _, token := range []string{"tok", "tok-b"} {
		if err := store.RevertBind(context.Background(), delegatedChannelId, delegatedNetwork, token); err != nil {
			t.Fatalf("RevertBind(%q): %v", token, err)
		}
	}
	if row, _ := store.Get(context.Background(), delegatedChannelId, delegatedNetwork); row == nil {
		t.Fatal("binding removed after a same-identity re-bind")
	}
}

func TestInMemoryDelegatedAuthStore_ConflictKeepsToken(t *testing.T) {
	store := NewInMemoryDelegatedAuthStore()
	if _, err := store.Bind(context.Background(), DelegatedAuthBinding{ChannelId: delegatedChannelId, Network: delegatedNetwork, CallerIdentity: "tenant-a", OpenToken: "tok"}); err != nil {
		t.Fatalf("Bind: %v", err)
	}
	if _, err := store.Bind(context.Background(), DelegatedAuthBinding{ChannelId: delegatedChannelId, Network: delegatedNetwork, CallerIdentity: "tenant-b", OpenToken: "tok-b"}); err == nil {
		t.Fatal("expected conflict")
	}
	if err := store.RevertBind(context.Background(), delegatedChannelId, delegatedNetwork, "tok"); err != nil {
		t.Fatalf("RevertBind: %v", err)
	}
	if row, _ := store.Get(context.Background(), delegatedChannelId, delegatedNetwork); row != nil {
		t.Fatalf("creator could not revert after a conflicting bind: %+v", row)
	}
}
