package server

import (
	"context"
	"net/http"
	"time"
	"tuxee/internal/audio"
	"tuxee/internal/i18n"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func (s *Server) userMicrophone(w http.ResponseWriter, r *http.Request, session *login) {
	if r.Header.Get("Origin") == "" {
		failure(w, 403, i18n.New("backend.server.websocketOriginIsRequired"))
		return
	}
	connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer connection.CloseNow()
	connection.SetReadLimit(audio.MicrophonePacketBytes)
	report := func(err error) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		_ = wsjson.Write(ctx, connection, map[string]any{"text": i18n.Describe(err), "error": err.Error()})
	}
	mic, err := s.Terminals.Audio.Microphone(session.user)
	if err != nil {
		report(err)
		return
	}
	defer mic.Close()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		select {
		case <-mic.Done():
			cancel()
		case <-ctx.Done():
		}
	}()
	readyCtx, stop := context.WithTimeout(ctx, time.Second)
	err = wsjson.Write(readyCtx, connection, map[string]bool{"ready": true})
	stop()
	if err != nil {
		return
	}
	next := time.Now()
	for {
		readCtx, stop := context.WithTimeout(ctx, 2*time.Second)
		kind, packet, err := connection.Read(readCtx)
		stop()
		if err != nil {
			return
		}
		now := time.Now()
		if kind != websocket.MessageBinary || len(packet) != audio.MicrophonePacketBytes || next.After(now.Add(200*time.Millisecond)) {
			report(i18n.New("audio.invalidData"))
			return
		}
		if next.Before(now) {
			next = now
		}
		next = next.Add(20 * time.Millisecond)
		if err = mic.Write(packet); err != nil {
			report(i18n.New("audio.microphoneStopped"))
			return
		}
	}
}
