package server

import (
	"bufio"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// HTTPSRedirect serves only redirects; credentials never reach the HTTP application.
func HTTPSRedirect(port, origin string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		target, err := httpsRedirectURL(r, port, origin)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Location", target)
		w.WriteHeader(http.StatusPermanentRedirect)
	})
}

func httpsRedirectURL(request *http.Request, port, origin string) (string, error) {
	target, err := url.Parse("https://" + request.Host)
	if err != nil || target.Hostname() == "" || target.User != nil || target.Path != "" || target.RawQuery != "" || target.Fragment != "" {
		return "", errors.New("invalid request host")
	}
	if port != "" {
		target.Host = net.JoinHostPort(target.Hostname(), port)
		if port == "443" {
			target.Host = strings.TrimSuffix(target.Host, ":443")
		}
	}
	if origin != "" {
		target, err = url.Parse(origin)
		if err != nil || target.Scheme != "https" || target.Host == "" {
			return "", errors.New("invalid HTTPS origin")
		}
	}
	target.Path, target.RawPath = request.URL.Path, request.URL.RawPath
	target.RawQuery, target.ForceQuery = request.URL.RawQuery, request.URL.ForceQuery
	return target.String(), nil
}

// ServeHTTPS redirects plaintext requests before passing bytes to Go's TLS server.
func ServeHTTPS(s *http.Server, listener net.Listener) error {
	limit := s.MaxHeaderBytes
	if limit <= 0 {
		limit = http.DefaultMaxHeaderBytes
	}
	return s.ServeTLS(redirectListener{Listener: listener, limit: int64(limit)}, "", "")
}

type redirectListener struct {
	net.Listener
	limit int64
}

func (l redirectListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &redirectConnection{Conn: conn, limit: l.limit}, nil
}

type redirectConnection struct {
	net.Conn
	reader *bufio.Reader
	limit  int64
}

func (c *redirectConnection) Read(p []byte) (int, error) {
	if c.reader == nil {
		c.reader = bufio.NewReader(c.Conn)
		first, err := c.reader.Peek(1)
		if err != nil {
			return 0, err
		}
		if first[0] != 0x16 { // TLS handshake record.
			c.redirect()
			return 0, io.EOF
		}
	}
	return c.reader.Read(p)
}

func (c *redirectConnection) redirect() {
	response := http.Response{
		StatusCode: http.StatusBadRequest, ProtoMajor: 1, ProtoMinor: 1, Close: true,
		Header: http.Header{"Cache-Control": {"no-store"}}, ContentLength: 0,
	}
	request, err := http.ReadRequest(bufio.NewReader(io.LimitReader(c.reader, c.limit)))
	if err == nil {
		target, err := httpsRedirectURL(request, "", "")
		if err == nil {
			response.StatusCode = http.StatusPermanentRedirect
			response.Header.Set("Location", target)
		}
	}
	response.Write(c.Conn)
}
