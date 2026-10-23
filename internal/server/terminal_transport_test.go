package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
	"tuxee/internal/identity"
	"tuxee/internal/terminal"
)

type countedTerminalConn struct {
	net.Conn
	bytes atomic.Int64
}

func (c *countedTerminalConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.bytes.Add(int64(n))
	return n, err
}

func terminalFixture(t *testing.T, command string) (*Server, *terminal.Session, string) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("real PTY requires root")
	}
	user, err := identity.Lookup("root")
	if err != nil {
		t.Fatal(err)
	}
	manager := terminal.NewManager()
	t.Cleanup(manager.Close)
	session, err := manager.Create(user, t.TempDir(), "transport", 80, 24, command)
	if err != nil {
		t.Fatal(err)
	}
	server := New(nil, manager, nil, "", fstest.MapFS{})
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		server.terminalRoute(w, r, &login{user: user})
	}))
	t.Cleanup(httpServer.Close)
	return server, session, httpServer.URL + "/api/terminals/" + session.Info().ID + "/ws"
}

func readTerminalFrame(ctx context.Context, c *websocket.Conn) (terminal.Event, uint64, error) {
	kind, data, err := c.Read(ctx)
	if err != nil {
		return terminal.Event{}, 0, err
	}
	if kind == websocket.MessageBinary {
		if len(data) < 9 {
			return terminal.Event{}, 0, errors.New("invalid binary terminal frame")
		}
		return terminal.Event{Type: "data", Data: data[8:]}, binary.BigEndian.Uint64(data), nil
	}
	var event struct {
		terminal.Event
		Sequence uint64 `json:"sequence"`
	}
	err = json.Unmarshal(data, &event)
	return event.Event, event.Sequence, err
}

func terminalAck(ctx context.Context, c *websocket.Conn, sequence uint64) error {
	data, _ := json.Marshal(map[string]any{"type": "rendered", "sequence": sequence})
	return c.Write(ctx, websocket.MessageText, data)
}

func TestTerminalThroughput(t *testing.T) {
	if os.Getenv("TUXEE_TERMINAL_BENCHMARK") == "" {
		t.Skip("opt-in transport benchmark")
	}
	for _, delay := range []time.Duration{0, 25 * time.Millisecond} {
		t.Run(delay.String(), func(t *testing.T) {
			_, _, address := terminalFixture(t, "read -r; head -c 262144 /dev/zero | tr '\\0' x; printf '\\nBENCH_DONE\\n'; exec sleep 60")
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			var wire *countedTerminalConn
			client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				c, err := (&net.Dialer{}).DialContext(ctx, network, address)
				wire = &countedTerminalConn{Conn: c}
				return wire, err
			}}}
			c, response, err := websocket.Dial(ctx, strings.Replace(address, "http:", "ws:", 1), &websocket.DialOptions{HTTPClient: client, HTTPHeader: http.Header{"Origin": {"http://localhost"}}, CompressionMode: websocket.CompressionNoContextTakeover})
			if err != nil {
				t.Fatal(err)
			}
			defer c.CloseNow()
			c.SetReadLimit(65 << 20)
			event, sequence, err := readTerminalFrame(ctx, c)
			if err != nil || event.Type != "snapshot" {
				t.Fatalf("snapshot: %s %v", event.Type, err)
			}
			t.Logf("initial snapshot: %d JSON bytes, %d wire bytes, compression %q", len(event.Snapshot), wire.bytes.Load(), response.Header.Get("Sec-WebSocket-Extensions"))
			if err := terminalAck(ctx, c, sequence); err != nil {
				t.Fatal(err)
			}
			started := time.Now()
			if err := c.Write(ctx, websocket.MessageBinary, []byte("\n")); err != nil {
				t.Fatal(err)
			}
			var output []byte
			type delayedAck struct {
				sequence uint64
				due      time.Time
			}
			acks := make(chan delayedAck, 512)
			var workers sync.WaitGroup
			workers.Go(func() {
				for ack := range acks {
					time.Sleep(time.Until(ack.due))
					_ = terminalAck(ctx, c, ack.sequence)
				}
			})
			defer func() { close(acks); cancel(); workers.Wait() }()
			for !bytes.Contains(output, []byte("BENCH_DONE")) {
				event, sequence, err = readTerminalFrame(ctx, c)
				if err != nil {
					t.Fatal(err)
				}
				output = append(output, event.Data...)
				if sequence != 0 {
					acks <- delayedAck{sequence, time.Now().Add(delay)}
				}
			}
			if bytes.Count(output, []byte("x")) != 262144 {
				t.Fatal("output bytes changed")
			}
			t.Logf("256 KiB, delayed acknowledgements %s: %s", delay, time.Since(started))
		})
	}
}

func dialTerminal(t *testing.T, ctx context.Context, address string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.Dial(ctx, strings.Replace(address, "http:", "ws:", 1), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"http://localhost"}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	c.SetReadLimit(65 << 20)
	return c
}

