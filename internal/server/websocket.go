package server

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
	"tuxee/internal/i18n"

	"github.com/coder/websocket"
	"tuxee/internal/terminal"
)

type terminalAckRequest struct {
	sequence uint64
	done     chan error
}

func terminalOutput(ctx context.Context, connection *websocket.Conn, attachment *terminal.Attachment, rendered <-chan terminalAckRequest) error {
	type sentEvent struct {
		event    terminal.Event
		sequence uint64
		deadline time.Time
	}
	var sent []sentEvent
	var next *terminal.Event
	var sequence, acknowledged uint64
	bytes := 0
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if next != nil && (len(sent) == 0 || len(sent) < 64 && bytes+next.Bytes() <= 256<<10) {
			sequence++
			timeout := 10 * time.Second
			if next.Type == "snapshot" {
				timeout = 2 * time.Minute
			}
			writeCtx, stop := context.WithTimeout(ctx, timeout)
			var err error
			if next.Type == "data" {
				frame := make([]byte, 8+len(next.Data))
				binary.BigEndian.PutUint64(frame, sequence)
				copy(frame[8:], next.Data)
				err = connection.Write(writeCtx, websocket.MessageBinary, frame)
			} else {
				writer, openErr := connection.Writer(writeCtx, websocket.MessageText)
				err = openErr
				if err == nil {
					err = json.NewEncoder(writer).Encode(struct {
						terminal.Event
						Sequence uint64 `json:"sequence"`
					}{*next, sequence})
					if closeErr := writer.Close(); err == nil {
						err = closeErr
					}
				}
			}
			stop()
			if err != nil {
				return err
			}
			next.Snapshot = nil // Keep the allocation permit until acknowledgement, not the serialized copy.
			bytes += next.Bytes()
			sent = append(sent, sentEvent{*next, sequence, time.Now().Add(timeout)})
			next = nil
			continue
		}
		var events <-chan terminal.Event
		if next == nil && (sequence == 0 || acknowledged > 0) && len(sent) < 64 && bytes < 256<<10 {
			events = attachment.Events
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case event, ok := <-events:
			if !ok {
				return nil
			}
			next = &event
		case ack := <-rendered:
			if ack.sequence <= acknowledged || ack.sequence > sequence {
				ack.done <- i18n.New("backend.server.invalidTerminalRenderAcknowledgement")
				return i18n.New("backend.server.invalidTerminalRenderAcknowledgement")
			}
			acknowledged = ack.sequence
			for len(sent) > 0 && sent[0].sequence <= acknowledged {
				bytes -= sent[0].event.Bytes()
				attachment.Release(sent[0].event)
				sent[0] = sentEvent{}
				sent = sent[1:]
			}
			ack.done <- nil
		case now := <-ticker.C:
			if len(sent) > 0 && now.After(sent[0].deadline) {
				return i18n.New("backend.server.terminalRendererTimedOut")
			}
		}
	}
}

