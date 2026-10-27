package server

import (
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"tuxee/internal/i18n"

	"tuxee/internal/files"
)

var previewTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon", ".pdf": "application/pdf",
	".mp4": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac",
}

func byteRange(header string, size int64) (int64, int64, error) {
	invalid := i18n.New("backend.server.invalidByteRange")
	if !strings.HasPrefix(header, "bytes=") || strings.Contains(header, ",") || size <= 0 {
		return 0, 0, invalid
	}
	parts := strings.Split(strings.TrimPrefix(header, "bytes="), "-")
	if len(parts) != 2 {
		return 0, 0, invalid
	}
	start, end := int64(0), size-1
	if parts[0] == "" {
		count, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || count <= 0 {
			return 0, 0, invalid
		}
		start = max(0, size-count)
	} else {
		n, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil || n < 0 || n >= size {
			return 0, 0, invalid
		}
		start = n
		if parts[1] != "" {
			n, err = strconv.ParseInt(parts[1], 10, 64)
			if err != nil || n < start {
				return 0, 0, invalid
			}
			end = min(end, n)
		}
	}
	return start, end - start + 1, nil
}
func (s *Server) preview(w http.ResponseWriter, r *http.Request, session *login) {
	path := r.URL.Query().Get("path")
	contentType := previewTypes[strings.ToLower(filepath.Ext(path))]
	if contentType == "" {
		failure(w, 400, i18n.New("backend.server.unsupportedPreviewType"))
		return
	}
	if !s.fileSlot(w) {
		return
	}
	defer func() { <-s.fileSlots }()
	metadata, err := files.Run(r.Context(), session.user, files.Request{Operation: "inspect", Path: path})
	if err != nil {
		failure(w, 400, err)
		return
	}
	size := metadata.Entry.Size
	offset, length := int64(0), size
	partial := r.Header.Get("Range") != ""
	if partial {
		offset, length, err = byteRange(r.Header.Get("Range"), size)
		if err != nil {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", size))
			failure(w, 416, err)
			return
		}
	}
	var process *files.Process
	if r.Method != "HEAD" && length > 0 {
		process, err = files.Start(r.Context(), session.user, files.Request{Operation: "download", Path: path, Offset: offset, Limit: length}, nil)
		if err != nil {
			failure(w, 400, err)
			return
		}
		defer process.Cancel()
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": filepath.Base(path)}))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'")
	if partial {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, offset+length-1, size))
		w.WriteHeader(206)
	}
	if process != nil {
		_, _ = io.Copy(w, process.Reader)
		_ = process.Wait()
	}
}
