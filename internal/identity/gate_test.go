package identity

import (
	"context"
	"testing"
	"time"
)

func TestGateBoundsAndClearsRejectedPasswords(t *testing.T) {
	gate := NewGate("login")
	gate.peers["peer"] = attempts{count: 30, until: time.Now().Add(time.Minute)}
	password := []byte("transient")
	if _, err := gate.Authenticate(context.Background(), "peer", "test", password); err == nil {
		t.Fatal("admitted rate-limited login")
	}
	for _, value := range password {
		if value != 0 {
			t.Fatal("retained password bytes")
		}
	}
	for i := 0; i < cap(gate.slots); i++ {
		gate.slots <- struct{}{}
	}
	if _, err := gate.Authenticate(context.Background(), "different-peer", "test", []byte("transient")); err == nil {
		t.Fatal("admitted login beyond concurrency bound")
	}
}