func (s *Server) terminalRoute(w http.ResponseWriter, r *http.Request, session *login) {
	path := strings.TrimPrefix(r.URL.Path, "/api/terminals/")
	id, action, _ := strings.Cut(path, "/")
	value, err := s.Terminals.Get(session.user, id)
	if err != nil {
		failure(w, 404, err)
		return
	}
	if action == "display" || strings.HasPrefix(action, "display/") {
		s.terminalDisplay(w, r, value, action)
		return
	}
	if action == "cwd" && r.Method == "GET" {
		directory, err := value.WorkingDirectory(r.Context())
		if err != nil {
			failure(w, 400, err)
			return
		}
		jsonResponse(w, 200, map[string]string{"path": directory})
		return
	}
	if action == "input-history" {
		var input struct {
			Text string `json:"text"`
		}
		switch r.Method {
		case "GET":
		case "POST":
			if err := decode(w, r, &input); err != nil {
				failure(w, 400, err)
				return
			}
		default:
			failure(w, 405, i18n.New("backend.server.methodNotAllowed"))
			return
		}
		history, err := value.InputHistory(r.Context(), input.Text)
		if err != nil {
			failure(w, 400, err)
			return
		}
		jsonResponse(w, 200, history)
		return
	}
	if action == "ws" && r.Method == "GET" {
		if r.Header.Get("Origin") == "" {
			failure(w, 403, i18n.New("backend.server.websocketOriginIsRequired"))
			return
		}
		connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true, CompressionMode: websocket.CompressionNoContextTakeover, CompressionThreshold: 1024,
		})
		if err != nil {
			return
		}
		defer connection.CloseNow()
		connection.SetReadLimit(65536)
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		recovery, finishRecovery := context.WithTimeout(ctx, 2*time.Minute)
		attachment, err := value.Attach(recovery)
		finishRecovery()
		if err != nil {
			connection.Close(websocket.StatusTryAgainLater, err.Error())
			return
		}
		defer attachment.Close()
		go func() {
			ticker := time.NewTicker(20 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					pingCtx, stop := context.WithTimeout(ctx, 8*time.Second)
					err := connection.Ping(pingCtx)
					stop()
					if err != nil {
						cancel()
						return
					}
				}
			}
		}()
		rendered := make(chan terminalAckRequest)
		go func() { defer cancel(); _ = terminalOutput(ctx, connection, attachment, rendered) }()
		inputQueue := make(chan []byte, 64)
		var inputFrames, inputBytes atomic.Int64
		ready := false
		notice := func(err error) {
			data, _ := json.Marshal(terminal.Event{Type: "error", Message: err.Error(), Text: i18n.Describe(err)})
			writeCtx, stop := context.WithTimeout(ctx, time.Second)
			defer stop()
			_ = connection.Write(writeCtx, websocket.MessageText, data)
		}
		// One writer preserves input order without blocking render acknowledgements or heartbeats.
		go func() {
			defer cancel()
			for {
				select {
				case <-ctx.Done():
					return
				case data := <-inputQueue:
					if ctx.Err() != nil {
						return
					}
					if err := attachment.Write(ctx, data); err != nil {
						notice(err)
						return
					}
					inputBytes.Add(-int64(len(data)))
					inputFrames.Add(-1)
					writeCtx, stop := context.WithTimeout(ctx, 10*time.Second)
					err := connection.Write(writeCtx, websocket.MessageText, []byte(`{"type":"ack"}`))
					stop()
					if err != nil {
						return
					}
				}
			}
		}()
		for {
			kind, data, err := connection.Read(ctx)
			if err != nil {
				return
			}
			if kind == websocket.MessageBinary {
				if !ready || len(data) == 0 || inputFrames.Add(1) > 64 || inputBytes.Add(int64(len(data))) > 65536 {
					notice(i18n.New("backend.server.terminalInputWindowIsUnavailable"))
					return
				}
				select {
				case inputQueue <- data:
				case <-ctx.Done():
					return
				}
				continue
			}
			var input struct {
				Type     string `json:"type"`
				Columns  int    `json:"columns"`
				Rows     int    `json:"rows"`
				Sequence uint64 `json:"sequence"`
			}
			if len(data) > 4096 || json.Unmarshal(data, &input) != nil {
				notice(i18n.New("backend.server.invalidTerminalControlMessage"))
				return
			}
			switch input.Type {
			case "rendered":
				ack := terminalAckRequest{sequence: input.Sequence, done: make(chan error, 1)}
				select {
				case rendered <- ack:
				case <-ctx.Done():
					return
				}
				select {
				case err = <-ack.done:
				case <-ctx.Done():
					return
				}
				if err == nil && input.Sequence == 1 {
					ready = true
				}
			case "resize":
				if !ready {
					err = i18n.New("backend.server.terminalIsRecovering")
				} else {
					err = attachment.Resize(input.Columns, input.Rows)
				}
				if err == nil {
					writeCtx, stop := context.WithTimeout(ctx, 10*time.Second)
					err = connection.Write(writeCtx, websocket.MessageText, []byte(`{"type":"resize-ack"}`))
					stop()
				}
			case "take-control":
				err = attachment.TakeControl()
			default:
				err = i18n.New("backend.server.unknownTerminalControlMessage")
			}
			if err != nil {
				notice(err)
				return
			}
		}
	}
	if action != "" {
		failure(w, 404, i18n.New("backend.server.terminalEndpointNotFound"))
		return
	}
	switch r.Method {
	case "GET":
		jsonResponse(w, 200, value.Info())
	case "DELETE":
		value.Close()
		jsonResponse(w, 200, map[string]bool{"ok": true})
	case "PATCH":
		var input struct {
			Name string `json:"name"`
		}
		if err = decode(w, r, &input); err == nil {
			err = value.Rename(input.Name)
		}
		if err != nil {
			failure(w, 400, err)
			return
		}
		jsonResponse(w, 200, value.Info())
	default:
		failure(w, 405, i18n.New("backend.server.methodNotAllowed"))
	}
}
