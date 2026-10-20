package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
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

	"tuxee/internal/files"
	"tuxee/internal/identity"
	"tuxee/internal/monitor"
	"tuxee/internal/terminal"
	"tuxee/internal/tlsmanager"
	"tuxee/internal/update"
)

type login struct {
	user    identity.User
	csrf    string
	expires time.Time
	ctx     context.Context
	cancel  context.CancelFunc
}
type Server struct {
	Gate       *identity.Gate
	Terminals  *terminal.Manager
	TLS        *tlsmanager.Manager
	Origin     string
	Version    string
	Updates    *update.Checker
	Assets     fs.FS
	mu         sync.Mutex
	closed     atomic.Bool
	logins     map[[32]byte]*login
	archives   map[string]*archiveDownload
	fileSlots  chan struct{}
	scriptHash string
	monitor    *monitor.Collector
}

func New(gate *identity.Gate, terminals *terminal.Manager, tls *tlsmanager.Manager, origin string, assets fs.FS) *Server {
	s := &Server{Gate: gate, Terminals: terminals, TLS: tls, Origin: strings.TrimSuffix(origin, "/"), Assets: assets, logins: map[[32]byte]*login{}, archives: map[string]*archiveDownload{}, fileSlots: make(chan struct{}, 32)}
	s.monitor = monitor.New()
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
	jsonResponse(w, status, map[string]string{"error": err.Error()})
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
		return errors.New("invalid request body")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("request must contain one JSON value")
	}
	return nil
}
func (s *Server) origin(r *http.Request) string {
	if s.Origin != "" {
		return s.Origin
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}
func (s *Server) allowedOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	return origin == "" || origin == s.origin(r)
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
		failure(w, http.StatusServiceUnavailable, errors.New("server restarting"))
		return
	}
	if r.URL.Path == "/health" {
		w.Header().Set("Cache-Control", "no-store")
		w.Write([]byte("ok"))
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			path := "index.html"
			for _, encoding := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
				fields := strings.Split(strings.TrimSpace(encoding), ";")
				if fields[0] == "gzip" && (len(fields) == 1 || strings.TrimSpace(fields[1]) != "q=0") {
					path += ".gz"
					break
				}
			}
			data, err := fs.ReadFile(s.Assets, path)
			if err != nil {
				http.Error(w, "frontend build is unavailable", 500)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Vary", "Accept-Encoding")
			if strings.HasSuffix(path, ".gz") {
				w.Header().Set("Content-Encoding", "gzip")
			}
			http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(data))
			return
		}
		http.FileServer(http.FS(s.Assets)).ServeHTTP(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if !s.allowedOrigin(r) {
		failure(w, 403, errors.New("request origin is not allowed"))
		return
	}
	if r.URL.Path == "/api/login" && r.Method == http.MethodPost {
		s.signIn(w, r)
		return
	}
	cookie, err := r.Cookie("tuxee_session")
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
		failure(w, http.StatusServiceUnavailable, errors.New("server restarting"))
		return
	}
	if r.URL.Path == "/api/connection" && r.Method == "GET" {
		jsonResponse(w, 200, map[string]bool{"authenticated": session != nil})
		return
	}
	if session == nil {
		if err != nil {
			failure(w, 401, errors.New("sign in to continue"))
		} else {
			failure(w, 401, errors.New("session expired; sign in again"))
		}
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Tuxee-CSRF")), []byte(session.csrf)) != 1 {
		failure(w, 403, errors.New("invalid session request token"))
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(session.ctx, cancel)
	defer stop()
	defer cancel()
	r = r.WithContext(ctx)
	switch {
	case r.URL.Path == "/api/update" && (r.Method == "GET" || r.Method == "POST"):
		if s.Updates == nil {
			failure(w, 503, errors.New("update checks unavailable"))
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
		command := "'" + strings.ReplaceAll(path, "'", "'\\''") + "' update"
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
			failure(w, 500, errors.New("system information is unavailable"))
			return
		}
		jsonResponse(w, 200, info)
	case r.URL.Path == "/api/me" && r.Method == "GET":
		settings, err := LoadSettings(ctx, session.user)
		if err != nil {
			failure(w, 500, err)
			return
		}
		jsonResponse(w, 200, map[string]any{"user": session.user, "csrf": session.csrf, "settings": settings})
	case r.URL.Path == "/api/logout" && r.Method == "POST":
		s.mu.Lock()
		delete(s.logins, key)
		session.cancel()
		s.mu.Unlock()
		http.SetCookie(w, &http.Cookie{Name: "tuxee_session", Path: "/", MaxAge: -1, HttpOnly: true, Secure: strings.HasPrefix(s.origin(r), "https:"), SameSite: http.SameSiteStrictMode})
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
			err = validateSettings(value)
		}
		if err != nil {
			failure(w, 400, err)
			return
		}
		data, _ := json.Marshal(value)
		if _, err = files.Run(ctx, session.user, files.Request{Operation: "settings-save", Settings: data}); err != nil {
			failure(w, 400, err)
			return
		}
		jsonResponse(w, 200, value)
	case r.URL.Path == "/api/files" && r.Method == "POST":
		s.fileOperation(w, r, session)
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
		value, err := s.Terminals.Create(session.user, input.Directory, input.Name, input.Columns, input.Rows, input.Command)
		if err != nil {
			failure(w, 400, err)
			return
		}
		jsonResponse(w, 201, value.Info())
	case strings.HasPrefix(r.URL.Path, "/api/terminals/"):
		s.terminalRoute(w, r, session)
	case r.URL.Path == "/api/tls" && r.Method == "GET":
		if s.TLS == nil {
			jsonResponse(w, 200, map[string]string{"source": "http"})
			return
		}
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		jsonResponse(w, 200, s.TLS.Status(host))
	case r.URL.Path == "/api/tls/ca" && r.Method == "GET" && s.TLS != nil:
		w.Header().Set("Content-Type", "application/x-pem-file")
		w.Header().Set("Content-Disposition", `attachment; filename="tuxee-local-ca.crt"`)
		w.Write(s.TLS.RootCertificate())
	default:
		failure(w, 404, errors.New("endpoint not found"))
	}
}

