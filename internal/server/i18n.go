package server

import (
	"crypto/sha256"
	"net/http"
	"time"
	"tuxee/internal/i18n"
)

func (s *Server) requestSession(r *http.Request) *login {
	cookie, err := r.Cookie(s.cookieName)
	if err != nil {
		return nil
	}
	key := sha256.Sum256([]byte(cookie.Value))
	s.mu.Lock()
	defer s.mu.Unlock()
	session := s.logins[key]
	if session != nil && time.Now().After(session.expires) {
		session.cancel()
		delete(s.logins, key)
		return nil
	}
	return session
}
func (s *Server) requestTranslations(r *http.Request) *i18n.Bundle {
	if session := s.requestSession(r); session != nil && session.translations != nil {
		return session.translations
	}
	code := "en"
	if cookie, err := r.Cookie(s.languageCookie); err == nil {
		code = cookie.Value
	}
	return s.Translations.Bundle(code, s.languageCookie)
}
