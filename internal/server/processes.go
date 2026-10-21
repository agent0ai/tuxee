package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"tuxee/internal/processes"
)

type processSnapshot struct {
	id        string
	allowCore bool
	data      *processes.Snapshot
	view      processes.View
	expiry    *time.Timer
	stop      func() bool
}
type processAction struct {
	Snapshot  string   `json:"snapshot"`
	Selected  []string `json:"selected"`
	Signal    int      `json:"signal"`
	AllowCore bool     `json:"allowCore"`
}

func (s *Server) processOperation(w http.ResponseWriter, r *http.Request, session *login) {
	if r.Method == "DELETE" {
		session.clearProcesses(r.URL.Query().Get("snapshot"))
		jsonResponse(w, 200, map[string]bool{"ok": true})
		return
	}

	if r.Method == "GET" {
		core := r.URL.Query().Get("allowCore")
		if core != "" && core != "false" && core != "true" {
			failure(w, 400, errors.New("invalid core process option"))
			return
		}
		allowCore := core == "true"
		sortBy := r.URL.Query().Get("sort")
		if sortBy == "" {
			sortBy = "ram"
		}
		if sortBy != "ram" && sortBy != "cpu" {
			failure(w, 400, errors.New("invalid process sort"))
			return
		}
		select {
		case s.processReads <- struct{}{}:
			defer func() { <-s.processReads }()
		default:
			failure(w, 429, errors.New("process sampling is busy"))
			return
		}
		output, err := processes.Run(r.Context(), session.user, processes.Request{Operation: "list", AllowCore: allowCore})
		if err != nil {
			failure(w, 400, err)
			return
		}
		if output.Snapshot == nil {
			failure(w, 500, errors.New("process snapshot unavailable"))
			return
		}
		current := &processSnapshot{id: randomToken(), allowCore: allowCore, data: output.Snapshot, view: output.Snapshot.View(sortBy)}
		if r.Context().Err() != nil {
			return
		}
		session.processMu.Lock()
		if old := session.processSnapshot; old != nil {
			if old.expiry != nil {
				old.expiry.Stop()
			}
			if old.stop != nil {
				old.stop()
			}
		}
		session.processSnapshot = current
		id := current.id
		current.expiry = time.AfterFunc(30*time.Minute, func() { session.clearProcesses(id) })
		current.stop = context.AfterFunc(session.ctx, func() { session.clearProcesses(id) })
		session.processMu.Unlock()
		jsonResponse(w, 200, struct {
			processes.View
			Snapshot  string `json:"snapshot"`
			AllowCore bool   `json:"allowCore"`
		}{current.view, current.id, current.allowCore})
		return
	}
	var input processAction
	if err := decode(w, r, &input); err != nil {
		failure(w, 400, err)
		return
	}
	if input.Signal != 15 && input.Signal != 9 {
		failure(w, 400, errors.New("invalid process signal"))
		return
	}
	session.processMu.Lock()
	current := session.processSnapshot
	session.processMu.Unlock()
	if current == nil || current.id != input.Snapshot || time.Since(current.data.Time) > 30*time.Minute {
		failure(w, 409, errors.New("process snapshot expired; refresh"))
		return
	}
	if input.AllowCore != current.allowCore {
		failure(w, 409, errors.New("core process option changed; refresh"))
		return
	}
	refs, err := current.targets(input.Selected)
	if err != nil {
		failure(w, 400, err)
		return
	}
	select {
	case s.processKills <- struct{}{}:
		defer func() { <-s.processKills }()
	default:
		failure(w, 429, errors.New("process signalling is busy"))
		return
	}
	output, err := processes.Run(r.Context(), session.user, processes.Request{Operation: "signal", Targets: refs, Signal: input.Signal, AllowCore: input.AllowCore})
	if err != nil {
		failure(w, 400, err)
		return
	}
	jsonResponse(w, 200, map[string]any{"results": output.Results})
}
func (s *processSnapshot) targets(ids []string) ([]processes.Ref, error) {
	if len(ids) == 0 || len(ids) > processes.Limit {
		return nil, errors.New("invalid process selection")
	}
	allowed := make(map[string]processes.Row, len(s.view.Rows))
	for _, row := range s.view.Rows {
		allowed[row.ID] = row
	}
	roots := []int{}
	seen := map[int]bool{}
	for _, id := range ids {
		row, ok := allowed[id]
		if !ok || row.Zombies > 0 || !row.CanSignal {
			return nil, errors.New("invalid or protected process selection")
		}
		for _, pid := range row.Members {
			if !seen[pid] {
				roots = append(roots, pid)
				seen[pid] = true
			}
		}
	}
	// Summary rows can stand for more than the 1,000 displayed records.
	return s.data.Targets(roots)
}

func (s *login) clearProcesses(id string) {
	s.processMu.Lock()
	defer s.processMu.Unlock()
	if current := s.processSnapshot; current != nil && current.id == id {
		s.processSnapshot = nil
		if current.expiry != nil {
			current.expiry.Stop()
		}
		if current.stop != nil {
			current.stop()
		}
	}
}
