package server

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"tuxee/internal/terminal"
)

func terminalDisplay(w http.ResponseWriter, r *http.Request, value *terminal.Session, action string) {
	gui := value.Display
	state := gui.State()
	if state == nil || !state.Ready {
		failure(w, 409, errors.New("display is not running"))
		return
	}
	switch {
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
			failure(w, 403, errors.New("WebSocket origin is required"))
			return
		}
	case action == "display/audio" && r.Method == "GET":
		terminalAudio(w, r, value)
		return
	default:
		failure(w, 404, errors.New("terminal endpoint not found"))
		return
	}
	upstream, err := (&net.Dialer{Timeout: 3 * time.Second}).DialContext(r.Context(), "unix", gui.Address)
	if err != nil {
		failure(w, 503, errors.New("GUI session is unavailable"))
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

func terminalAudio(w http.ResponseWriter, r *http.Request, value *terminal.Session) {
	if r.Header.Get("Origin") == "" {
		failure(w, 403, errors.New("WebSocket origin is required"))
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	output, closeAudio, err := value.Display.Audio(ctx)
	if err != nil {
		failure(w, 503, errors.New("display audio is unavailable"))
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
	packet := make([]byte, 3840) // 20 ms; close stalled writers instead of allocating a growing queue.
	for {
		if _, err := io.ReadFull(output, packet); err != nil {
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
