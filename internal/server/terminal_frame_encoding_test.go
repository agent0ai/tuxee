package server

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// Read raw frames because WebSocket clients normally hide fragmentation.
func TestTerminalSnapshotArrivesAsSingleFrame(t *testing.T) {
	_, _, address := terminalFixture(t, "exec sleep 60")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	reader := dialRawTerminal(t, ctx, address)
	var header [2]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		t.Fatalf("reading terminal snapshot frame: %v", err)
	}
	opcode, fin, compressed := header[0]&0x0f, header[0]&0x80 != 0, header[0]&0x40 != 0
	if opcode != 0x1 || !fin || !compressed || header[1]&0x80 != 0 {
		t.Fatalf("snapshot must be one unmasked compressed text frame: opcode=%d final=%v compressed=%v header=%x", opcode, fin, compressed, header)
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
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("terminal upgrade failed: %s", response.Status)
	}
	if !strings.Contains(response.Header.Get("Sec-WebSocket-Extensions"), "permessage-deflate") {
		t.Fatal("permessage-deflate was not negotiated, cannot check frame shaping")
	}
	return reader
}
