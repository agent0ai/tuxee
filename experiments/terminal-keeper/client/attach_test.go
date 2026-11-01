package client_test

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// Exercise the actual Go *os.File and creack/pty APIs used by Tuxee, with no I/O relay.
func TestTransferredPTY(t *testing.T) {
	binaryPath := os.Getenv("TUXEE_KEEPER_TEST_BINARY")
	if binaryPath == "" {
		t.Skip("set TUXEE_KEEPER_TEST_BINARY to the built experimental helper")
	}
	directory := t.TempDir()
	pinned, err := os.Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer pinned.Close()
	master, slave, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(binaryPath, "/bin/sh", "-c", "stty raw -echo; printf READY; exec cat")
	command.ExtraFiles = []*os.File{master, slave, pinned}
	startup, startupWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer startup.Close()
	command.Stderr = startupWriter
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	startupWriter.Close()
	master.Close()
	slave.Close()
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	waited := false
	t.Cleanup(func() {
		if !waited {
			_ = command.Process.Signal(unix.SIGTERM)
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				_ = command.Process.Kill()
				<-done
				t.Error("keeper did not shut down")
			}
		}
	})
	if err := startup.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if diagnostic, err := io.ReadAll(startup); err != nil || len(diagnostic) != 0 {
		t.Fatalf("keeper startup: %s, %v", diagnostic, err)
	}
	attach := func() (int, *os.File) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for {
			control, err := unix.Socket(unix.AF_UNIX, unix.SOCK_SEQPACKET|unix.SOCK_CLOEXEC, 0)
			if err != nil {
				t.Fatal(err)
			}
			if err := unix.Connect(control, &unix.SockaddrUnix{Name: fmt.Sprintf("/proc/self/fd/%d/keeper.sock", pinned.Fd())}); err != nil {
				unix.Close(control)
				t.Fatal(err)
			}
			if peer, err := unix.GetsockoptUcred(control, unix.SOL_SOCKET, unix.SO_PEERCRED); err != nil || peer.Pid != int32(command.Process.Pid) {
				t.Fatalf("unexpected socket owner: %+v, %v", peer, err)
			}
			if err := unix.SetsockoptTimeval(control, unix.SOL_SOCKET, unix.SO_RCVTIMEO, &unix.Timeval{Sec: 3}); err != nil {
				t.Fatal(err)
			}
			header, ancillary := make([]byte, 16), make([]byte, unix.CmsgSpace(4))
			n, controlN, flags, _, err := unix.Recvmsg(control, header, ancillary, unix.MSG_CMSG_CLOEXEC)
			if err == nil && n == 16 && binary.BigEndian.Uint32(header[8:12]) == 4 && controlN == 0 && time.Now().Before(deadline) {
				unix.Close(control)
				time.Sleep(time.Millisecond)
				continue
			}
			if err != nil || n != 16 || flags&unix.MSG_CTRUNC != 0 || binary.BigEndian.Uint32(header[:4]) != 1 || binary.BigEndian.Uint32(header[8:12]) != 0 {
				unix.Close(control)
				t.Fatalf("invalid attachment: %x, %v", header, err)
			}
			messages, err := unix.ParseSocketControlMessage(ancillary[:controlN])
			if err != nil || len(messages) != 1 {
				t.Fatalf("missing descriptor: %v", err)
			}
			descriptors, err := unix.ParseUnixRights(&messages[0])
			if err != nil || len(descriptors) != 1 {
				t.Fatalf("invalid descriptors: %v", err)
			}
			if err := unix.SetNonblock(descriptors[0], true); err != nil {
				t.Fatal(err)
			}
			file := os.NewFile(uintptr(descriptors[0]), "retained-pty")
			if err := file.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
				t.Fatal(err)
			}
			return control, file
		}
	}
	control, file := attach()
	ready := make([]byte, 5)
	if _, err := io.ReadFull(file, ready); err != nil || string(ready) != "READY" {
		t.Fatalf("shell startup: %q, %v", ready, err)
	}
	for i := 0; i < 2; i++ {
		if i > 0 {
			control, file = attach()
		}
		if err := pty.Setsize(file, &pty.Winsize{Rows: 41, Cols: 137}); err != nil {
			t.Fatal(err)
		}
		if size, err := pty.GetsizeFull(file); err != nil || size.Rows != 41 || size.Cols != 137 {
			t.Fatalf("direct resize: %+v, %v", size, err)
		}
		value := "direct Go PTY — 🐧\n"
		if _, err := io.WriteString(file, value); err != nil {
			t.Fatal(err)
		}
		data := make([]byte, len(value))
		if _, err := io.ReadFull(file, data); err != nil || string(data) != value {
			t.Fatalf("PTY roundtrip: %q, %v", data, err)
		}
		file.Close()
		if i == 1 {
			if err := unix.Send(control, []byte("X"), 0); err != nil {
				t.Fatal(err)
			}
		}
		unix.Close(control)
	}
	select {
	case err := <-done:
		waited = true
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("keeper did not acknowledge termination")
	}
}
