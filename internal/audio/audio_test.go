package audio

import (
	"bytes"
	"context"
	"encoding/binary"
	"net"
	"os"
	"os/exec"
	"reflect"
	"testing"
	"time"

	"tuxee/internal/identity"
)

func TestSilence(t *testing.T) {
	pcm := make([]byte, Frames*4)
	if !silent(pcm) {
		t.Fatal("zero PCM was not silent")
	}
	for _, index := range []int{0, 1, 2, 3, len(pcm) - 1} {
		pcm[index] = 1
		if silent(pcm) {
			t.Fatal("quiet sample was discarded", index)
		}
		pcm[index] = 0
	}
}

func TestSharedAudio(t *testing.T) {
	if os.Getenv("TUXEE_SYSTEM_TEST") != "1" || os.Geteuid() != 0 || !Available() {
		t.Skip("requires optional runtime and dedicated Linux users")
	}
	u, err := identity.Lookup("tuxee-poc-desktop")
	if err != nil {
		t.Fatal(err)
	}
	var m Manager
	defer m.Close()
	env, release, err := m.Environment(u)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	secondEnv, releaseSecond, err := m.Environment(u)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseSecond()
	if !reflect.DeepEqual(env, secondEnv) {
		t.Fatal("terminals have different audio endpoints")
	}
	packets, unsubscribe, err := m.Subscribe(u)
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()
	second, unsubscribeSecond, err := m.Subscribe(u)
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribeSecond()
	slow, unsubscribeSlow, err := m.Subscribe(u)
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribeSlow()
	a := m.users[u.UID]
	if err := u.Command(context.Background(), "/usr/bin/test", "-w", a.dir).Run(); err == nil {
		t.Fatal("application can replace public audio paths")
	}
	other, err := identity.Lookup("tuxee-poc-a")
	if err != nil {
		t.Fatal(err)
	}
	otherEnv, releaseOther, err := m.Environment(other)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseOther()
	if reflect.DeepEqual(env, otherEnv) {
		t.Fatal("different Linux users share audio credentials")
	}
	if a.process != nil || a.capture != nil {
		t.Fatal("idle shell/browser started audio")
	}
	// Even root cannot activate another UID's private proxy.
	conn, err := net.Dial("unix", a.dir+"/native")
	if err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(time.Second))
	_, err = conn.Read(make([]byte, 1))
	conn.Close()
	if err == nil || a.process != nil {
		t.Fatal("foreign UID activated audio")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tool, err := exec.LookPath("tuxee-pacat")
	if err != nil {
		t.Fatal(err)
	}
	pcm := make([]byte, 48000*4*2)
	for _, span := range []struct {
		start, frames int
		left, right   int16
	}{{0, 4800, 256, 512}, {19200, 4800, 1, -1}, {38400, 4800, -512, 256}} {
		for i := span.start; i < span.start+span.frames; i++ {
			binary.LittleEndian.PutUint16(pcm[i*4:], uint16(span.left))
			binary.LittleEndian.PutUint16(pcm[i*4+2:], uint16(span.right))
		}
	}
	play := u.Command(ctx, tool, "--playback", "--raw", "--format=s16le", "--rate=48000", "--channels=2", "--latency-msec=20")
	play.Env = append(play.Env, env...)
	play.Stdin = bytes.NewReader(pcm)
	play.Stderr = os.Stderr
	if err = play.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { play.Process.Kill(); play.Wait() }()
	counts := map[int16]int{}
	var last uint64
	gap := false
	for counts[-512] < 4800 {
		select {
		case data := <-packets:
			if len(data) != PacketBytes {
				t.Fatalf("invalid packet: %d", len(data))
			}
			select {
			case other := <-second:
				if !bytes.Equal(data, other) {
					t.Fatal("listeners received different mixes")
				}
			case <-ctx.Done():
				t.Fatal("second listener missed audio")
			}
			position := binary.LittleEndian.Uint64(data)
			if position > last+Frames {
				gap = true
			}
			last = position
			for i := 8; i < len(data); i += 4 {
				left := int16(binary.LittleEndian.Uint16(data[i:]))
				right := int16(binary.LittleEndian.Uint16(data[i+2:]))
				if left != 0 {
					want := map[int16]int16{256: 512, 1: -1, -512: 256}[left]
					if right != want {
						t.Fatalf("stereo samples changed: %d / %d", left, right)
					}
					counts[left]++
				}
			}
		case <-ctx.Done():
			t.Fatalf("playback timed out: %v", counts)
		}
	}
	if !gap || counts[256] != 4800 || counts[1] != 4800 || counts[-512] != 4800 {
		t.Fatalf("onset/quiet samples or pauses lost: %v gap=%v", counts, gap)
	}
	for {
		select {
		case _, ok := <-slow:
			if !ok {
				goto slowClosed
			}
		default:
			t.Fatal("slow listener was not disconnected")
		}
	}
slowClosed:
	unsubscribeSlow()
	select {
	case <-packets:
		t.Fatal("silence was streamed")
	case <-time.After(300 * time.Millisecond):
	}
	a.mu.Lock()
	pid := a.process.Process.Pid
	recording := a.capture
	a.mu.Unlock()
	unsubscribe()
	a.mu.Lock()
	stillRecording := a.capture
	a.mu.Unlock()
	if stillRecording != recording {
		t.Fatal("one listener's mute affected another")
	}
	unsubscribeSecond()
	a.mu.Lock()
	stopped := a.capture == nil
	a.mu.Unlock()
	if !stopped {
		t.Fatal("last listener did not stop capture")
	}
	// Never forward an application's bytes to a socket serving another UID.
	foreignPath := t.TempDir() + "/foreign"
	foreign, err := net.ListenUnix("unix", &net.UnixAddr{Name: foreignPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer foreign.Close()
	if err = os.Rename(a.dir+"/pulse/native", a.dir+"/pulse/saved"); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(foreignPath, a.dir+"/pulse/native"); err != nil {
		t.Fatal(err)
	}
	if conn, err := a.connect(); err == nil {
		conn.Close()
		t.Fatal("foreign upstream socket accepted")
	}
	os.Remove(a.dir + "/pulse/native")
	if err = os.Rename(a.dir+"/pulse/saved", a.dir+"/pulse/native"); err != nil {
		t.Fatal(err)
	}
	release()
	a.mu.Lock()
	alive := a.process != nil && a.process.Process.Pid == pid
	a.mu.Unlock()
	if !alive {
		t.Fatal("closing one terminal stopped shared audio")
	}
	releaseSecond()
	if _, err := os.Stat(a.dir); !os.IsNotExist(err) {
		t.Fatal("last reference left audio files")
	}
}

func TestRuntimeRelaunch(t *testing.T) {
	if os.Getenv("TUXEE_SYSTEM_TEST") != "1" || os.Geteuid() != 0 || !Available() {
		t.Skip("requires optional runtime and dedicated Linux user")
	}
	u, err := identity.Lookup("tuxee-poc-desktop")
	if err != nil {
		t.Fatal(err)
	}
	root := u
	root.UID, root.GID, root.Groups, root.Home = 0, 0, []uint32{0}, t.TempDir()
	for _, user := range []identity.User{u, root} {
		t.Run(user.Home, func(t *testing.T) {
			var m Manager
			defer m.Close()
			packets, unsubscribe, err := m.Subscribe(user)
			if err != nil {
				t.Fatal(err)
			}
			defer unsubscribe()
			var previous []string
			for cycle := 0; cycle < 2; cycle++ {
				env, release, err := m.Environment(user)
				if err != nil {
					t.Fatal(err)
				}
				defer release()
				if previous != nil && !reflect.DeepEqual(previous, env) {
					t.Fatal("relaunch replaced a live browser's endpoint")
				}
				previous = env
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				tool, err := exec.LookPath("tuxee-pacat")
				if err != nil {
					t.Fatal(err)
				}
				play := user.Command(ctx, tool, "--playback", "--raw", "--format=s16le", "--rate=48000", "--channels=2", "--latency-msec=20")
				play.Env = append(play.Env, env...)
				pcm := append(bytes.Repeat([]byte{1, 0, 255, 255}, 4800), make([]byte, 48000*4)...)
				play.Stdin = bytes.NewReader(pcm)
				if err = play.Start(); err != nil {
					t.Fatal(err)
				}
				defer func() { play.Process.Kill(); play.Wait() }()
				count := 0
				for count < 4800 {
					select {
					case data, ok := <-packets:
						if !ok {
							t.Fatal("browser subscription ended during relaunch")
						}
						for i := 8; i < len(data); i += 4 {
							if data[i] == 1 {
								count++
							}
						}
					case <-ctx.Done():
						t.Fatal("relaunch did not play audio")
					}
				}
				if err = play.Wait(); err != nil {
					t.Fatal(err)
				}
				release()
				a := m.users[user.UID]
				a.mu.Lock()
				stopped := a.process == nil && a.capture == nil
				a.mu.Unlock()
				if !stopped {
					t.Fatal("last terminal left audio processes")
				}
				if conn, err := a.connect(); err == nil {
					conn.Close()
					t.Fatal("audio restarted without a terminal")
				}
			}
		})
	}
}
