package keeper

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
	"tuxee/internal/files"
	"tuxee/internal/identity"

	"golang.org/x/sys/unix"
)

//go:embed keeper.bin
var native []byte

var executable = sync.OnceValues(func() (*os.File, error) {
	f, err := sealed(native)
	if err == nil {
		err = f.Chmod(0555)
	}
	if err != nil && f != nil {
		f.Close()
	}
	return f, err
})

type accessRequest struct {
	Operation, ID, Instance, Path string
	Create                        bool
}

// Worker performs user-path resolution without changing the shared server identity.
func Worker() error {
	unix.Umask(0077)
	var r accessRequest
	if err := json.NewDecoder(io.LimitReader(os.Stdin, 8192)).Decode(&r); err != nil {
		return err
	}
	var f *os.File
	var err error
	switch r.Operation {
	case "directory", "connect":
		if r.ID == "audio" {
			f, err = files.AudioDirectory(r.Instance, r.Create)
		} else {
			f, err = files.TerminalDirectory(r.ID, r.Instance, r.Create)
		}
		if err == nil && r.Operation == "connect" {
			err = f.Chdir()
			f.Close()
			f = nil
			if err == nil {
				var fd int
				fd, err = unix.Socket(unix.AF_UNIX, unix.SOCK_SEQPACKET|unix.SOCK_CLOEXEC, 0)
				if err == nil {
					f = os.NewFile(uintptr(fd), "keeper-control")
					err = unix.Connect(fd, &unix.SockaddrUnix{Name: "keeper.sock"})
					if err == nil {
						var peer *unix.Ucred
						peer, err = unix.GetsockoptUcred(fd, unix.SOL_SOCKET, unix.SO_PEERCRED)
						if err == nil && peer.Uid != uint32(os.Geteuid()) {
							err = os.ErrPermission
						}
					}
				}
			}
		}
	case "path":
		if !filepath.IsAbs(r.Path) {
			return os.ErrInvalid
		}
		f, err = os.OpenFile(r.Path, os.O_RDONLY|unix.O_DIRECTORY, 0)
	default:
		return os.ErrInvalid
	}
	if f != nil {
		defer f.Close()
	}
	if err != nil {
		return err
	}
	_, err = unix.SendmsgN(3, []byte{0}, unix.UnixRights(int(f.Fd())), nil, 0)
	return err
}

func access(user identity.User, request accessRequest) (*os.File, error) {
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_SEQPACKET|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	parent, child := os.NewFile(uintptr(pair[0]), "keeper-access"), os.NewFile(uintptr(pair[1]), "keeper-access-child")
	defer parent.Close()
	defer child.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := user.Command(ctx, identity.Self, "__keeper")
	if user.UID == uint32(os.Geteuid()) {
		if state := os.Getenv("XDG_STATE_HOME"); filepath.IsAbs(state) {
			cmd.Env = append(cmd.Env, "XDG_STATE_HOME="+state)
		}
	}
	data, _ := json.Marshal(request)
	cmd.Stdin = bytes.NewReader(data)
	cmd.ExtraFiles = []*os.File{child}
	var diagnostic bytes.Buffer
	cmd.Stderr = &diagnostic
	if err = cmd.Run(); err != nil {
		return nil, fmt.Errorf("keeper access: %s: %w", diagnostic.String(), err)
	}
	data = make([]byte, 1)
	control := make([]byte, unix.CmsgSpace(4))
	_, n, flags, _, err := unix.Recvmsg(pair[0], data, control, unix.MSG_CMSG_CLOEXEC|unix.MSG_DONTWAIT)
	if err != nil {
		return nil, err
	}
	messages, err := unix.ParseSocketControlMessage(control[:n])
	if err != nil {
		return nil, err
	}
	var descriptors []int
	for _, msg := range messages {
		fds, e := unix.ParseUnixRights(&msg)
		if e != nil {
			err = e
		}
		descriptors = append(descriptors, fds...)
	}
	if err != nil || len(descriptors) != 1 || flags&unix.MSG_CTRUNC != 0 {
		for _, fd := range descriptors {
			unix.Close(fd)
		}
		return nil, errors.New("invalid keeper access response")
	}
	return os.NewFile(uintptr(descriptors[0]), "keeper-access-result"), nil
}

func OpenDirectory(user identity.User, path string) (*os.File, error) {
	return access(user, accessRequest{Operation: "path", Path: path})
}

func Connect(user identity.User, id, instance string) (*Client, error) {
	f, err := access(user, accessRequest{Operation: "connect", ID: id, Instance: instance})
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return attach(f)
}

func Start(user identity.User, id, instance string) (*Client, error) {
	dir, err := access(user, accessRequest{Operation: "directory", ID: id, Instance: instance, Create: true})
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	return startDirectory(user, dir, func() (*Client, error) { return Connect(user, id, instance) })
}

func startDirectory(user identity.User, dir *os.File, connect func() (*Client, error)) (*Client, error) {
	binary, err := executable()
	if err != nil {
		return nil, err
	}
	cmd := user.Command(context.Background(), "/proc/self/fd/4")
	cmd.Args[0] = "tuxee-keeper"
	cmd.SysProcAttr.Pdeathsig = 0
	cmd.SysProcAttr.Setsid = true
	cmd.ExtraFiles = []*os.File{dir, binary}
	ready, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		ready.Close()
		return nil, err
	}
	go cmd.Wait()
	diagnostics := make(chan []byte, 1)
	go func() { b, _ := io.ReadAll(io.LimitReader(ready, 4096)); diagnostics <- b; ready.Close() }()
	select {
	case b := <-diagnostics:
		if len(b) > 0 {
			return nil, fmt.Errorf("keeper startup: %s", b)
		}
	case <-time.After(5 * time.Second):
		cmd.Process.Kill()
		ready.Close()
		return nil, errors.New("keeper startup timed out")
	}
	c, err := connect()
	if err != nil {
		cmd.Process.Kill()
	}
	return c, err
}
