package server

import (
	"context"
	"crypto/des"
	"crypto/sha256"
	"encoding/binary"
	"io"
	"math/bits"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"testing/fstest"
	"time"
	"tuxee/internal/terminal"

	"github.com/coder/websocket"
)

func TestDisplayAdmission(t *testing.T) {
	s := New("test-instance", nil, terminal.NewManager(), nil, "", fstest.MapFS{})
	defer s.Close()
	ctx, cancel := context.WithCancel(context.Background())
	s.logins[sha256.Sum256([]byte("token"))] = &login{csrf: "csrf", ctx: ctx, cancel: cancel, expires: time.Now().Add(time.Hour)}
	for _, tc := range []struct {
		method, path, token, origin, csrf string
		status                            int
	}{
		{"GET", "/api/audio", "", "http://tuxee.test", "", 401},
		{"GET", "/api/audio", "token", "", "", 403},
		{"GET", "/api/audio", "token", "http://evil.test", "", 403},
		{"POST", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display", "", "", "", 401},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/ws", "", "http://tuxee.test", "", 401},
		{"POST", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display", "token", "http://tuxee.test", "", 403},
		{"POST", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display", "token", "http://evil.test", "csrf", 403},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/ws", "token", "", "", 404},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/ws", "token", "http://evil.test", "", 403},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/ws", "token", "http://tuxee.test", "", 404},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display", "token", "http://tuxee.test", "", 404},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/audio", "", "http://tuxee.test", "", 401},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/audio", "token", "http://evil.test", "", 403},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/audio", "token", "http://tuxee.test", "", 404},
		{"DELETE", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/window", "", "http://tuxee.test", "csrf", 401},
		{"DELETE", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/window", "token", "http://tuxee.test", "", 403},
		{"DELETE", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/window", "token", "http://evil.test", "csrf", 403},
		{"DELETE", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/window", "token", "http://tuxee.test", "csrf", 404},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/clipboard/events", "", "http://tuxee.test", "", 401},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/clipboard/events", "token", "http://evil.test", "", 403},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/clipboard?version=1", "", "http://tuxee.test", "", 401},
		{"POST", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/clipboard", "token", "http://tuxee.test", "", 403},
		{"POST", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/clipboard", "token", "http://evil.test", "csrf", 403},
		{"POST", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/drop", "token", "http://tuxee.test", "", 403},
		{"POST", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/drop", "token", "http://evil.test", "csrf", 403},
	} {
		r := httptest.NewRequest(tc.method, "http://tuxee.test"+tc.path, nil)
		r.AddCookie(&http.Cookie{Name: s.cookieName, Value: tc.token})
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-Tuxee-CSRF", tc.csrf)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s %s origin=%q: %d, want %d", tc.method, tc.path, tc.origin, w.Code, tc.status)
		}
	}
}

func TestDisplayKeepalive(t *testing.T) {
	if os.Getenv("TUXEE_SYSTEM_TEST") != "1" {
		t.Skip("requires the real GUI runtime")
	}
	for _, tool := range []string{"tuxee-Xvnc", "xterm"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(err)
		}
	}
	_, session, address := terminalFixture(t, "xterm -title Keepalive")
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	for session.Display == nil || len(session.Display.State().Windows) == 0 {
		select {
		case <-ctx.Done():
			t.Fatal("display did not start")
		case <-time.After(20 * time.Millisecond):
		}
	}
	address = strings.Replace(strings.TrimSuffix(address, "/ws")+"/display/ws", "http:", "ws:", 1)
	for _, reply := range []bool{true, false} {
		name := "unresponsive"
		if reply {
			name = "responsive"
		}
		t.Run(name, func(t *testing.T) {
			ctx, stop := context.WithTimeout(context.Background(), 35*time.Second)
			defer stop()
			ping := make(chan struct{}, 2)
			c, _, err := websocket.Dial(ctx, address, &websocket.DialOptions{
				HTTPHeader:     http.Header{"Origin": {"http://localhost"}},
				OnPingReceived: func(context.Context, []byte) bool { ping <- struct{}{}; return reply },
			})
			if err != nil {
				t.Fatal(err)
			}
			defer c.CloseNow()
			stream := websocket.NetConn(ctx, c, websocket.MessageBinary)
			read := func(size int) []byte {
				data := make([]byte, size)
				if _, err := io.ReadFull(stream, data); err != nil {
					t.Fatal(err)
				}
				return data
			}
			write := func(data []byte) {
				if _, err := stream.Write(data); err != nil {
					t.Fatal(err)
				}
			}
			// Complete real VNC authentication, then leave the display idle without update requests.
			greeting := read(12)
			if string(greeting) != "RFB 003.008\n" {
				t.Fatalf("unexpected VNC greeting: %q", greeting)
			}
			write(greeting)
			types := read(int(read(1)[0]))
			if len(types) != 1 || types[0] != 2 {
				t.Fatalf("unexpected VNC security types: %v", types)
			}
			write([]byte{2})
			challenge, key := read(16), make([]byte, 8)
			copy(key, session.Display.Password)
			for i := range key {
				key[i] = bits.Reverse8(key[i])
			}
			cipher, _ := des.NewCipher(key)
			cipher.Encrypt(challenge[:8], challenge[:8])
			cipher.Encrypt(challenge[8:], challenge[8:])
			write(challenge)
			if binary.BigEndian.Uint32(read(4)) != 0 {
				t.Fatal("VNC authentication failed")
			}
			write([]byte{1})
			read(int(binary.BigEndian.Uint32(read(24)[20:])))
			ended := make(chan struct{})
			go func() { io.Copy(io.Discard, stream); close(ended) }()
			select {
			case <-ping:
			case <-ended:
				t.Fatal("display closed before its keepalive")
			case <-ctx.Done():
				t.Fatal("missing display keepalive")
			}
			if reply {
				select {
				case <-ended:
					t.Fatal("healthy idle viewer disconnected")
				case <-time.After(9 * time.Second):
				}
			} else {
				select {
				case <-ended:
				case <-ctx.Done():
					t.Fatal("unresponsive viewer was not disconnected")
				}
			}
			if !session.Display.State().Ready || len(session.Display.State().Windows) == 0 {
				t.Fatal("viewer loss stopped the application")
			}
		})
	}
}
