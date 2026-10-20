package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"tuxee/internal/terminal"
)

func (s *Server) terminalRoute(w http.ResponseWriter, r *http.Request, session *login) {
	path := strings.TrimPrefix(r.URL.Path, "/api/terminals/")
	id, action, _ := strings.Cut(path, "/")
	value, err := s.Terminals.Get(session.user, id)
	if err != nil {
		failure(w, 404, err)
		return
	}
	if action == "ws" && r.Method == "GET" {
		if r.Header.Get("Origin") == "" {
			failure(w, 403, errors.New("WebSocket origin is required"))
			return
		}
		connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer connection.CloseNow()
		connection.SetReadLimit(96 << 10)
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		attachment, err := value.Attach()
		if err != nil {
			connection.Close(websocket.StatusPolicyViolation, err.Error())
			return
		}
		defer attachment.Close()
		rendered := make(chan uint64, 8)
		go func() {
			defer cancel()
			ticker := time.NewTicker(20 * time.Second)
			defer ticker.Stop()
			var sequence uint64
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					pingCtx, stop := context.WithTimeout(ctx, 8*time.Second)
					err := connection.Ping(pingCtx)
					stop()
					if err != nil {
						return
					}
				case event, ok := <-attachment.Events:
					if !ok {
						return
					}
					sequence++
					data, err := json.Marshal(struct {
						terminal.Event
						Sequence uint64 `json:"sequence"`
					}{event, sequence})
					if err != nil {
						return
					}
					timeout := 10 * time.Second
					if event.Type == "snapshot" {
						timeout = 2 * time.Minute
					}
					writeCtx, stop := context.WithTimeout(ctx, timeout)
					err = connection.Write(writeCtx, websocket.MessageText, data)
					stop()
					attachment.Release(event)
					if err != nil {
						return
					}
					deadline := time.NewTimer(timeout)
					waiting := true
					for waiting {
						select {
						case <-ctx.Done():
							deadline.Stop()
							return
						case <-deadline.C:
							return
						case applied := <-rendered:
							waiting = applied != sequence
						}
					}
					deadline.Stop()
				}
			}
		}()
		for {
			kind, data, err := connection.Read(ctx)
			if err != nil {
				return
			}
			if kind == websocket.MessageBinary {
				err = attachment.Write(data)
			} else {
				var input struct {
					Type     string `json:"type"`
					Columns  int    `json:"columns"`
					Rows     int    `json:"rows"`
					Sequence uint64 `json:"sequence"`
				}
				if len(data) > 4096 || json.Unmarshal(data, &input) != nil {
					err = errors.New("invalid terminal control message")
				} else {
					switch input.Type {
					case "resize":
						err = attachment.Resize(input.Columns, input.Rows)
					case "take-control":
						err = attachment.TakeControl()
					case "ping":
					case "rendered":
						select {
						case rendered <- input.Sequence:
						default:
							err = errors.New("too many render acknowledgements")
						}
					default:
						err = errors.New("unknown terminal control message")
					}
				}
			}
			if err != nil {
				notice, _ := json.Marshal(terminal.Event{Type: "error", Message: err.Error()})
				writeCtx, stop := context.WithTimeout(ctx, time.Second)
				_ = connection.Write(writeCtx, websocket.MessageText, notice)
				stop()
			} else if kind == websocket.MessageBinary {
				_ = connection.Write(ctx, websocket.MessageText, []byte(`{"type":"ack"}`))
			}
		}
	}
	if action != "" {
		failure(w, 404, errors.New("terminal endpoint not found"))
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
		failure(w, 405, errors.New("method not allowed"))
	}
}
