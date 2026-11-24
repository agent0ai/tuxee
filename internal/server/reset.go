package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"html/template"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"tuxee/internal/files"
	"tuxee/internal/i18n"
	"tuxee/internal/identity"
)

// resetJob tracks the latest configuration reset of one Linux account in this runtime.
type resetJob struct {
	epoch   string
	running bool
	backup  string
	err     error
}

type resetJobs struct {
	mu   sync.Mutex
	jobs map[uint32]*resetJob
}

// The reset page uses no application bundle, WebSocket or saved setting, so it keeps working
// when the workspace cannot load. Its only script is static and admitted by hash.
const resetScript = `(() => {
const data = document.body.dataset, status = document.getElementById('reset-status');
const confirm = document.getElementById('reset-confirm'), cancel = document.getElementById('reset-cancel');
const show = (text, state) => { status.textContent = text; document.body.dataset.state = state; };
const fail = text => { show(text, 'failed'); confirm.disabled = false; };
async function poll() {
	for (;;) {
		let value;
		try {
			const response = await fetch('/api/reset', { credentials: 'same-origin', cache: 'no-store' });
			value = await response.json();
			if (!response.ok || typeof value.message !== 'string') throw new Error();
		} catch { fail(data.unavailable); return; }
		show(value.message, value.state);
		if (value.state === 'done') { setTimeout(() => location.replace('/'), 1500); return; }
		if (value.state !== 'running') { confirm.disabled = false; return; }
		await new Promise(resolve => setTimeout(resolve, 500));
	}
}
confirm.addEventListener('click', async () => {
	confirm.disabled = true; cancel.hidden = true;
	show(data.progress, 'running');
	try {
		const response = await fetch('/api/reset', { method: 'POST', credentials: 'same-origin', headers: { 'X-Tuxee-CSRF': data.csrf } });
		const value = await response.json().catch(() => ({}));
		if (!response.ok) { fail(typeof value.message === 'string' ? value.message : data.unavailable); return; }
		if (typeof value.csrf === 'string') data.csrf = value.csrf;
	} catch { fail(data.unavailable); return; }
	poll();
});
if (data.state === 'running') { confirm.disabled = true; cancel.hidden = true; poll(); }
})();`

var resetScriptHash = func() string {
	sum := sha256.Sum256([]byte(resetScript))
	return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
}()

const resetPolicy = "default-src 'none'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; script-src "

var resetPage = template.Must(template.New("reset").Parse(`<!doctype html>
<html lang="{{.Language}}" dir="{{.Direction}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>{{.Title}}</title>
<link rel="icon" href="/favicon.png">
<style>
:root { font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color-scheme: dark; font-size: 14px; background: #0c1017; color: #e3e9f2; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 16px;
	background: radial-gradient(ellipse at 25% 35%, #202d4f66, transparent 50%), #0c1017; }
main { width: min(480px, 100%); background: #141922; border: 1px solid #283142; border-radius: 12px; padding: 24px; box-shadow: 0 16px 48px #0008; }
h1 { margin: 0 0 12px; font-size: 20px; }
p { margin: 0; line-height: 1.6; }
ul { margin: 10px 0 18px; padding-inline-start: 20px; color: #b7c1d1; line-height: 1.6; }
li + li { margin-top: 4px; }
code { overflow-wrap: anywhere; }
.status { min-height: 1.6em; margin-bottom: 14px; overflow-wrap: anywhere; }
.status:empty { display: none; }
[data-state="failed"] .status { color: #ff969f; }
.progress { display: none; height: 4px; border-radius: 2px; margin-bottom: 18px; background: #283142; overflow: hidden; }
.progress::after { content: ""; display: block; width: 35%; height: 100%; border-radius: inherit; background: #a5b5ff; animation: slide 1.1s ease-in-out infinite; }
[data-state="running"] .progress, [data-state="done"] .progress { display: block; }
[data-state="done"] .progress::after { width: 100%; animation: none; }
@keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(290%); } }
.actions { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
a, button { font: inherit; display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 6px 14px; border-radius: 7px; border: 1px solid #283142; cursor: pointer; text-decoration: none; }
a { color: #e3e9f2; background: transparent; }
a[hidden] { display: none; }
button { background: #ff969f; color: #3a1015; border-color: transparent; font-weight: 650; }
button:disabled { opacity: .5; cursor: default; }
:focus-visible { outline: 2px solid #a5b5ff; outline-offset: 2px; }
</style>
</head>
<body class="reset-page" data-state="{{.State}}" data-csrf="{{.CSRF}}" data-progress="{{.Progress}}" data-unavailable="{{.Unavailable}}">
<main role="dialog" aria-modal="true" aria-labelledby="reset-title">
<h1 id="reset-title">{{.Title}}</h1>
<p>{{.Intro}}</p>
<ul>{{range .Effects}}<li>{{.}}</li>{{end}}</ul>
<p class="status" id="reset-status" role="status" aria-live="polite">{{.Status}}</p>
<div class="progress" aria-hidden="true"></div>
<div class="actions"><a id="reset-cancel" href="/">{{.Cancel}}</a><button id="reset-confirm" type="button">{{.Confirm}}</button></div>
</main>
<script>` + resetScript + `</script>
</body>
</html>
`))

