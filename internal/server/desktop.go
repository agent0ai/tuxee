package server

import (
	"context"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"
	"tuxee/internal/i18n"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"tuxee/internal/desktop"
	"tuxee/internal/terminal"
)

func (s *Server) terminalDisplay(w http.ResponseWriter, r *http.Request, value *terminal.Session, action string) {
	gui := value.Display
	state := gui.State()
	if state == nil || !state.Ready {
		failure(w, 409, i18n.New("backend.server.displayIsNotRunning"))
		return
	}
	if action == "display/clipboard" || action == "display/drop" {
		select {
		case s.clipSlots <- struct{}{}:
			defer func() { <-s.clipSlots }()
		default:
			failure(w, 429, i18n.New("backend.server.clipboardIsBusyTryAgain"))
			return
		}
		// Bound slow uploads and responses as well as X11 selection negotiation.
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(time.Now().Add(30 * time.Second))
		_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
		defer controller.SetReadDeadline(time.Time{})
		defer controller.SetWriteDeadline(time.Time{})
	}
	switch {
	case action == "display/clipboard/events" && r.Method == "GET":
		if r.Header.Get("Origin") == "" {
			failure(w, 403, i18n.New("backend.server.websocketOriginIsRequired"))
			return
		}
		changes, release, err := gui.ClipboardChanges()
		if err != nil {
			failure(w, 409, err)
			return
		}
		defer release()
		connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer connection.CloseNow()
		ctx := connection.CloseRead(r.Context())
		keepalive := time.NewTicker(30 * time.Second)
		defer keepalive.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case change, ok := <-changes:
				if !ok {
					return
				}
				writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
				err = wsjson.Write(writeCtx, connection, change)
				cancel()
				if err != nil {
					return
				}
			case <-keepalive.C:
				pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
				err = connection.Ping(pingCtx)
				cancel()
				if err != nil {
					return
				}
			}
		}
	case action == "display/clipboard" && r.Method == "GET":
		version, err := strconv.ParseUint(r.URL.Query().Get("version"), 10, 64)
		if err != nil {
			failure(w, 400, i18n.New("backend.server.clipboardVersionRequired"))
			return
		}
		data, err := gui.ReadClipboard(r.Context(), version)
		if err != nil {
			failure(w, 409, err)
			return
		}
		jsonResponse(w, 200, data)
		return
	case action == "display/clipboard" && r.Method == "POST":
		var data desktop.ClipboardData
		if err := decode(w, r, &data, desktop.MaxClipboardBytes*4/3+4096); err != nil {
			failure(w, 400, err)
			return
		}
		if err := gui.SetClipboard(data); err != nil {
			failure(w, 400, err)
			return
		}
		jsonResponse(w, 200, map[string]bool{"ok": true})
		return
	case action == "display/drop" && r.Method == "POST":
		var drop desktop.FileDrop
		if err := decode(w, r, &drop, 2<<20); err != nil {
			failure(w, 400, err)
			return
		}
		if err := gui.DropFiles(r.Context(), drop); err != nil {
			failure(w, 409, err)
			return
		}
		jsonResponse(w, 200, map[string]bool{"ok": true})
		return
	case action == "display" && r.Method == "GET":
		jsonResponse(w, 200, map[string]string{"password": gui.Password})
		return
	case action == "display/window" && (r.Method == "POST" || r.Method == "DELETE"):
		var input struct {
			ID uint32 `json:"id"`
		}
		if err := decode(w, r, &input, 4096); err != nil {
			failure(w, 400, err)
			return
		}
		handle := gui.Activate
		if r.Method == "DELETE" {
			handle = gui.CloseWindow
		}
		if err := handle(input.ID); err != nil {
			failure(w, 404, err)
			return
		}
		jsonResponse(w, 200, map[string]bool{"ok": true})
		return
	case action == "display/ws" && r.Method == "GET":
		if r.Header.Get("Origin") == "" {
			failure(w, 403, i18n.New("backend.server.websocketOriginIsRequired"))
			return
		}
	default:
		failure(w, 404, i18n.New("backend.server.terminalEndpointNotFound"))
		return
	}
	upstream, err := (&net.Dialer{Timeout: 3 * time.Second}).DialContext(r.Context(), "unix", gui.Address)
	if err != nil {
		failure(w, 503, i18n.New("backend.server.guiSessionIsUnavailable"))
		return
	}
	defer upstream.Close()
	connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer connection.CloseNow()
	stream := websocket.NetConn(r.Context(), connection, websocket.MessageBinary)
	connection.SetReadLimit(1 << 20)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = io.Copy(upstream, stream)
		upstream.Close()
	}()
	_, _ = io.Copy(stream, upstream)
	connection.CloseNow()
	upstream.Close()
	<-done
}

func (s *Server) userAudio(w http.ResponseWriter, r *http.Request, session *login) {
	if r.Header.Get("Origin") == "" {
		failure(w, 403, i18n.New("backend.server.websocketOriginIsRequired"))
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	packets, closeAudio, err := s.Terminals.Audio.Subscribe(session.user)
	if err != nil {
		failure(w, 503, err)
		return
	}
	defer closeAudio()
	connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer connection.CloseNow()
	ctx = connection.CloseRead(ctx)
	stop := context.AfterFunc(ctx, cancel)
	defer stop()
	keepalive := time.NewTicker(30 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-keepalive.C:
			pingCtx, stop := context.WithTimeout(ctx, 5*time.Second)
			err := connection.Ping(pingCtx)
			stop()
			if err != nil {
				return
			}
		case packet, ok := <-packets:
			if !ok {
				return
			}
			writeCtx, stop := context.WithTimeout(ctx, 250*time.Millisecond)
			err := connection.Write(writeCtx, websocket.MessageBinary, packet)
			stop()
			if err != nil {
				return
			}
		}
	}
}
