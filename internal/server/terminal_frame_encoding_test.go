package server

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
	"testing"
	"time"
)

// WebKit — Safari on macOS and iOS — drops the terminal socket when a
// compressed message arrives fragmented, and coder/websocket fragments a text
// message when it is streamed through connection.Writer instead of written in
// one call: the snapshot then arrives as three frames (payload, a 4-byte
// continuation and an empty final continuation). The socket dies on the next
// frame, which for a terminal is the first keystroke.
//
// Chromium and Firefox accept both shapings, and a conforming WebSocket client
// hides the difference, so this test reads the frames from the wire itself.
func TestTerminalMessagesArriveAsSingleFrames(t *testing.T) {
	_, _, address := terminalFixture(t, "exec sleep 60")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	reader := dialRawTerminal(t, ctx, address)
	messages, compressed := 0, 0
	for messages < 6 {
		opcode, fin, rsv1, payload, err := readRawFrame(reader)
		if err != nil {
			t.Fatalf("reading terminal frame: %v", err)
		}
		switch opcode {
		case 0x8:
			return
		case 0x0:
			t.Fatalf("terminal message was fragmented (%d byte continuation): WebKit closes the socket on a "+
				"fragmented compressed message, which makes Safari reconnect after every keystroke. "+
				"Write the message in one connection.Write call instead of streaming it through connection.Writer", len(payload))
		}
		if !fin {
			t.Fatalf("opcode %d frame is not final: terminal messages must not be fragmented", opcode)
		}
		messages++
		if rsv1 {
			compressed++
		}
	}
	if compressed == 0 {
		t.Fatal("no compressed frame observed, the test no longer covers the regression")
	}
}

// dialRawTerminal upgrades a plain TCP connection by hand so the frames the
// server writes can be inspected without a WebSocket client normalising them.
func dialRawTerminal(t *testing.T, ctx context.Context, address string) *bufio.Reader {
	t.Helper()
	parsed, err := url.Parse(address)
	if err != nil {
		t.Fatal(err)
	}
	host := parsed.Host
	if !strings.Contains(host, ":") {
		host += ":80"
	}
	dialer := &net.Dialer{}
	conn, err := dialer.DialContext(ctx, "tcp", host)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))

	upgrade := "GET " + parsed.RequestURI() + " HTTP/1.1\r\n" +
		"Host: " + parsed.Host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
		"Sec-WebSocket-Extensions: permessage-deflate; client_no_context_takeover; server_no_context_takeover\r\n" +
		"Origin: http://localhost\r\n\r\n"
	if _, err := io.WriteString(conn, upgrade); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	status, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(status, " 101 ") {
		t.Fatalf("terminal upgrade failed: %s", strings.TrimSpace(status))
	}
	negotiated := false
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(line) == "" {
			break
		}
		if strings.HasPrefix(strings.ToLower(line), "sec-websocket-extensions:") && strings.Contains(strings.ToLower(line), "permessage-deflate") {
			negotiated = true
		}
	}
	if !negotiated {
		t.Fatal("permessage-deflate was not negotiated, cannot check frame shaping")
	}
	return reader
}

// readRawFrame decodes one unmasked server frame.
func readRawFrame(r *bufio.Reader) (opcode byte, fin bool, rsv1 bool, payload []byte, err error) {
	header := make([]byte, 2)
	if _, err = io.ReadFull(r, header); err != nil {
		return 0, false, false, nil, err
	}
	fin = header[0]&0x80 != 0
	rsv1 = header[0]&0x40 != 0
	opcode = header[0] & 0x0f
	if header[1]&0x80 != 0 {
		return 0, false, false, nil, errors.New("server frame is masked")
	}
	length := uint64(header[1] & 0x7f)
	switch length {
	case 126:
		extended := make([]byte, 2)
		if _, err = io.ReadFull(r, extended); err != nil {
			return 0, false, false, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(extended))
	case 127:
		extended := make([]byte, 8)
		if _, err = io.ReadFull(r, extended); err != nil {
			return 0, false, false, nil, err
		}
		length = binary.BigEndian.Uint64(extended)
	}
	if length > 64<<20 {
		return 0, false, false, nil, fmt.Errorf("implausible frame length %d", length)
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(r, payload); err != nil {
		return 0, false, false, nil, err
	}
	return opcode, fin, rsv1, payload, nil
}
