package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/skip2/go-qrcode"
	"tuxee/internal/files"
	"tuxee/internal/i18n"
	"tuxee/internal/identity"
	"tuxee/internal/processes"
	"tuxee/internal/security"
	"tuxee/internal/update"
)

const networkAuthorizationWindow = 5 * time.Minute

type pendingLogin struct {
	mu       sync.Mutex
	user     identity.User
	language string
	peer     string
	expires  time.Time
	used     bool
	attempts int
}

func (s *Server) lockFactor(uid uint32) func() {
	value, _ := s.factorChanges.LoadOrStore(uid, &sync.Mutex{})
	lock := value.(*sync.Mutex)
	lock.Lock()
	return lock.Unlock
}

func (s *Server) networkAdmission(w http.ResponseWriter, r *http.Request) bool {
	policy, err := s.Network.Load()
	if err == nil {
		var address netip.Addr
		address, err = policy.ClientIP(r)
		if err == nil && policy.Allows(address) {
			return true
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	failure(w, http.StatusForbidden, i18n.New("security.networkDenied"))
	return false
}

func (s *Server) clientIP(r *http.Request) string {
	policy, err := s.Network.Load()
	if err != nil {
		return ""
	}
	address, err := policy.ClientIP(r)
	if err != nil {
		return ""
	}
	return address.String()
}

func (s *Server) pruneSecurity() {
	policy, err := s.Network.Load()
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, session := range s.logins {
		address, parseErr := netip.ParseAddr(session.clientIP)
		if err != nil || s.Network != nil && (parseErr != nil || !policy.Allows(address)) {
			session.cancel()
			delete(s.logins, key)
		}
	}
	for key, pending := range s.pendingLogins {
		if time.Now().After(pending.expires) {
			delete(s.pendingLogins, key)
		}
	}
}

func (s *Server) beginSecondFactor(w http.ResponseWriter, r *http.Request, user identity.User, language string) {
	const maxPendingPerUser = 4
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	var oldestKey [32]byte
	var oldest time.Time
	count := 0
	for key, pending := range s.pendingLogins {
		if !now.Before(pending.expires) {
			delete(s.pendingLogins, key)
		} else if pending.user.UID == user.UID {
			count++
			if oldest.IsZero() || pending.expires.Before(oldest) {
				oldestKey, oldest = key, pending.expires
			}
		}
	}
	// Abandoned sign-ins from one account must leave room for other accounts.
	if count >= maxPendingPerUser {
		delete(s.pendingLogins, oldestKey)
	}
	if len(s.pendingLogins) >= 128 || s.closed.Load() {
		failure(w, 503, i18n.New("backend.identity.authenticationIsBusyTryAgainShortly"))
		return
	}
	token := randomToken()
	s.pendingLogins[sha256.Sum256([]byte(token))] = &pendingLogin{user: user, language: language, peer: s.clientIP(r), expires: time.Now().Add(5 * time.Minute)}
	jsonResponse(w, 200, map[string]string{"challenge": token})
}

func (s *Server) completeSecondFactor(w http.ResponseWriter, r *http.Request, challenge, code string) {
	key := sha256.Sum256([]byte(challenge))
	s.mu.Lock()
	pending := s.pendingLogins[key]
	s.mu.Unlock()
	if pending == nil {
		failure(w, 401, i18n.New("security.challengeExpired"))
		return
	}
	pending.mu.Lock()
	defer pending.mu.Unlock()
	unlock := s.lockFactor(pending.user.UID)
	defer unlock()
	s.mu.Lock()
	current := s.pendingLogins[key] == pending
	s.mu.Unlock()
	if !current || pending.used || time.Now().After(pending.expires) || pending.peer != s.clientIP(r) || pending.attempts >= 5 {
		failure(w, 401, i18n.New("security.challengeExpired"))
		return
	}
	pending.attempts++
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if _, err := files.Run(ctx, pending.user, files.Request{Operation: "security-verify", Content: strings.TrimSpace(code), Mode: "required"}); err != nil {
		failure(w, 401, err)
		return
	}
	pending.used = true
	s.mu.Lock()
	delete(s.pendingLogins, key)
	s.mu.Unlock()
	s.issueLogin(w, r, pending.user, pending.language)
}

func (s *Server) securityAdmin(ctx context.Context, user identity.User) error {
	select {
	case s.processKills <- struct{}{}:
		defer func() { <-s.processKills }()
	default:
		return i18n.New("backend.server.processSignallingIsBusy")
	}
	_, err := processes.Run(ctx, user, processes.Request{Operation: "check-parent-signal"})
	return err
}

func (s *Server) securityOperation(w http.ResponseWriter, r *http.Request, session *login) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if !s.fileSlot(w) {
		return
	}
	defer func() { <-s.fileSlots }()
	if r.URL.Path == "/api/security" && r.Method == "GET" {
		result, err := files.Run(ctx, session.user, files.Request{Operation: "security-status"})
		if err != nil {
			failure(w, 422, err)
			return
		}
		admin := s.securityAdmin(ctx, session.user) == nil
		response := map[string]any{"user": result.Security, "canAdmin": admin, "clientIP": s.clientIP(r)}
		if admin {
			policy, err := s.Network.Load()
			if err != nil {
				failure(w, 422, err)
				return
			}
			response["network"] = policy
			if s.Network != nil {
				response["networkRecoveryCommand"] = update.Command(s.updatePath) + " security network --clear --state '" + strings.ReplaceAll(s.Network.Directory, "'", "'\\''") + "'"
			}
		}
		jsonResponse(w, 200, response)
		return
	}
	if r.URL.Path == "/api/security/network" && (r.Method == "PUT" || r.Method == "POST") ||
		r.URL.Path == "/api/security/network/unlock" && r.Method == "POST" {
		if err := s.securityAdmin(ctx, session.user); err != nil {
			failure(w, 403, i18n.Wrap("security.adminDenied", err, i18n.Vars{"detail": i18n.Describe(err)}))
			return
		}
		if r.URL.Path == "/api/security/network/unlock" {
			s.unlockNetwork(w, r, ctx, session)
			return
		}
		var input struct {
			security.Network
			IP                string `json:"ip,omitempty"`
			ConfirmDisconnect bool   `json:"confirmDisconnect,omitempty"`
		}
		if err := decode(w, r, &input, 32768); err != nil {
			failure(w, 400, err)
			return
		}
		policy := input.Network
		for _, ranges := range [][]string{policy.AllowedNetworks, policy.TrustedProxies} {
			if _, err := security.ParseNetworks(ranges); err != nil {
				failure(w, 422, err)
				return
			}
		}
		if r.Method == "POST" {
			address, err := netip.ParseAddr(strings.TrimSpace(input.IP))
			if err != nil || address.Zone() != "" {
				failure(w, 422, i18n.New("security.invalidNetworks"))
				return
			}
			jsonResponse(w, 200, map[string]bool{"allowed": policy.Allows(address)})
			return
		}
		if s.Network == nil {
			failure(w, 503, i18n.New("common.unavailable"))
			return
		}
		address, err := policy.ClientIP(r)
		loginAddress, loginErr := netip.ParseAddr(session.clientIP)
		if !input.ConfirmDisconnect && (err != nil || !policy.Allows(address) || loginErr != nil || !policy.Allows(loginAddress)) {
			jsonResponse(w, 200, map[string]bool{"saved": false})
			return
		}
		unlock := s.lockFactor(session.user.UID)
		defer unlock()
		if ctx.Err() != nil || session.ctx.Err() != nil {
			failure(w, 401, i18n.New("backend.server.signInToContinue"))
			return
		}
		if !time.Now().Before(session.networkAuthorizedUntil) {
			result, err := files.Run(ctx, session.user, files.Request{Operation: "security-status"})
			if err != nil {
				failure(w, 422, err)
				return
			}
			jsonResponse(w, 200, map[string]bool{"saved": false, "needsAuthorization": true, "requiresCode": result.Security.Enabled})
			return
		}
		if err := s.Network.Save(policy); err != nil {
			failure(w, 422, err)
			return
		}
		jsonResponse(w, 200, map[string]bool{"saved": true})
		s.pruneSecurity()
		return
	}
	if r.Method != "POST" {
		failure(w, 404, i18n.New("backend.server.endpointNotFound"))
		return
	}
	var input struct {
		Password string `json:"password"`
		Code     string `json:"code"`
	}
	if err := decode(w, r, &input, 8192); err != nil {
		failure(w, 400, err)
		return
	}
	session.factorMu.Lock()
	defer session.factorMu.Unlock()
	if r.URL.Path == "/api/security/setup" || r.URL.Path == "/api/security/disable" {
		if _, err := s.Gate.Authenticate(ctx, s.clientIP(r), session.user.Name, []byte(input.Password)); err != nil {
			failure(w, 401, err)
			return
		}
		input.Password = ""
	}
	if r.URL.Path == "/api/security/enable" || r.URL.Path == "/api/security/disable" {
		unlock := s.lockFactor(session.user.UID)
		defer unlock()
		if session.ctx.Err() != nil {
			failure(w, 401, i18n.New("backend.server.signInToContinue"))
			return
		}
	}
	switch r.URL.Path {
	case "/api/security/setup":
		result, err := files.Run(ctx, session.user, files.Request{Operation: "security-status"})
		if err != nil {
			failure(w, 422, err)
			return
		}
		if result.Security.Enabled {
			failure(w, 409, i18n.New("security.enabled"))
			return
		}
		session.enrollment = security.NewSecret()
		session.enrollmentExpires = time.Now().Add(5 * time.Minute)
		uri := security.URI(session.enrollment, session.user.Name+"@"+r.Host)
		png, err := qrcode.Encode(uri, qrcode.Medium, 256)
		if err != nil {
			failure(w, 500, err)
			return
		}
		jsonResponse(w, 200, map[string]string{"secret": session.enrollment, "qr": "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)})
	case "/api/security/enable":
		if session.enrollment == "" || time.Now().After(session.enrollmentExpires) {
			failure(w, 409, i18n.New("security.challengeExpired"))
			return
		}
		result, err := files.Run(ctx, session.user, files.Request{Operation: "security-enable", Content: session.enrollment, Version: strings.TrimSpace(input.Code)})
		if err != nil {
			failure(w, 422, err)
			return
		}
		session.enrollment = ""
		s.revokeOtherLogins(session)
		jsonResponse(w, 200, result.Security)
	case "/api/security/disable":
		result, err := files.Run(ctx, session.user, files.Request{Operation: "security-disable", Content: strings.TrimSpace(input.Code)})
		if err != nil {
			failure(w, 422, err)
			return
		}
		session.enrollment = ""
		s.revokeOtherLogins(session)
		jsonResponse(w, 200, result.Security)
	default:
		failure(w, 404, i18n.New("backend.server.endpointNotFound"))
	}
}

func (s *Server) unlockNetwork(w http.ResponseWriter, r *http.Request, ctx context.Context, session *login) {
	var input struct {
		Password string `json:"password"`
		Code     string `json:"code"`
	}
	if err := decode(w, r, &input, 8192); err != nil {
		failure(w, 400, err)
		return
	}
	if _, err := s.Gate.Authenticate(ctx, s.clientIP(r), session.user.Name, []byte(input.Password)); err != nil {
		failure(w, 401, err)
		return
	}
	unlock := s.lockFactor(session.user.UID)
	defer unlock()
	if ctx.Err() != nil || session.ctx.Err() != nil {
		failure(w, 401, i18n.New("backend.server.signInToContinue"))
		return
	}
	if _, err := files.Run(ctx, session.user, files.Request{Operation: "security-verify", Content: strings.TrimSpace(input.Code), Mode: "authenticator"}); err != nil {
		failure(w, 401, err)
		return
	}
	session.networkAuthorizedUntil = time.Now().Add(networkAuthorizationWindow)
	jsonResponse(w, 200, map[string]bool{"authorized": true})
}

func (s *Server) revokeOtherLogins(current *login) {
	current.networkAuthorizedUntil = time.Time{}
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, session := range s.logins {
		if session.user.UID == current.user.UID && session != current {
			session.cancel()
			delete(s.logins, key)
		}
	}
	for key, pending := range s.pendingLogins {
		if pending.user.UID == current.user.UID {
			delete(s.pendingLogins, key)
		}
	}
}