func (s *Server) signIn(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Tuxee-Client") != "web" {
		failure(w, 403, errors.New("missing application request header"))
		return
	}
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
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
			failure(w, http.StatusServiceUnavailable, errors.New("server restarting"))
		} else {
			failure(w, 401, err)
		}
		return
	}
	token := randomToken()
	ctx, cancel := context.WithCancel(context.Background())
	session := &login{user: user, csrf: randomToken(), expires: time.Now().Add(24 * time.Hour), ctx: ctx, cancel: cancel}
	s.mu.Lock()
	if s.closed.Load() {
		s.mu.Unlock()
		cancel()
		failure(w, http.StatusServiceUnavailable, errors.New("server restarting"))
		return
	}
	if len(s.logins) >= 1024 {
		s.mu.Unlock()
		cancel()
		failure(w, 503, errors.New("too many active login sessions"))
		return
	}
	if old, err := r.Cookie("tuxee_session"); err == nil {
		key := sha256.Sum256([]byte(old.Value))
		if oldSession := s.logins[key]; oldSession != nil {
			oldSession.cancel()
			delete(s.logins, key)
		}
	}
	s.logins[sha256.Sum256([]byte(token))] = session
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "tuxee_session", Value: token, Path: "/", HttpOnly: true, Secure: strings.HasPrefix(s.origin(r), "https:"), SameSite: http.SameSiteStrictMode, MaxAge: 86400})
	jsonResponse(w, 200, map[string]any{"user": user, "csrf": session.csrf})
}

func (s *Server) fileSlot(w http.ResponseWriter) bool {
	select {
	case s.fileSlots <- struct{}{}:
		return true
	default:
		failure(w, 429, errors.New("file operations are busy; try again shortly"))
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
	case "list", "stat", "mkdir", "delete", "chmod", "rename", "copy", "move", "read", "write", "archive-formats", "compress", "extract":
	default:
		failure(w, 400, errors.New("invalid file operation"))
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
func (s *Server) upload(w http.ResponseWriter, r *http.Request, session *login) {
	size, err := strconv.ParseInt(r.Header.Get("X-Tuxee-Size"), 10, 64)
	if err != nil || size < 0 || size > 1<<40 {
		failure(w, 400, errors.New("invalid upload byte size (maximum 1 TiB)"))
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
		return errors.New("origin must be an HTTP(S) origin without a path")
	}
	return nil
}
