package tests

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"tuxee/internal/identity"
	"tuxee/internal/server"
	"tuxee/internal/terminal"
)

type slowZeros struct{}

func (slowZeros) Read(data []byte) (int, error) {
	if len(data) > 32<<10 {
		data = data[:32<<10]
	}
	clear(data)
	time.Sleep(time.Millisecond)
	return len(data), nil
}
func rssWithWorkers(pid int) int {
	ids := map[string]bool{strconv.Itoa(pid): true}
	tasks, _ := os.ReadDir(fmt.Sprintf("/proc/%d/task", pid))
	for _, task := range tasks {
		data, _ := os.ReadFile(fmt.Sprintf("/proc/%d/task/%s/children", pid, task.Name()))
		for _, child := range strings.Fields(string(data)) {
			ids[child] = true
		}
	}
	total := 0
	for id := range ids {
		data, _ := os.ReadFile("/proc/" + id + "/status")
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "VmRSS:") {
				fields := strings.Fields(line)
				value, _ := strconv.Atoi(fields[1])
				total += value
			}
		}
	}
	return total
}

func testPassword(t *testing.T, name string) string {
	t.Helper()
	data, err := exec.Command("getent", "passwd", name).Output()
	if err != nil {
		if err = exec.Command("useradd", "-m", "-s", "/bin/bash", "-c", "Tuxee prototype test", name).Run(); err != nil {
			t.Fatal(err)
		}
		data, err = exec.Command("getent", "passwd", name).Output()
	}
	fields := strings.Split(strings.TrimSpace(string(data)), ":")
	if err != nil || len(fields) != 7 || fields[4] != "Tuxee prototype test" {
		t.Fatal("refusing unrelated test account")
	}
	password := make([]byte, 24)
	if _, err = rand.Read(password); err != nil {
		t.Fatal(err)
	}
	value := base64.RawURLEncoding.EncodeToString(password)
	clear(password)
	cmd := exec.Command("chpasswd")
	cmd.Stdin = strings.NewReader(name + ":" + value + "\n")
	if err = cmd.Run(); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestRealHTTPAndRetention(t *testing.T) {
	if os.Geteuid() != 0 || os.Getenv("TUXEE_SYSTEM_TEST") != "1" {
		t.Skip("requires root and TUXEE_SYSTEM_TEST=1")
	}
	password := testPassword(t, "tuxee-poc-system")
	binary, err := filepath.Abs("../bin/tuxee")
	if err != nil {
		t.Fatal(err)
	}
	state := t.TempDir()
	attemptedACME := make(chan struct{}, 1)
	caServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case attemptedACME <- struct{}{}:
		default:
		}
		http.Error(w, "test CA unavailable", http.StatusServiceUnavailable)
	}))
	defer caServer.Close()
	caPath := filepath.Join(t.TempDir(), "test-ca.pem")
	if err = os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caServer.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	// A public identifier reaches only this local test CA, never a production CA.
	cmd := exec.Command(binary, "serve", "--bind", "127.0.0.1:0", "--hosts", "127.0.0.1,1.1.1.1", "--state", state, "--acme-directory", caServer.URL)
	cmd.Env = append(os.Environ(), "LEGO_CA_CERTIFICATES="+caPath, "LEGO_CA_SYSTEM_CERT_POOL=false", "LEGO_CA_SERVER_NAME=")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- cmd.Wait() }()
	t.Cleanup(func() {
		cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-finished:
		case <-time.After(10 * time.Second):
			cmd.Process.Kill()
			<-finished
		}
	})
	lines := make(chan string, 16)
	go func() {
		defer close(lines)
		s := bufio.NewScanner(stdout)
		for s.Scan() {
			lines <- s.Text()
		}
	}()
	var address string
	deadline := time.After(10 * time.Second)
	for address == "" {
		select {
		case line, ok := <-lines:
			if !ok {
				t.Fatal("server stopped during startup")
			}
			if strings.Contains(line, "listening at ") {
				for _, word := range strings.Fields(line) {
					if strings.HasPrefix(word, "https://") {
						address = word
					}
				}
			}
		case <-deadline:
			t.Fatal("server startup timed out")
		}
	}
	select {
	case <-attemptedACME:
	case <-time.After(10 * time.Second):
		t.Fatal("default ACME did not attempt issuance on a nonstandard port without an HTTP request")
	}
	ca, err := os.ReadFile(filepath.Join(state, "tls", "local-ca.pem"))
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		t.Fatal("invalid local CA")
	}
	clear(ca)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots}}, Timeout: 10 * time.Second}
	redirectClient := *client
	redirectClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	plainURL := strings.Replace(address, "https://", "http://", 1) + "/?from=http%20test"
	redirect, err := redirectClient.Get(plainURL)
	if err != nil {
		t.Fatal(err)
	}
	redirect.Body.Close()
	if redirect.StatusCode != http.StatusPermanentRedirect || redirect.Header.Get("Location") != address+"/?from=http%20test" {
		t.Fatalf("HTTP on HTTPS port: %d %v", redirect.StatusCode, redirect.Header)
	}
	followed, err := client.Get(plainURL)
	if err != nil {
		t.Fatal(err)
	}
	followed.Body.Close()
	if followed.StatusCode != http.StatusOK || followed.TLS == nil {
		t.Fatal("HTTP redirect did not reach the HTTPS application")
	}
	var csrf string
	request := func(path, method string, value any, expected int, target any) {
		t.Helper()
		var body io.Reader
		if value != nil {
			data, _ := json.Marshal(value)
			body = bytes.NewReader(data)
		}
		r, _ := http.NewRequest(method, address+"/api"+path, body)
		r.Header.Set("X-Tuxee-Client", "web")
		r.Header.Set("X-Tuxee-CSRF", csrf)
		r.Header.Set("Content-Type", "application/json")
		response, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != expected {
			t.Fatalf("%s %s returned %d", method, path, response.StatusCode)
		}
		if target != nil {
			if err = json.NewDecoder(response.Body).Decode(target); err != nil {
				t.Fatal(err)
			}
		}
	}
	var login struct {
		CSRF string `json:"csrf"`
	}
	request("/login", "POST", map[string]string{"username": "tuxee-poc-system", "password": password}, 200, &login)
	csrf = login.CSRF
	account, err := identity.Lookup("tuxee-poc-system")
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := os.MkdirTemp(account.Home, "tuxee-copy-check-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(fixture)
	if err = os.Chown(fixture, int(account.UID), int(account.GID)); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{fixture + "/source", fixture + "/source/readonly", fixture + "/destination"} {
		request("/files", "POST", map[string]string{"operation": "mkdir", "path": path}, 200, nil)
	}
	if err = os.WriteFile(fixture+"/source/readonly/child", []byte("keep"), 0644); err != nil {
		t.Fatal(err)
	}
	request("/files", "POST", map[string]string{"operation": "chmod", "path": fixture + "/source/readonly", "mode": "0500"}, 200, nil)
	request("/files", "POST", map[string]string{"operation": "copy", "path": fixture + "/source", "destination": fixture + "/destination"}, 400, nil)
	entries, err := os.ReadDir(fixture)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".tuxee-copy-") {
			t.Fatal("failed copy leaked read-only staged directory")
		}
	}
	const transferBytes = 64 << 20
	baseline := rssWithWorkers(cmd.Process.Pid)
	memoryCtx, stopMemory := context.WithCancel(context.Background())
	defer stopMemory()
	peakCh := make(chan int, 1)
	go func() {
		peak := baseline
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-memoryCtx.Done():
				peakCh <- peak
				return
			case <-ticker.C:
				if rss := rssWithWorkers(cmd.Process.Pid); rss > peak {
					peak = rss
				}
			}
		}
	}()
	uploadRequest, _ := http.NewRequest("POST", address+"/api/upload?path="+url.QueryEscape(fixture+"/large.bin"), io.LimitReader(slowZeros{}, transferBytes))
	uploadRequest.Header.Set("X-Tuxee-CSRF", csrf)
	uploadRequest.Header.Set("X-Tuxee-Size", strconv.Itoa(transferBytes))
	response, err := client.Do(uploadRequest)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("stream upload: %d", response.StatusCode)
	}
	response, err = client.Get(address + "/api/download?path=" + url.QueryEscape(fixture+"/large.bin"))
	if err != nil {
		t.Fatal(err)
	}
	n, err := io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if err != nil || n != transferBytes {
		t.Fatalf("stream download: bytes=%d error=%v", n, err)
	}
	var bundle struct{ Token, Name string }
	request("/download-archive", "POST", map[string]any{"path": fixture, "paths": []string{fixture + "/source", fixture + "/large.bin"}}, 200, &bundle)
	response, err = client.Get(address + "/api/download?archive=" + bundle.Token)
	if err != nil {
		t.Fatal(err)
	}
	zipped, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.Header.Get("Content-Type") != "application/zip" || response.ContentLength != -1 {
		t.Fatal("ZIP did not use a successful streaming response", err)
	}
	zipReader, err := zip.NewReader(bytes.NewReader(zipped), int64(len(zipped)))
	if err != nil {
		t.Fatal(err)
	}
	foundLarge, foundChild := false, false
	for _, file := range zipReader.File {
		switch file.Name {
		case "large.bin":
			reader, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			n, err := io.Copy(io.Discard, reader)
			reader.Close()
			if err != nil || n != transferBytes {
				t.Fatal("invalid large ZIP entry", n, err)
			}
			foundLarge = true
		case "source/readonly/child":
			foundChild = true
		}
	}
	if !foundLarge || !foundChild {
		t.Fatal("ZIP lost selected files or read-only folder contents")
	}
	var zipStatus struct {
		Size  int64
		Done  bool
		Error string
	}
	request("/download-archive?token="+bundle.Token, "GET", nil, 200, &zipStatus)
	if !zipStatus.Done || zipStatus.Error != "" || zipStatus.Size != int64(len(zipped)) {
		t.Fatal("wrong ZIP progress", zipStatus)
	}
	request("/download-archive?token="+bundle.Token, "DELETE", nil, 200, nil)
	if err := os.WriteFile(fixture+"/root-secret", []byte("must not be downloaded"), 0600); err != nil {
		t.Fatal(err)
	}
	request("/download-archive", "POST", map[string]any{"path": fixture, "paths": []string{fixture + "/root-secret"}}, 200, &bundle)
	response, err = client.Get(address + "/api/download?archive=" + bundle.Token)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if err == nil {
		t.Fatal("unreadable ZIP source was reported as a successful download")
	}
	zipStatus = struct {
		Size  int64
		Done  bool
		Error string
	}{}
	request("/download-archive?token="+bundle.Token, "GET", nil, 200, &zipStatus)
	if !zipStatus.Done || !strings.Contains(zipStatus.Error, "permission denied") {
		t.Fatal("ZIP worker did not preserve Linux permissions/error reporting", zipStatus)
	}
	request("/download-archive?token="+bundle.Token, "DELETE", nil, 200, nil)
	stopMemory()
	peak := <-peakCh
	if peak-baseline > 48*1024 {
		t.Fatalf("64 MiB transfer retained too much memory: growth %d KiB", peak-baseline)
	}
	t.Logf("64 MiB upload/download: parent + worker peak growth %d KiB", peak-baseline)
	var info terminal.Info
	request("/terminals", "POST", map[string]any{"name": "Browser handoff test", "columns": 80, "rows": 24}, 201, &info)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, strings.Replace(address, "https:", "wss:", 1)+"/api/terminals/"+info.ID+"/ws", &websocket.DialOptions{HTTPClient: client, HTTPHeader: http.Header{"Origin": []string{address}}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	ws.SetReadLimit(32 << 20)
	read := func(connection *websocket.Conn) terminal.Event {
		t.Helper()
		_, data, err := connection.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var event struct {
			terminal.Event
			Sequence uint64 `json:"sequence"`
		}
		if err = json.Unmarshal(data, &event); err != nil {
			t.Fatal(err)
		}
		if event.Sequence != 0 {
			ack, _ := json.Marshal(map[string]any{"type": "rendered", "sequence": event.Sequence})
			if err = connection.Write(ctx, websocket.MessageText, ack); err != nil {
				t.Fatal(err)
			}
		}
		return event.Event
	}
	if event := read(ws); event.Type != "snapshot" || !event.Control {
		t.Fatalf("wrong initial browser attachment: %s", event.Type)
	}
	second, _, err := websocket.Dial(ctx, strings.Replace(address, "https:", "wss:", 1)+"/api/terminals/"+info.ID+"/ws", &websocket.DialOptions{HTTPClient: client, HTTPHeader: http.Header{"Origin": []string{address}}})
	if err != nil {
		t.Fatal(err)
	}
	defer second.CloseNow()
	second.SetReadLimit(32 << 20)
	if event := read(second); event.Type != "snapshot" || event.Control {
		t.Fatal("second browser attachment stole control")
	}
	if err = second.Write(ctx, websocket.MessageText, []byte(`{"type":"take-control"}`)); err != nil {
		t.Fatal(err)
	}
	for event := read(second); event.Type != "control" || !event.Control; event = read(second) {
	}
	for event := read(ws); event.Type != "control" || event.Control; event = read(ws) {
	}
	if err = second.Write(ctx, websocket.MessageBinary, []byte("printf 'WEB_%s\\n' 'HANDOFF_OK'\n")); err != nil {
		t.Fatal(err)
	}
	var output []byte
	for !bytes.Contains(output, []byte("WEB_HANDOFF_OK")) {
		event := read(second)
		output = append(output, event.Data...)
		if len(output) > 1<<20 {
			t.Fatal("terminal output overflow")
		}
	}
	if err = ws.Write(ctx, websocket.MessageText, []byte(`{"type":"take-control"}`)); err != nil {
		t.Fatal(err)
	}
	for {
		event := read(ws)
		if event.Type == "control" && event.Control {
			break
		}
	}
	request("/logout", "POST", map[string]string{}, 200, nil)
	for {
		if _, _, err = ws.Read(ctx); err != nil {
			break
		}
	}
	request("/terminals", "GET", nil, 401, nil)
	for {
		if _, _, err = second.Read(ctx); err != nil {
			break
		}
	}
	request("/login", "POST", map[string]string{"username": "tuxee-poc-system", "password": password}, 200, &login)
	csrf = login.CSRF
	var retained terminal.Info
	request("/terminals/"+info.ID, "GET", nil, 200, &retained)
	if retained.ID != info.ID || retained.PID != info.PID || retained.Exited {
		t.Fatal("logout lost retained terminal")
	}
	reconnected, _, err := websocket.Dial(ctx, strings.Replace(address, "https:", "wss:", 1)+"/api/terminals/"+info.ID+"/ws", &websocket.DialOptions{HTTPClient: client, HTTPHeader: http.Header{"Origin": []string{address}}})
	if err != nil {
		t.Fatal(err)
	}
	defer reconnected.CloseNow()
	reconnected.SetReadLimit(32 << 20)
	if event := read(reconnected); event.Type != "snapshot" || !event.Control || !json.Valid(event.Snapshot) {
		t.Fatal("reconnection did not restore retained terminal")
	}
	reconnected.CloseNow()
	request("/terminals/"+info.ID, "DELETE", nil, 200, nil)
	settings := map[string]any{"theme": "dark", "idleHours": 1.0 / 3600, "workspaces": []server.Workspace{}}
	request("/settings", "PUT", settings, 200, nil)
	request("/terminals", "POST", map[string]any{"name": "Legacy timeout must not kill services", "columns": 80, "rows": 24, "command": "while :; do printf '.'; sleep 0.1; done"}, 201, &info)
	time.Sleep(1500 * time.Millisecond)
	request("/terminals/"+info.ID, "GET", nil, 200, &retained)
	if retained.Exited || retained.PID != info.PID {
		t.Fatal("legacy timeout stopped the detached service")
	}
	var saved map[string]any
	request("/settings", "PUT", settings, 200, &saved)
	if _, exists := saved["idleHours"]; exists {
		t.Fatal("obsolete timeout remains in saved settings")
	}
	request("/terminals/"+info.ID, "DELETE", nil, 200, nil)
}
