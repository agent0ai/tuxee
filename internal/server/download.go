package server

import (
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"sync/atomic"
	"time"

	"tuxee/internal/files"
)

type archiveDownload struct {
	request files.Request
	session *login
	ctx     context.Context
	cancel  context.CancelFunc
	name    string
	size    atomic.Int64
	started bool
	done    bool
	err     string
	timer   *time.Timer
	stop    func() bool
}

func (s *Server) removeArchive(token string) {
	s.mu.Lock()
	job := s.archives[token]
	if job != nil {
		delete(s.archives, token)
		job.timer.Stop()
		job.stop()
	}
	s.mu.Unlock()
	if job != nil {
		job.cancel()
	}
}

func (s *Server) archiveOperation(w http.ResponseWriter, r *http.Request, session *login) {
	if r.Method == http.MethodPost {
		var input struct {
			Path  string   `json:"path"`
			Paths []string `json:"paths"`
		}
		if err := decode(w, r, &input); err != nil {
			failure(w, 400, err)
			return
		}
		request := files.Request{Operation: "zip-download", Path: input.Path, Paths: input.Paths}
		if err := files.ValidateDownload(request); err != nil {
			failure(w, 400, err)
			return
		}
		name := filepath.Base(filepath.Clean(input.Path))
		if name == "/" {
			name = "sys-root"
		}
		if len(input.Paths) == 1 {
			name = filepath.Base(filepath.Clean(input.Paths[0]))
		}
		name += ".zip"
		token := randomToken()
		ctx, cancel := context.WithCancel(session.ctx)
		job := &archiveDownload{request: request, session: session, ctx: ctx, cancel: cancel, name: name}
		s.mu.Lock()
		if len(s.archives) >= 128 {
			s.mu.Unlock()
			cancel()
			failure(w, 429, errors.New("too many pending downloads"))
			return
		}
		s.archives[token] = job
		job.timer = time.AfterFunc(time.Minute, func() { s.removeArchive(token) })
		job.stop = context.AfterFunc(session.ctx, func() { s.removeArchive(token) })
		s.mu.Unlock()
		jsonResponse(w, 200, map[string]string{"token": token, "name": name})
		return
	}
	token := r.URL.Query().Get("token")
	s.mu.Lock()
	job := s.archives[token]
	if job == nil || job.session != session {
		s.mu.Unlock()
		failure(w, 404, errors.New("download expired"))
		return
	}
	status := struct {
		Size  int64  `json:"size"`
		Done  bool   `json:"done"`
		Error string `json:"error,omitempty"`
	}{job.size.Load(), job.done, job.err}
	s.mu.Unlock()
	if r.Method == http.MethodDelete {
		s.removeArchive(token)
	}
	jsonResponse(w, 200, status)
}

func (s *Server) downloadArchive(w http.ResponseWriter, r *http.Request, session *login, token string) {
	s.mu.Lock()
	job := s.archives[token]
	if job == nil || job.session != session || job.started {
		s.mu.Unlock()
		failure(w, 404, errors.New("download expired or already started"))
		return
	}
	job.started = true
	job.timer.Stop()
	s.mu.Unlock()
	var result error
	defer func() {
		s.mu.Lock()
		job.done = true
		if result != nil {
			job.err = result.Error()
		}
		if s.archives[token] == job {
			job.timer.Reset(time.Minute)
		}
		s.mu.Unlock()
		job.cancel()
	}()
	if !s.fileSlot(w) {
		result = errors.New("file operations are busy; try again shortly")
		return
	}
	defer func() { <-s.fileSlots }()
	ctx, cancel := context.WithTimeout(job.ctx, 30*time.Minute)
	stop := context.AfterFunc(r.Context(), cancel)
	defer stop()
	defer cancel()
	writeStopped := make(chan struct{})
	stopWrite := context.AfterFunc(ctx, func() {
		// A paused browser can otherwise leave the response blocked after Cancel.
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now())
		close(writeStopped)
	})
	defer func() {
		if !stopWrite() {
			<-writeStopped
		}
	}()
	process, err := files.Start(ctx, session.user, job.request, nil)
	if err != nil {
		result = err
		failure(w, 400, err)
		return
	}
	defer process.Cancel()
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": job.name}))
	w.Header().Set("X-Accel-Buffering", "no")
	_ = http.NewResponseController(w).Flush()
	_, result = io.Copy(&archiveWriter{ResponseWriter: w, size: &job.size}, process.Reader)
	if result == nil {
		result = process.Wait()
	}
	if ctx.Err() != nil {
		result = ctx.Err()
	}
	if result != nil {
		// A ZIP without its central directory must not appear to download successfully.
		panic(http.ErrAbortHandler)
	}
}

type archiveWriter struct {
	http.ResponseWriter
	size *atomic.Int64
}

func (w *archiveWriter) Write(p []byte) (int, error) {
	n, err := w.ResponseWriter.Write(p)
	w.size.Add(int64(n))
	return n, err
}
