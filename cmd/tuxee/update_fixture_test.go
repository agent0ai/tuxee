package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
)

// The browser suite installs real test executables without changing production download origins.
func browserUpdateFixture() error {
	var fixture struct{ Binary string }
	data, err := os.ReadFile(filepath.Join(os.Getenv("HOME"), "update-browser-fixture.json"))
	if err != nil {
		return err
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		return err
	}
	binary, err := os.ReadFile(fixture.Binary)
	if err != nil {
		return err
	}
	http.DefaultTransport = releaseTransport(func(r *http.Request) (*http.Response, error) {
		var body []byte
		switch r.URL.String() {
		case "https://api.github.com/repos/agent0ai/tuxee/releases/latest":
			body = []byte(`{"tag_name":"v1.1.0"}`)
		case "https://github.com/agent0ai/tuxee/releases/download/v1.1.0/checksums.txt":
			body = fmt.Appendf(nil, "%x  tuxee-linux-%s\n", sha256.Sum256(binary), runtime.GOARCH)
		case "https://github.com/agent0ai/tuxee/releases/download/v1.1.0/tuxee-linux-" + runtime.GOARCH:
			body = binary
		default:
			return nil, fmt.Errorf("unexpected fixture request: %s", r.URL)
		}
		return &http.Response{StatusCode: 200, ContentLength: int64(len(body)), Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header)}, nil
	})
	return nil
}
