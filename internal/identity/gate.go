package identity

import (
	"context"
	"sync"
	"time"
	"tuxee/internal/i18n"
)

const loginAttemptWindow = time.Minute

type attempts struct {
	count int
	until time.Time
}
type Gate struct {
	Service string
	mu      sync.Mutex
	peers   map[string]attempts
	slots   chan struct{}
}

func NewGate(service string) *Gate {
	return &Gate{Service: service, peers: make(map[string]attempts), slots: make(chan struct{}, 4)}
}
func (g *Gate) Authenticate(ctx context.Context, peer, name string, password []byte) (User, error) {
	defer clear(password)
	if len(name) == 0 || len(name) > 256 || len(password) == 0 || len(password) > 4096 {
		return User{}, i18n.New("backend.identity.invalidCredentials")
	}
	now := time.Now()
	g.mu.Lock()
	for key, a := range g.peers {
		if now.After(a.until) {
			delete(g.peers, key)
		}
	}
	a := g.peers[peer]
	if a.count >= 30 || len(g.peers) >= 1024 && a.count == 0 {
		g.mu.Unlock()
		return User{}, i18n.New("backend.identity.loginAttemptLimit", i18n.Vars{"seconds": int(loginAttemptWindow.Seconds())})
	}
	if a.count == 0 {
		a.until = now.Add(loginAttemptWindow)
	}
	a.count++
	g.peers[peer] = a
	g.mu.Unlock()
	select {
	case g.slots <- struct{}{}:
		defer func() { <-g.slots }()
	default:
		return User{}, i18n.New("backend.identity.authenticationIsBusyTryAgainShortly")
	}
	return Authenticate(ctx, g.Service, name, password)
}
