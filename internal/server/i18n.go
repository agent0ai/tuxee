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
	return s.loginTranslations(code)
}

func (s *Server) loginTranslations(code string) *i18n.Bundle {
	bundle := *s.Translations.Bundle(code, s.languageCookie)
	texts := make(map[string]string)
	// An explicit list prevents new application messages from fingerprinting releases.
	for _, key := range []string{
		"app.tuxee", "app.tagline", "app.previewAlt", "app.signInFailed",
		"login.language", "login.languageFailed", "login.password", "login.signIn", "login.username",
		"validation.required", "validation.invalid", "ui.connectionLostTryAgainWhenReconnected",
		"backend.identity.invalidUsernamePasswordOrAccountPolicy",
		"backend.identity.authenticationIsBusyTryAgainShortly", "backend.identity.loginAttemptLimit",
		"backend.server.invalidRequestBody", "backend.server.requestMustContainOneJSONValue",
		"backend.server.missingApplicationRequestHeader", "backend.server.requestOriginIsNotAllowed",
		"backend.server.serverRestarting", "backend.server.tooManyActiveLoginSessions", "server.frontendUnavailable",
	} {
		texts[key] = bundle.Texts[key]
	}
	bundle.Texts = texts
	return &bundle
}