func TestTerminalProtocolRejectsInvalidInput(t *testing.T) {
	for _, tc := range []struct {
		name  string
		kind  websocket.MessageType
		data  string
		ready bool
	}{
		{"before-recovery", websocket.MessageBinary, "x", false},
		{"empty-input", websocket.MessageBinary, "", true},
		{"future-ack", websocket.MessageText, `{"type":"rendered","sequence":999}`, true},
		{"repeated-ack", websocket.MessageText, `{"type":"rendered","sequence":1}`, true},
		{"zero-ack", websocket.MessageText, `{"type":"rendered","sequence":0}`, true},
		{"invalid-size", websocket.MessageText, `{"type":"resize","columns":501,"rows":24}`, true},
		{"invalid-json", websocket.MessageText, `{`, true},
		{"unknown-control", websocket.MessageText, `{"type":"unknown"}`, true},
		{"oversized-control", websocket.MessageText, strings.Repeat(" ", 4097), true},
		{"oversized-input", websocket.MessageBinary, strings.Repeat("x", 65537), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, session, address := terminalFixture(t, "exec sleep 60")
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			c := dialTerminal(t, ctx, address)
			first, sequence, err := readTerminalFrame(ctx, c)
			if err != nil || first.Type != "snapshot" || sequence != 1 {
				t.Fatalf("initial snapshot: %s %d %v", first.Type, sequence, err)
			}
			if tc.ready {
				if err := terminalAck(ctx, c, sequence); err != nil {
					t.Fatal(err)
				}
			}
			if err := c.Write(ctx, tc.kind, []byte(tc.data)); err != nil {
				t.Fatal(err)
			}
			for {
				if _, _, err := readTerminalFrame(ctx, c); err != nil {
					break
				}
			}
			if ctx.Err() != nil {
				t.Fatal("invalid input did not disconnect the view")
			}
			if session.Info().Exited {
				t.Fatal("invalid view terminated the retained PTY")
			}
		})
	}
}

