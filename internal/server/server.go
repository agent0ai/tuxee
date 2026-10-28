package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"html"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"tuxee/internal/audio"
	"tuxee/internal/files"
	"tuxee/internal/i18n"
	"tuxee/internal/identity"
	"tuxee/internal/monitor"
	"tuxee/internal/processes"
	"tuxee/internal/terminal"
	"tuxee/internal/tlsmanager"
	"tuxee/internal/update"
)

type login struct {
	translations    *i18n.Bundle
	user            identity.User
	csrf            string
	expires         time.Time
	ctx             context.Context
	cancel          context.CancelFunc
	processMu       sync.Mutex
	processSnapshot *processSnapshot
}
type Server struct {
	Gate           *identity.Gate
	Terminals      *terminal.Manager
	TLS            *tlsmanager.Manager
	Origin         string
	Version        string
	Updates        *update.Checker
	Restart        func()
	Assets         fs.FS
	cookieName     string
	languageCookie string
	Translations   *i18n.Store
	mu             sync.Mutex
	settingsMu     sync.Mutex
	closed         atomic.Bool
	logins         map[[32]byte]*login
	archives       map[string]*archiveDownload
	fileSlots      chan struct{}
	clipSlots      chan struct{}
	sizeSlots      chan struct{}
	scriptHash     string
	monitor        *monitor.Collector
	processReads   chan struct{}
	processKills   chan struct{}
}

