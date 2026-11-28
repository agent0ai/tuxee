package files

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/unix"

	"tuxee/internal/i18n"
	"tuxee/internal/identity"
	"tuxee/internal/update"
)

type Notification struct {
	ID      string    `json:"id"`
	Type    string    `json:"type"`
	Text    string    `json:"text,omitempty"`
	Release string    `json:"release,omitempty"`
	Created time.Time `json:"created"`
}

type NotificationFeed struct {
	Items []Notification `json:"items"`
	Count int            `json:"count"`
}

func validNotificationID(id string) bool {
	if len(id) != 32 || strings.ToLower(id) != id {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

func (n Notification) Valid() bool {
	switch n.Type {
	case "default", "info", "success", "warning", "error":
	default:
		return false
	}
	return len(n.Text) <= 8192 && utf8.ValidString(n.Text) &&
		((strings.TrimSpace(n.Text) != "" && n.Release == "") || (n.Text == "" && n.Release != "" && len(n.Release) <= 80))
}

// WatchNotifications returns a pollable descriptor. The recipient's worker
// installs the watch so Linux applies its normal directory access checks.
func WatchNotifications(ctx context.Context, user identity.User) (*os.File, error) {
	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC | unix.IN_NONBLOCK)
	if err != nil {
		return nil, err
	}
	watch := os.NewFile(uintptr(fd), "notifications-inotify")
	worker, err := start(ctx, user, Request{Operation: "notification-watch"}, nil, []*os.File{watch})
	if err == nil {
		err = worker.Wait()
	}
	if err != nil {
		watch.Close()
		return nil, err
	}
	return watch, nil
}

func notificationOperation(ctx context.Context, request Request) (Response, error) {
	var response Response
	path, err := stateDirectory("notifications")
	if err != nil {
		return response, err
	}
	posting := request.Operation == "notification-post" || request.Operation == "notification-broadcast"
	watching := request.Operation == "notification-watch"
	if posting && (request.Notice == nil || !request.Notice.Valid()) {
		return response, i18n.New("backend.server.invalidRequestBody")
	}
	if request.Operation == "notification-broadcast" {
		home, err := os.UserHomeDir()
		if err != nil {
			return response, err
		}
		config, err := os.Stat(filepath.Join(home, ".config", "tuxee"))
		if errors.Is(err, os.ErrNotExist) {
			return response, nil
		}
		if err != nil {
			return response, err
		}
		if !config.IsDir() {
			return response, nil
		}
	}
	if posting || watching {
		if err := os.MkdirAll(path, 0700); err != nil {
			return response, err
		}
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if errors.Is(err, os.ErrNotExist) && !posting && !watching {
		return response, nil
	}
	if err != nil {
		return response, err
	}
	dir := os.NewFile(uintptr(fd), path)
	defer dir.Close()
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return response, err
	}
	if stat.Uid != uint32(os.Geteuid()) || stat.Mode&0077 != 0 {
		return response, os.ErrPermission
	}
	if watching {
		// ExtraFiles[0] is fd 3 in the child.
		_, err := unix.InotifyAddWatch(3, fdPath(dir, ""), unix.IN_MOVED_TO|unix.IN_MOVED_FROM|unix.IN_DELETE|unix.IN_MOVE_SELF|unix.IN_DELETE_SELF)
		return response, err
	}
	// Serialize publication and dismissal across instances sharing this account.
	if request.Operation != "notification-list" {
		if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
			return response, err
		}
	}
	switch request.Operation {
	case "notification-post", "notification-broadcast":
		n := *request.Notice
		n.Created = time.Now().UTC()
		if n.Release != "" {
			sum := sha256.Sum256([]byte(n.Release))
			n.ID = hex.EncodeToString(sum[:16])
			for _, name := range []string{".dismissed-" + n.ID, n.ID + ".json"} {
				if _, err := os.Lstat(fdPath(dir, name)); err == nil {
					return response, nil
				} else if !errors.Is(err, os.ErrNotExist) {
					return response, err
				}
			}
		} else {
			var id [16]byte
			rand.Read(id[:])
			n.ID = hex.EncodeToString(id[:])
		}
		data, err := json.Marshal(n)
		if err != nil {
			return response, err
		}
		return response, replaceFile(fdPath(dir, n.ID+".json"), data)
	case "notification-dismiss":
		id := request.Path
		if !validNotificationID(id) {
			return response, i18n.New("backend.server.invalidRequestBody")
		}
		return response, dismissNotification(dir, fd, id, request.Version)
	case "notification-dismiss-all":
		// Snapshot names before deleting entries from the directory being enumerated.
		names, err := dir.Readdirnames(-1)
		if err != nil {
			return response, err
		}
		for _, name := range names {
			if err := ctx.Err(); err != nil {
				return response, err
			}
			id, ok := strings.CutSuffix(name, ".json")
			if ok && validNotificationID(id) {
				if err := dismissNotification(dir, fd, id, request.Version); err != nil {
					return response, err
				}
			}
		}
		return response, nil
	case "notification-list":
		return listNotifications(ctx, dir, fd, request.Version)
	}
	return response, i18n.New("backend.server.invalidRequestBody")
}

func dismissNotification(dir *os.File, fd int, id, version string) error {
	n, ok := readNotification(fd, id)
	if !ok || n.supersededBy(version) {
		return nil
	}
	if n.Release != "" {
		marker, err := os.OpenFile(fdPath(dir, ".dismissed-"+id), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err == nil {
			if err := marker.Close(); err != nil {
				return err
			}
		} else if !errors.Is(err, os.ErrExist) {
			return err
		}
	}
	err := os.Remove(fdPath(dir, id+".json"))
	if errors.Is(err, os.ErrNotExist) {
		err = nil
	}
	return err
}

func (n Notification) supersededBy(version string) bool {
	return update.ValidTag(n.Release) && update.ValidTag("v"+strings.TrimPrefix(version, "v")) && !update.Newer(n.Release, version)
}

func listNotifications(ctx context.Context, dir *os.File, fd int, version string) (Response, error) {
	var feed NotificationFeed
	for {
		if err := ctx.Err(); err != nil {
			return Response{}, err
		}
		entries, err := dir.ReadDir(64)
		for _, entry := range entries {
			id, ok := strings.CutSuffix(entry.Name(), ".json")
			if !ok || !validNotificationID(id) || !entry.Type().IsRegular() {
				continue
			}
			if n, ok := readNotification(fd, id); ok && !n.supersededBy(version) {
				feed.Items = append(feed.Items, n)
				feed.Count++
			}
		}
		slices.SortFunc(feed.Items, func(a, b Notification) int {
			if date := b.Created.Compare(a.Created); date != 0 {
				return date
			}
			return strings.Compare(a.ID, b.ID)
		})
		// Bound the inbox payload; dismissing a card reveals the next oldest.
		if len(feed.Items) > 64 {
			feed.Items = feed.Items[:64]
		}
		if errors.Is(err, io.EOF) {
			return Response{Inbox: &feed}, nil
		}
		if err != nil {
			return Response{}, err
		}
	}
}

func readNotification(dir int, id string) (Notification, bool) {
	var n Notification
	fd, err := unix.Openat(dir, id+".json", unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return n, false
	}
	f := os.NewFile(uintptr(fd), id)
	defer f.Close()
	info, err := f.Stat()
	const limit = 64 << 10
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return n, false
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || len(data) > limit || json.Unmarshal(data, &n) != nil {
		return n, false
	}
	return n, n.ID == id && !n.Created.IsZero() && n.Valid()
}