func TestTerminalOutputWindow(t *testing.T) {
	_, session, address := terminalFixture(t, "read -r; head -c 300000 /dev/zero; printf '\\nWINDOW_DONE\\n'; exec sleep 60")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	c := dialTerminal(t, ctx, address)
	first, sequence, err := readTerminalFrame(ctx, c)
	if err != nil || first.Type != "snapshot" {
		t.Fatal("snapshot", err)
	}
	if err := terminalAck(ctx, c, sequence); err != nil {
		t.Fatal(err)
	}
	if err := c.Write(ctx, websocket.MessageBinary, []byte("\n")); err != nil {
		t.Fatal(err)
	}
	type frame struct {
		event terminal.Event
		seq   uint64
		err   error
	}
	frames := make(chan frame)
	go func() {
		for {
			event, seq, err := readTerminalFrame(ctx, c)
			select {
			case frames <- frame{event, seq, err}:
			case <-ctx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	var output []byte
	count, size := 0, 0
	stalled := false
	for !stalled {
		select {
		case next := <-frames:
			if next.err != nil {
				t.Fatal(next.err)
			}
			if next.seq == 0 {
				continue
			}
			if next.seq != sequence+1 {
				t.Fatal("nonconsecutive output")
			}
			sequence = next.seq
			count++
			size += next.event.Bytes()
			output = append(output, next.event.Data...)
		case <-time.After(time.Second):
			stalled = true
		}
	}
	if count < 2 || count > 64 || size > 256<<10 || size < 128<<10 {
		t.Fatalf("unbounded or stop-and-wait output: %d frames, %d bytes", count, size)
	}
	if session.Info().Attached != 1 {
		t.Fatal("bounded output detached a healthy view")
	}
	if err := terminalAck(ctx, c, sequence); err != nil {
		t.Fatal(err)
	}
	for !bytes.Contains(output, []byte("WINDOW_DONE")) {
		next := <-frames
		if next.err != nil {
			t.Fatal(next.err)
		}
		output = append(output, next.event.Data...)
		if next.seq != 0 {
			if err := terminalAck(ctx, c, next.seq); err != nil {
				t.Fatal(err)
			}
		}
	}
	if bytes.Count(output, []byte{0}) != 300000 {
		t.Fatal("window lost or duplicated output")
	}
}

func TestTerminalBlockedInputStillDrainsOutput(t *testing.T) {
	_, _, address := terminalFixture(t, "read -r; stty -echo -icanon; printf READY; read -r; head -c 300000 /dev/zero; dd bs=65536 count=1 iflag=fullblock of=/dev/null 2>/dev/null; printf INPUT_DONE; exec sleep 60")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	c := dialTerminal(t, ctx, address)
	var output []byte
	readyAck := false
	for !readyAck || !bytes.Contains(output, []byte("READY")) {
		event, seq, err := readTerminalFrame(ctx, c)
		if err != nil {
			t.Fatal(err)
		}
		output = append(output, event.Data...)

		if seq != 0 {
			if err := terminalAck(ctx, c, seq); err != nil {
				t.Fatal(err)
			}
		}
		if event.Type == "snapshot" {
			if err := c.Write(ctx, websocket.MessageBinary, []byte("\n")); err != nil {
				t.Fatal(err)
			}
		}
		if event.Type == "ack" {
			readyAck = true
		}
	}
	output = nil
	if err := c.Write(ctx, websocket.MessageBinary, []byte("\n")); err != nil {
		t.Fatal(err)
	}
	inputSent, inputAck := false, false
	for !inputAck || !bytes.Contains(output, []byte("INPUT_DONE")) {
		event, seq, err := readTerminalFrame(ctx, c)
		if err != nil {
			t.Fatal(err)
		}
		output = append(output, event.Data...)
		if seq != 0 {
			if err := terminalAck(ctx, c, seq); err != nil {
				t.Fatal(err)
			}
		}
		if event.Type == "ack" {
			if inputSent {
				inputAck = true
			} else {
				inputSent = true
				if err := c.Write(ctx, websocket.MessageBinary, bytes.Repeat([]byte("y"), 65536)); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	if bytes.Count(output, []byte{0}) != 300000 {
		t.Fatal("output stalled behind a blocked PTY input write")
	}
}

func TestTerminalInputPipeline(t *testing.T) {
	for _, mode := range []string{"ordered", "frames", "bytes"} {
		t.Run(mode, func(t *testing.T) {
			command := "exec sleep 60"
			if mode == "ordered" {
				command = "dd bs=64 count=1 iflag=fullblock 2>/dev/null; exec sleep 60"
			}
			_, session, address := terminalFixture(t, "read -r; stty -echo -icanon; printf READY; "+command)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			c := dialTerminal(t, ctx, address)
			var output []byte
			readyAck := false
			for !readyAck || !bytes.Contains(output, []byte("READY")) {
				event, seq, err := readTerminalFrame(ctx, c)
				if err != nil {
					t.Fatal(err)
				}
				output = append(output, event.Data...)
				if seq != 0 {
					if err := terminalAck(ctx, c, seq); err != nil {
						t.Fatal(err)
					}
				}
				if event.Type == "snapshot" {
					if err := c.Write(ctx, websocket.MessageBinary, []byte("\n")); err != nil {
						t.Fatal(err)
					}
				}
				readyAck = readyAck || event.Type == "ack"
			}
			payload := "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!?"
			var frames [][]byte
			switch mode {
			case "ordered":
				for _, value := range []byte(payload) {
					frames = append(frames, []byte{value})
				}
			case "frames":
				// The first write fills the unread raw PTY, keeping all 64 slots occupied.
				frames = append(frames, bytes.Repeat([]byte("x"), 32768))
				for range 64 {
					frames = append(frames, []byte("x"))
				}
			case "bytes":
				frames = [][]byte{bytes.Repeat([]byte("x"), 65536), []byte("x")}
			}
			for _, frame := range frames {
				if err := c.Write(ctx, websocket.MessageBinary, frame); err != nil {
					t.Fatal(err)
				}
			}
			output = nil
			acks, rejected := 0, false
			for {
				event, seq, err := readTerminalFrame(ctx, c)
				if err != nil {
					if mode == "ordered" || !rejected || ctx.Err() != nil {
						t.Fatalf("pipeline closed unexpectedly: %v (acks=%d, rejected=%v)", err, acks, rejected)
					}
					break
				}
				if event.Type == "error" {
					if event.Message != "terminal input window is unavailable" {
						t.Fatal(event.Message)
					}
					rejected = true
				}
				if event.Type == "ack" {
					acks++
				}
				output = append(output, event.Data...)
				if seq != 0 {
					if err := terminalAck(ctx, c, seq); err != nil {
						t.Fatal(err)
					}
				}
				if mode == "ordered" && acks == len(frames) && len(output) >= len(payload) {
					if string(output) != payload {
						t.Fatalf("input reordered or duplicated: %q", output)
					}
					break
				}
			}
			if session.Info().Exited {
				t.Fatal("input transport terminated the retained PTY")
			}
		})
	}
}

func TestTerminalSnapshotCompression(t *testing.T) {
	_, _, address := terminalFixture(t, "exec sleep 60")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var wire *countedTerminalConn
	transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		c, err := (&net.Dialer{}).DialContext(ctx, network, address)
		wire = &countedTerminalConn{Conn: c}
		return wire, err
	}}
	defer transport.CloseIdleConnections()
	c, response, err := websocket.Dial(ctx, strings.Replace(address, "http:", "ws:", 1), &websocket.DialOptions{HTTPClient: &http.Client{Transport: transport}, HTTPHeader: http.Header{"Origin": {"http://localhost"}}, CompressionMode: websocket.CompressionNoContextTakeover})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	c.SetReadLimit(65 << 20)
	event, seq, err := readTerminalFrame(ctx, c)
	if err != nil || event.Type != "snapshot" || seq != 1 || !json.Valid(event.Snapshot) {
		t.Fatal("compressed recovery failed", err)
	}
	if !strings.Contains(response.Header.Get("Sec-WebSocket-Extensions"), "permessage-deflate") {
		t.Fatal("recovery compression was not negotiated")
	}
	if wire.bytes.Load() >= int64(len(event.Snapshot)/3) {
		t.Fatalf("empty recovery did not compress: %d wire, %d JSON", wire.bytes.Load(), len(event.Snapshot))
	}
}