func New(instanceID string, gate *identity.Gate, terminals *terminal.Manager, tls *tlsmanager.Manager, origin string, assets fs.FS) *Server {
	s := &Server{Gate: gate, Terminals: terminals, TLS: tls, Origin: strings.TrimSuffix(origin, "/"), Assets: assets, logins: map[[32]byte]*login{}, archives: map[string]*archiveDownload{}, fileSlots: make(chan struct{}, 64), clipSlots: make(chan struct{}, 2)}
	s.cookieName = "tuxee_session_" + instanceID
	s.languageCookie = "tuxee_language_" + instanceID
	s.Translations = i18n.NewStore(i18n.SystemDirectory)
	s.monitor = monitor.New()
	s.processReads = make(chan struct{}, 2)
	s.sizeSlots = make(chan struct{}, 2)
	s.processKills = make(chan struct{}, 2)
	if data, err := fs.ReadFile(assets, "script-csp.txt"); err == nil {
		if hash, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data))); err == nil && len(hash) == 32 {
			s.scriptHash = " 'sha256-" + base64.StdEncoding.EncodeToString(hash) + "'"
		}
	}
	return s
}
func randomToken() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func jsonResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func failure(w http.ResponseWriter, status int, err error) {
	jsonResponse(w, status, map[string]any{"error": err.Error(), "text": i18n.Describe(err)})
}
func decode(w http.ResponseWriter, r *http.Request, value any, limits ...int64) error {
	limit := int64(512 << 10)
	if len(limits) > 0 {
		limit = limits[0]
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return i18n.New("backend.server.invalidRequestBody")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return i18n.New("backend.server.requestMustContainOneJSONValue")
	}
	return nil
}
func (s *Server) origin(r *http.Request) string {
	if s.Origin != "" {
		return s.Origin
	}
	scheme := "http"
	// Proxy/browser hints may enable HTTPS cookies and links, never relax origin admission.
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" || strings.HasPrefix(r.Header.Get("Origin"), "https://") {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}
func (s *Server) allowedOrigin(r *http.Request) bool {
	check := *r
	// API GETs include interactive WebSockets; apply unsafe-request checks to every method.
	check.Method = http.MethodPost
	if s.Origin != "" {
		target, err := url.Parse(s.Origin)
		if err != nil {
			return false
		}
		check.Host = target.Host
	}
	return new(http.CrossOriginProtection).Check(&check) == nil
}
func (s *Server) Close() {
	s.closed.Store(true)
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, session := range s.logins {
		session.cancel()
		delete(s.logins, key)
	}
}
func (s *Server) Prune(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.mu.Lock()
			for key, session := range s.logins {
				if time.Now().After(session.expires) {
					session.cancel()
					delete(s.logins, key)
				}
			}
			s.mu.Unlock()
		}
	}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'"+s.scriptHash+"; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; frame-ancestors 'none'; frame-src 'self'; object-src 'self'; media-src 'self'; base-uri 'self'")
	if s.closed.Load() {
		w.Header().Set("Cache-Control", "no-store")
		failure(w, http.StatusServiceUnavailable, i18n.New("backend.server.serverRestarting"))
		return
	}
	if r.URL.Path == "/health" {
		w.Header().Set("Cache-Control", "no-store")
		w.Write([]byte("ok"))
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			bundle := s.requestTranslations(r)
			translations, _ := json.Marshal(bundle)
			compressed := false
			for _, encoding := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
				fields := strings.Split(strings.TrimSpace(encoding), ";")
				if fields[0] == "gzip" && (len(fields) == 1 || strings.TrimSpace(fields[1]) != "q=0") {
					compressed = true
					break
				}
			}
			data, err := fs.ReadFile(s.Assets, "index.html")
			if err != nil {
				http.Error(w, (&i18n.Catalog{Texts: bundle.Texts}).Text(i18n.Message{Key: "server.frontendUnavailable"}), 500)
				return
			}
			hostname, err := os.Hostname()
			if err != nil {
				http.Error(w, (&i18n.Catalog{Texts: bundle.Texts}).Text(i18n.Message{Key: "server.hostnameUnavailable"}), 500)
				return
			}
			data = []byte(strings.NewReplacer(
				"{{i18n}}", string(translations),
				"{{language}}", html.EscapeString(bundle.Language),
				"{{direction}}", bundle.Direction,
				"{{tagline}}", html.EscapeString((&i18n.Catalog{Texts: bundle.Texts}).Text(i18n.Message{Key: "app.tagline"})),
				"{{previewAlt}}", html.EscapeString((&i18n.Catalog{Texts: bundle.Texts}).Text(i18n.Message{Key: "app.previewAlt"})),
				"{{loading}}", html.EscapeString((&i18n.Catalog{Texts: bundle.Texts}).Text(i18n.Message{Key: "app.loading"})),
				"{{origin}}", html.EscapeString(s.origin(r)),
				"{{hostname}}", html.EscapeString(hostname),
				"{{version}}", html.EscapeString(s.Version),
			).Replace(string(data)))
			if compressed {
				var buffer bytes.Buffer
				writer := gzip.NewWriter(&buffer)
				writer.Write(data)
				writer.Close()
				data = buffer.Bytes()
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "private, no-store")
			w.Header().Set("Vary", "Accept-Encoding, Cookie")
			if compressed {
				w.Header().Set("Content-Encoding", "gzip")
			}
			http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(data))
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			if info, err := fs.Stat(s.Assets, strings.TrimPrefix(r.URL.Path, "/")); err == nil && !info.IsDir() {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
		}
		http.FileServer(http.FS(s.Assets)).ServeHTTP(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if !s.allowedOrigin(r) {
		failure(w, 403, i18n.New("backend.server.requestOriginIsNotAllowed"))
		return
	}
	if r.URL.Path == "/api/language" && r.Method == http.MethodGet {
		if session := s.requestSession(r); session != nil && session.translations != nil {
			jsonResponse(w, 200, session.translations)
		} else {
			s.Translations.Refresh()
			code := r.URL.Query().Get("language")
			if code == "" {
				if cookie, err := r.Cookie(s.languageCookie); err == nil {
					code = cookie.Value
				}
			}
			jsonResponse(w, 200, s.Translations.Bundle(code, s.languageCookie))
		}
		return
	}
	if r.URL.Path == "/api/login" && r.Method == http.MethodPost {
		s.signIn(w, r)
		return
	}
	cookie, err := r.Cookie(s.cookieName)
	var key [32]byte
	if err == nil {
		key = sha256.Sum256([]byte(cookie.Value))
	}
	s.mu.Lock()
	session := s.logins[key]
	if session != nil && time.Now().After(session.expires) {
		session.cancel()
		delete(s.logins, key)
		session = nil
	}
	s.mu.Unlock()
	if s.closed.Load() {
		failure(w, http.StatusServiceUnavailable, i18n.New("backend.server.serverRestarting"))
		return
	}
	if r.URL.Path == "/api/connection" && r.Method == "GET" {
		state := map[string]any{"authenticated": session != nil}
		if session != nil {
			state["uid"] = session.user.UID
			state["csrf"] = session.csrf
			if session.translations != nil {
				state["language"] = session.translations.Language
			}
		}
		jsonResponse(w, 200, state)
		return
	}
	if session == nil {
		if err != nil {
			failure(w, 401, i18n.New("backend.server.signInToContinue"))
		} else {
			failure(w, 401, i18n.New("backend.server.sessionExpiredSignInAgain"))
		}
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Tuxee-CSRF")), []byte(session.csrf)) != 1 {
		failure(w, 403, i18n.New("backend.server.invalidSessionRequestToken"))
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(session.ctx, cancel)
	defer stop()
	defer cancel()
	r = r.WithContext(ctx)
	switch {
	case r.URL.Path == "/api/audio" && r.Method == "GET":
		s.userAudio(w, r, session)
	case r.URL.Path == "/api/restart" && r.Method == "POST":
		if s.Restart == nil {
			failure(w, 503, i18n.New("backend.server.runtimeRestartIsUnavailable"))
			return
		}
		select {
		case s.processKills <- struct{}{}:
			defer func() { <-s.processKills }()
		default:
			failure(w, 429, i18n.New("backend.server.processSignallingIsBusy"))
			return
		}
		if _, err := processes.Run(ctx, session.user, processes.Request{Operation: "check-parent-signal"}); err != nil {
			executable, pathErr := os.Executable()
			if pathErr != nil {
				failure(w, 500, pathErr)
				return
			}
			command := update.Command(executable) + " restart"
			if session.user.UID != 0 {
				command = "sudo " + command
			}
			jsonResponse(w, 403, struct {
				Error   string        `json:"error"`
				Text    *i18n.Message `json:"text"`
				Command string        `json:"command"`
			}{i18n.New("server.restartDenied", i18n.Vars{"detail": i18n.Describe(err)}).Error(), &i18n.Message{Key: "server.restartDenied", Vars: i18n.Vars{"detail": i18n.Describe(err)}}, command})
			return
		}
		if !s.closed.CompareAndSwap(false, true) {
			failure(w, 503, i18n.New("backend.server.serverRestarting"))
			return
		}
		jsonResponse(w, http.StatusAccepted, map[string]bool{"ok": true})
		s.Restart()
	case r.URL.Path == "/api/processes" && (r.Method == "GET" || r.Method == "POST" || r.Method == "DELETE"):
		s.processOperation(w, r, session)
	case r.URL.Path == "/api/update" && (r.Method == "GET" || r.Method == "POST"):
		if s.Updates == nil {
			failure(w, 503, i18n.New("backend.server.updateChecksUnavailable"))
			return
		}
		status := s.Updates.Status()
		if r.Method == "POST" {
			status = s.Updates.Check(ctx)
		}
		path, err := os.Executable()
		if err != nil {
			failure(w, 500, err)
			return
		}
		command := update.Command(path) + " update"
		if session.user.UID != 0 {
			command = "sudo " + command
		}
		jsonResponse(w, 200, struct {
			update.Status
			Command string `json:"command"`
		}{status, command})
	case r.URL.Path == "/api/metrics" && r.Method == "GET":
		jsonResponse(w, 200, s.monitor.Sample())
	case r.URL.Path == "/api/system" && r.Method == "GET":
		info, err := readSystemInfo(s.Version, session.user)
		if err != nil {
			failure(w, 500, i18n.New("backend.server.systemInformationIsUnavailable"))
			return
		}
		jsonResponse(w, 200, info)
	case r.URL.Path == "/api/me" && r.Method == "GET":
		settings, err := LoadSettings(ctx, session.user)
		if err != nil {
			failure(w, 500, err)
			return
		}
		jsonResponse(w, 200, map[string]any{"user": session.user, "csrf": session.csrf, "settings": settings, "audio": audio.Available(), "i18n": session.translations})
	case r.URL.Path == "/api/logout" && r.Method == "POST":
		s.mu.Lock()
		delete(s.logins, key)
		session.cancel()
		s.mu.Unlock()
		http.SetCookie(w, &http.Cookie{Name: s.cookieName, Path: "/", MaxAge: -1, HttpOnly: true, Secure: strings.HasPrefix(s.origin(r), "https:"), SameSite: http.SameSiteStrictMode})
		jsonResponse(w, 200, map[string]bool{"ok": true})
	case r.URL.Path == "/api/settings" && r.Method == "PUT":
		// Accept old clients' timeout field without retaining or applying it.
		var input struct {
			Settings
			IdleHours json.RawMessage `json:"idleHours"`
		}
		err = decode(w, r, &input)
		value := input.Settings
		if err == nil {
			err = validateSettings(&value)
		}
		if err != nil {
			failure(w, 400, err)
			return
		}
		data, _ := json.Marshal(value)
		s.settingsMu.Lock()
		defer s.settingsMu.Unlock()
		if _, err = files.Run(ctx, session.user, files.Request{Operation: "settings-save", Settings: data}); err != nil {
			failure(w, 400, err)
			return
		}
		background, foreground := value.terminalColors()
		s.Terminals.SetBackground(session.user, background, foreground)
		jsonResponse(w, 200, value)
	case r.URL.Path == "/api/files" && r.Method == "POST":
		s.fileOperation(w, r, session)
	case r.URL.Path == "/api/file-size" && r.Method == "POST":
		s.fileSize(w, r, session)
	case r.URL.Path == "/api/upload" && r.Method == "POST":
		s.upload(w, r, session)
	case strings.HasPrefix(r.URL.Path, "/api/preview/") && (r.Method == "GET" || r.Method == "HEAD"):
		s.preview(w, r, session)
	case r.URL.Path == "/api/download" && r.Method == "GET":
		s.download(w, r, session)
	case r.URL.Path == "/api/download-archive" && (r.Method == "POST" || r.Method == "GET" || r.Method == "DELETE"):
		s.archiveOperation(w, r, session)
	case r.URL.Path == "/api/terminals" && r.Method == "GET":
		jsonResponse(w, 200, s.Terminals.List(session.user))
	case r.URL.Path == "/api/terminals" && r.Method == "POST":
		var input struct {
			Directory string `json:"directory"`
			Name      string `json:"name"`
			Columns   int    `json:"columns"`
			Rows      int    `json:"rows"`
			Command   string `json:"command"`
		}
		if err = decode(w, r, &input); err != nil {
			failure(w, 400, err)
			return
		}
		// Keep creation ordered with saved colors and updates to retained terminals.
		s.settingsMu.Lock()
		defer s.settingsMu.Unlock()
		settings, err := LoadSettings(ctx, session.user)
		if err != nil {
			failure(w, 500, err)
			return
		}
		background, foreground := settings.terminalColors()
		if input.Directory == "" {
			input.Directory = settings.defaultDirectory(session.user.Home)
		}
		value, err := s.Terminals.Create(session.user, input.Directory, input.Name, input.Columns, input.Rows, input.Command, background, foreground, settings.ShellCommand, settings.UseTuxeePrompt == nil || *settings.UseTuxeePrompt, session.translations.Language)
		if err != nil {
			failure(w, 400, err)
			return
		}
		jsonResponse(w, 201, value.Info())
	case strings.HasPrefix(r.URL.Path, "/api/terminals/"):
		s.terminalRoute(w, r, session)
	case r.URL.Path == "/api/tls" && r.Method == "GET":
		direct := r.TLS != nil && s.TLS != nil
		for name := range r.Header {
			name = strings.ToLower(name)
			if name == "forwarded" || name == "via" || strings.HasPrefix(name, "x-forwarded-") {
				direct = false
				break
			}
		}
		if direct {
			jsonResponse(w, 200, s.TLS.Status(r.TLS.ServerName))
			return
		}
		// A proxy's browser-facing certificate is not the backend certificate.
		source := "http"
		if r.TLS != nil {
			source = "https"
		}
		jsonResponse(w, 200, map[string]string{"source": source})
	case r.URL.Path == "/api/tls/ca" && r.Method == "GET" && s.TLS != nil:
		w.Header().Set("Content-Type", "application/x-pem-file")
		w.Header().Set("Content-Disposition", `attachment; filename="tuxee-local-ca.crt"`)
		w.Write(s.TLS.RootCertificate())
	default:
		failure(w, 404, i18n.New("backend.server.endpointNotFound"))
	}
}

func (s *Server) signIn(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Tuxee-Client") != "web" {
		failure(w, 403, i18n.New("backend.server.missingApplicationRequestHeader"))
		return
	}
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Language string `json:"language"`
	}
	if err := decode(w, r, &input); err != nil {
		failure(w, 400, err)
		return
	}
	peer, _, _ := net.SplitHostPort(r.RemoteAddr)
	password := []byte(input.Password)
	input.Password = ""
	user, err := s.Gate.Authenticate(r.Context(), peer, input.Username, password)
	if err != nil {
		if s.closed.Load() {
			failure(w, http.StatusServiceUnavailable, i18n.New("backend.server.serverRestarting"))
		} else {
			failure(w, 401, err)
		}
		return
	}
	s.Terminals.PruneHistory(user)
	token := randomToken()
	ctx, cancel := context.WithCancel(context.Background())
	session := &login{user: user, csrf: randomToken(), expires: time.Now().Add(24 * time.Hour), ctx: ctx, cancel: cancel}
	s.Translations.Refresh()
	session.translations = s.Translations.Bundle(input.Language, s.languageCookie)
	s.mu.Lock()
	if s.closed.Load() {
		s.mu.Unlock()
		cancel()
		failure(w, http.StatusServiceUnavailable, i18n.New("backend.server.serverRestarting"))
		return
	}
	if len(s.logins) >= 1024 {
		s.mu.Unlock()
		cancel()
		failure(w, 503, i18n.New("backend.server.tooManyActiveLoginSessions"))
		return
	}
	if old, err := r.Cookie(s.cookieName); err == nil {
		key := sha256.Sum256([]byte(old.Value))
		if oldSession := s.logins[key]; oldSession != nil {
			oldSession.cancel()
			delete(s.logins, key)
		}
	}
	s.logins[sha256.Sum256([]byte(token))] = session
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: s.cookieName, Value: token, Path: "/", HttpOnly: true, Secure: strings.HasPrefix(s.origin(r), "https:"), SameSite: http.SameSiteStrictMode, MaxAge: 86400})
	jsonResponse(w, 200, map[string]any{"user": user, "csrf": session.csrf})
}

