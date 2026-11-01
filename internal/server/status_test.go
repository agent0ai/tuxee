package server

import (
	"context"
	"testing"
	"time"

	"tuxee/internal/identity"
)

func TestSignedInUsers(t *testing.T) {
	s := &Server{logins: make(map[[32]byte]*login)}
	for i, uid := range []uint32{1001, 1001, 1002, 1003, 1004} {
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		session := &login{user: identity.User{UID: uid}, expires: time.Now().Add(time.Hour), ctx: ctx, cancel: cancel}
		if uid == 1003 {
			session.expires = time.Now().Add(-time.Second)
		}
		if uid == 1004 {
			cancel()
		}
		s.logins[[32]byte{byte(i)}] = session
	}
	if got := s.SignedInUsers(); got != 2 {
		t.Fatalf("got %d users; want 2 distinct unexpired, unrevoked UIDs", got)
	}
	s.Close()
	if got := s.SignedInUsers(); got != 0 {
		t.Fatalf("closed server has %d users", got)
	}
}
