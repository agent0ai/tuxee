package server

import (
	"context"
	"log"
	"net/http"
	"time"

	"tuxee/internal/i18n"
	"tuxee/internal/update"
)

func (s *Server) updateOperation(w http.ResponseWriter, r *http.Request, session *login) {
	if s.Updates == nil || s.updatePath == "" {
		failure(w, 503, i18n.New("backend.server.updateChecksUnavailable"))
		return
	}
	apply := r.URL.Path == "/api/update/apply"
	if apply {
		if s.Restart == nil {
			failure(w, 503, i18n.New("backend.server.runtimeRestartIsUnavailable"))
			return
		}
		if !s.updateApplying.CompareAndSwap(false, true) {
			failure(w, 409, i18n.New("updates.installing"))
			return
		}
		defer s.updateApplying.Store(false)
	} else {
		select {
		case s.updateReads <- struct{}{}:
			defer func() { <-s.updateReads }()
		default:
			failure(w, 429, i18n.New("updates.checking"))
			return
		}
	}
	installation, err := update.Run(r.Context(), session.user, update.Request{Target: s.updatePath, Apply: apply})
	if err != nil {
		failure(w, 500, err)
		return
	}
	if installation.Latest != "" {
		s.Updates.Record(update.Release{Tag: installation.Latest})
	}
	if apply && installation.Error != "" {
		code := 500
		if !installation.CanApply || !installation.CanRestart {
			code = 403
		}
		failure(w, code, i18n.From(installation.Text, installation.Error))
		return
	}
	if apply {
		s.restartRuntime(w)
		return
	}
	canApply := installation.CanApply && installation.CanRestart && s.Restart != nil
	var schedule *update.Schedule
	if current := s.Updates.Schedule(); canApply && current.Timezone != "" {
		schedule = &current
	}
	if r.Method == "PUT" {
		if schedule == nil {
			failure(w, 403, i18n.New("updates.contactAdministrator"))
			return
		}
		if err := decode(w, r, schedule, 1024); err != nil {
			failure(w, 400, err)
			return
		}
		if err := s.Updates.SaveSchedule(*schedule); err != nil {
			failure(w, 500, err)
			return
		}
	}
	status := s.Updates.Status()
	if r.Method == "POST" {
		status = s.Updates.Check(r.Context())
	}
	if installation.Installed != "" {
		status.Available = update.Newer(status.Latest, installation.Installed)
	}
	jsonResponse(w, 200, struct {
		update.Status
		Schedule      *update.Schedule `json:"schedule,omitempty"`
		CanApply      bool             `json:"canApply"`
		RestartNeeded bool             `json:"restartNeeded"`
		Installing    bool             `json:"installing"`
		Command       string           `json:"command"`
	}{status, schedule, canApply, update.Newer("v"+installation.Installed, status.Current), s.updateApplying.Load(), update.Command(s.updatePath) + " update"})
}

func (s *Server) restartRuntime(w http.ResponseWriter) {
	if !s.closed.CompareAndSwap(false, true) {
		failure(w, 503, i18n.New("backend.server.serverRestarting"))
		return
	}
	jsonResponse(w, http.StatusAccepted, map[string]bool{"ok": true})
	s.Restart()
}

// ApplyScheduledUpdate shares the browser install guard and the CLI's installation lock.
func (s *Server) ApplyScheduledUpdate(ctx context.Context, release update.Release) {
	if s.Restart == nil || s.updatePath == "" || s.closed.Load() || !s.updateApplying.CompareAndSwap(false, true) {
		return
	}
	defer s.updateApplying.Store(false)
	installCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	changed, err := update.NewClient().ApplyAutomatic(installCtx, release, s.updatePath)
	if err != nil {
		log.Printf("automatic Tuxee update: %v", err)
		return
	}
	if changed && ctx.Err() == nil && s.closed.CompareAndSwap(false, true) {
		s.Restart()
	}
}
