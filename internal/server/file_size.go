package server

import (
	"bufio"
	"context"
	"net/http"
	"time"
	"tuxee/internal/i18n"

	"tuxee/internal/files"
)

func (s *Server) fileSize(w http.ResponseWriter, r *http.Request, session *login) {
	var input struct {
		Paths []string `json:"paths"`
	}
	if err := decode(w, r, &input); err != nil {
		failure(w, 400, err)
		return
	}
	select {
	case s.sizeSlots <- struct{}{}:
		defer func() { <-s.sizeSlots }()
	default:
		failure(w, 429, i18n.New("backend.server.sizeCalculationsAreBusyReopenPropertiesShortly"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	process, err := files.Start(ctx, session.user, files.Request{Operation: "size", Paths: input.Paths}, nil)
	if err != nil {
		failure(w, 400, err)
		return
	}
	defer process.Cancel()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	defer controller.SetWriteDeadline(time.Time{})
	scanner := bufio.NewScanner(process.Reader)
	for scanner.Scan() {
		_ = controller.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if _, err := w.Write(append(scanner.Bytes(), '\n')); err != nil {
			return
		}
		if err := controller.Flush(); err != nil {
			return
		}
	}
	if scanner.Err() != nil || process.Wait() != nil {
		panic(http.ErrAbortHandler)
	}
}
