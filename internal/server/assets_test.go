package server

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"tuxee/web"
)

func TestSelfContainedIndexAndCSP(t *testing.T) {
	s := New(nil, nil, nil, "", web.Assets())
	request := httptest.NewRequest("GET", "https://tuxee.test/", nil)
	plain := httptest.NewRecorder()
	s.ServeHTTP(plain, request)
	if plain.Code != 200 {
		t.Fatal(plain.Code)
	}
	html := plain.Body.String()
	if strings.Contains(html, `<script src=`) || strings.Contains(html, `rel="stylesheet"`) {
		t.Fatal("index still depends on separate script/style requests")
	}
	start := strings.Index(html, `<script type="module">`)
	if start < 0 {
		t.Fatal("missing inline script")
	}
	script := strings.SplitN(html[start+len(`<script type="module">`):], "</script>", 2)[0]
	hash := sha256.Sum256([]byte(script))
	if !strings.Contains(plain.Header().Get("Content-Security-Policy"), "'sha256-"+base64.StdEncoding.EncodeToString(hash[:])+"'") {
		t.Fatal("CSP does not match the built script")
	}
	request.Header.Set("Accept-Encoding", "gzip")
	compressed := httptest.NewRecorder()
	s.ServeHTTP(compressed, request)
	if compressed.Header().Get("Content-Encoding") != "gzip" {
		t.Fatal("gzip negotiation failed")
	}
	reader, err := gzip.NewReader(compressed.Body)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, plain.Body.Bytes()) {
		t.Fatal("compressed asset differs from source")
	}
}