func (s *Server) fileSlot(w http.ResponseWriter) bool {
	select {
	case s.fileSlots <- struct{}{}:
		return true
	default:
		failure(w, 429, i18n.New("backend.server.fileOperationsAreBusyTryAgainShortly"))
		return false
	}
}
func (s *Server) fileOperation(w http.ResponseWriter, r *http.Request, session *login) {
	var input files.Request
	if err := decode(w, r, &input, 8<<20); err != nil {
		failure(w, 400, err)
		return
	}
	switch input.Operation {
	case "list", "stat", "mkdir", "delete", "trash", "trash-list", "trash-restore", "trash-delete", "trash-empty", "chmod", "rename", "copy", "move", "read", "write", "archive-formats", "compress", "extract":
	default:
		failure(w, 400, i18n.New("backend.server.invalidFileOperation"))
		return
	}
	if !s.fileSlot(w) {
		return
	}
	defer func() { <-s.fileSlots }()
	response, err := files.Run(r.Context(), session.user, input)
	if err != nil {
		failure(w, 400, err)
		return
	}
	jsonResponse(w, 200, response)
}

const maxUploadBytes = 1 << 40

func (s *Server) upload(w http.ResponseWriter, r *http.Request, session *login) {
	size, err := strconv.ParseInt(r.Header.Get("X-Tuxee-Size"), 10, 64)
	if err != nil || size < 0 || size > maxUploadBytes {
		failure(w, 400, i18n.New("backend.server.uploadSizeLimit", i18n.Vars{"maxTiB": float64(maxUploadBytes) / (1 << 40)}))
		return
	}
	if !s.fileSlot(w) {
		return
	}
	defer func() { <-s.fileSlots }()
	r.Body = http.MaxBytesReader(w, r.Body, size+1)
	process, err := files.Start(r.Context(), session.user, files.Request{Operation: "upload", Path: r.URL.Query().Get("path"), Size: size, Unique: r.URL.Query().Get("unique") == "true"}, r.Body)
	if err != nil {
		failure(w, 400, err)
		return
	}
	defer process.Cancel()
	if err = process.Wait(); err != nil {
		failure(w, 400, err)
		return
	}
	jsonResponse(w, 200, process.Response)
}
func (s *Server) download(w http.ResponseWriter, r *http.Request, session *login) {
	if token := r.URL.Query().Get("archive"); token != "" {
		s.downloadArchive(w, r, session, token)
		return
	}
	if !s.fileSlot(w) {
		return
	}
	defer func() { <-s.fileSlots }()
	process, err := files.Start(r.Context(), session.user, files.Request{Operation: "download", Path: r.URL.Query().Get("path")}, nil)
	if err != nil {
		failure(w, 400, err)
		return
	}
	defer process.Cancel()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filepath.Base(process.Response.Entry.Path)}))
	w.Header().Set("Content-Length", strconv.FormatInt(process.Response.Entry.Size, 10))
	_, _ = io.Copy(w, process.Reader)
	_ = process.Wait()
}

func ValidateOrigin(value string) error {
	if value == "" {
		return nil
	}
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.Scheme != "http" && u.Scheme != "https" || u.User != nil || u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.Fragment != "" {
		return i18n.New("backend.server.originMustBeAnHTTPSOriginWithoutAPath")
	}
	return nil
}
