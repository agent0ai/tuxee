package server

import (
	"context"
	"encoding/binary"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"golang.org/x/sys/unix"
	"tuxee/internal/files"
	"tuxee/internal/i18n"
	"tuxee/internal/identity"
)

type inboxWatch struct {
	ready     bool
	cancel    context.CancelFunc
	listeners map[chan struct{}]struct{}
}

func (s *Server) subscribeInbox(user identity.User) (<-chan struct{}, func()) {
	s.eventsMu.Lock()
	defer s.eventsMu.Unlock()
	listener := make(chan struct{}, 1)
	watch := s.inboxWatches[user.UID]
	if watch == nil {
		ctx, cancel := context.WithCancel(context.Background())
		watch = &inboxWatch{cancel: cancel, listeners: make(map[chan struct{}]struct{})}
		s.inboxWatches[user.UID] = watch
		go s.watchInbox(ctx, user, watch)
	}
	watch.listeners[listener] = struct{}{}
	if watch.ready {
		listener <- struct{}{}
	}
	return listener, func() {
		s.eventsMu.Lock()
		defer s.eventsMu.Unlock()
		delete(watch.listeners, listener)
		if len(watch.listeners) == 0 && s.inboxWatches[user.UID] == watch {
			delete(s.inboxWatches, user.UID)
			watch.cancel()
		}
	}
}

func (s *Server) watchInbox(ctx context.Context, user identity.User, watch *inboxWatch) {
	defer func() {
		s.eventsMu.Lock()
		defer s.eventsMu.Unlock()
		if s.inboxWatches[user.UID] == watch {
			delete(s.inboxWatches, user.UID)
		}
		for listener := range watch.listeners {
			close(listener)
		}
		watch.cancel()
	}()
	setup, cancel := context.WithTimeout(ctx, 5*time.Second)
	file, err := files.WatchNotifications(setup, user)
	cancel()
	if err != nil {
		return
	}
	defer file.Close()
	stop := context.AfterFunc(ctx, func() { file.Close() })
	defer stop()
	var buf [4096]byte
	for {
		// Read the initial snapshot only after the watch is installed.
		s.eventsMu.Lock()
		watch.ready = true
		for listener := range watch.listeners {
			select {
			case listener <- struct{}{}:
			default:
			}
		}
		s.eventsMu.Unlock()
		n, err := file.Read(buf[:])
		if err != nil {
			return
		}
		for at := 0; at+unix.SizeofInotifyEvent <= n; {
			mask := binary.NativeEndian.Uint32(buf[at+4:])
			if mask&(unix.IN_IGNORED|unix.IN_MOVE_SELF|unix.IN_DELETE_SELF|unix.IN_UNMOUNT) != 0 {
				return
			}
			at += unix.SizeofInotifyEvent + int(binary.NativeEndian.Uint32(buf[at+12:]))
		}
	}
}

func (s *Server) userEvents(w http.ResponseWriter, r *http.Request, session *login) {
	if r.Header.Get("Origin") == "" {
		failure(w, 403, i18n.New("backend.server.websocketOriginIsRequired"))
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	ctx := conn.CloseRead(r.Context())
	changed, unsubscribe := s.subscribeInbox(session.user)
	defer unsubscribe()
	keepalive := time.NewTicker(30 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-keepalive.C:
			deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
			err = conn.Ping(deadline)
			cancel()
		case _, ok := <-changed:
			if !ok {
				return
			}
			deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
			err = wsjson.Write(deadline, conn, struct {
				Type string `json:"type"`
			}{Type: "notifications.changed"})
			cancel()
		}
		if err != nil {
			return
		}
	}
}
