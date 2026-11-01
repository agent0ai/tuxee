package server

import "time"

// SignedInUsers counts distinct Linux UIDs with a valid login, including closed browsers.
func (s *Server) SignedInUsers() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	users := make(map[uint32]bool)
	now := time.Now()
	for _, session := range s.logins {
		if now.Before(session.expires) && session.ctx.Err() == nil {
			users[session.user.UID] = true
		}
	}
	return len(users)
}