// resetView serves the standalone confirmation page to an authenticated account.
func (s *Server) resetView(w http.ResponseWriter, r *http.Request, session *login) {
	bundle := session.translations
	if bundle == nil {
		bundle = s.requestTranslations(r)
	}
	catalog := &i18n.Catalog{Texts: bundle.Texts}
	text := func(key string, vars i18n.Vars) string { return catalog.Text(i18n.Message{Key: key, Vars: vars}) }
	state, status := s.resetStatus(session.user.UID, catalog)
	if state != "running" {
		state, status = "idle", ""
	}
	user := i18n.Vars{"user": session.user.Name}
	data := map[string]any{
		"Language": bundle.Language, "Direction": bundle.Direction, "State": state, "CSRF": session.csrf, "Status": status,
		"Title": text("reset.title", nil), "Intro": text("reset.intro", user),
		"Effects": []string{
			text("reset.effectTerminals", nil),
			text("reset.effectDefaults", nil),
			text("reset.effectBackup", i18n.Vars{"path": "~/" + files.ResetBackupDirectory}),
			text("reset.effectFiles", nil),
			text("reset.effectSessions", user),
		},
		"Progress": text("reset.progress", nil), "Unavailable": text("reset.statusUnavailable", nil),
		"Cancel": text("common.cancel", nil), "Confirm": text("reset.confirm", nil),
	}
	var page bytes.Buffer
	if err := resetPage.Execute(&page, data); err != nil {
		failure(w, 500, err)
		return
	}
	w.Header().Set("Content-Security-Policy", resetPolicy+resetScriptHash)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie")
	if r.Method == http.MethodHead {
		return
	}
	w.Write(page.Bytes())
}

// resetStatus returns the latest job state and its translated message.
func (s *Server) resetStatus(uid uint32, catalog *i18n.Catalog) (string, string) {
	s.resets.mu.Lock()
	defer s.resets.mu.Unlock()
	job := s.resets.jobs[uid]
	switch {
	case job == nil:
		return "idle", ""
	case job.running:
		return "running", catalog.Text(i18n.Message{Key: "reset.progress"})
	case job.err != nil:
		return "failed", catalog.Text(i18n.Message{Key: "reset.failed", Vars: i18n.Vars{"detail": i18n.Describe(job.err)}})
	}
	return "done", catalog.Text(i18n.Message{Key: "reset.complete", Vars: i18n.Vars{"path": job.backup}})
}

// resetEpoch identifies the account's latest reset so stale workspace tabs reload.
func (s *Server) resetEpoch(uid uint32) string {
	s.resets.mu.Lock()
	defer s.resets.mu.Unlock()
	if job := s.resets.jobs[uid]; job != nil {
		return job.epoch
	}
	return ""
}

func (s *Server) resetOperation(w http.ResponseWriter, r *http.Request, session *login) {
	bundle := session.translations
	if bundle == nil {
		bundle = s.requestTranslations(r)
	}
	catalog := &i18n.Catalog{Texts: bundle.Texts}
	if r.Method == http.MethodGet {
		state, message := s.resetStatus(session.user.UID, catalog)
		jsonResponse(w, 200, map[string]string{"state": state, "message": message})
		return
	}
	s.resets.mu.Lock()
	if s.resets.jobs == nil {
		s.resets.jobs = map[uint32]*resetJob{}
	}
	job := s.resets.jobs[session.user.UID]
	if job == nil || !job.running {
		job = &resetJob{epoch: randomToken(), running: true}
		s.resets.jobs[session.user.UID] = job
		go s.resetAccount(session.user, job)
	}
	s.resets.mu.Unlock()
	// Replace every login of this account so other browsers cannot save stale layouts.
	token, replacement := randomToken(), &login{user: session.user, translations: session.translations, csrf: randomToken(), expires: session.expires}
	replacement.ctx, replacement.cancel = context.WithCancel(context.Background())
	s.mu.Lock()
	for key, other := range s.logins {
		if other.user.UID == session.user.UID {
			other.cancel()
			delete(s.logins, key)
		}
	}
	s.logins[sha256.Sum256([]byte(token))] = replacement
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: s.cookieName, Value: token, Path: "/", HttpOnly: true, Secure: strings.HasPrefix(s.origin(r), "https:"), SameSite: http.SameSiteStrictMode, MaxAge: int(time.Until(session.expires).Seconds())})
	jsonResponse(w, 202, map[string]string{"state": "running", "message": catalog.Text(i18n.Message{Key: "reset.progress"}), "csrf": replacement.csrf})
}

// resetAccount terminates the account's terminals (and with them GUI and audio runtimes),
// then moves its Tuxee configuration and state into a backup. Holding settingsMu keeps
// settings saves, editor reconciliation and terminal creation out until defaults apply.
func (s *Server) resetAccount(user identity.User, job *resetJob) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	for _, info := range s.Terminals.List(user) {
		session, err := s.Terminals.Get(user, info.ID)
		if err != nil {
			continue
		}
		if err = session.Close(); err != nil {
			log.Printf("reset %s: terminal %s: %v", user.Name, info.ID, err)
		}
	}
	result, err := files.Run(ctx, user, files.Request{Operation: "config-reset"})
	if err != nil {
		log.Printf("reset %s: %v", user.Name, err)
	} else {
		log.Printf("reset %s: backup %s", user.Name, result.Path)
	}
	s.resets.mu.Lock()
	job.running, job.backup, job.err = false, result.Path, err
	s.resets.mu.Unlock()
}
