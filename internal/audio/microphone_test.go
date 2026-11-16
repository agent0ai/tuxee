package audio

import (
	"context"
	"encoding/binary"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"
	"tuxee/internal/identity"
)

func TestMicrophone(t *testing.T) {
	if os.Getenv("TUXEE_SYSTEM_TEST") != "1" || os.Geteuid() != 0 || !Available() {
		t.Skip("requires audio runtime and root")
	}
	u, err := identity.Lookup("root")
	if err != nil {
		t.Fatal(err)
	}
	u.Home = t.TempDir()
	var manager Manager
	defer manager.Close()
	env, release, err := manager.Environment(u)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	mic, err := manager.Microphone(u)
	if err != nil {
		t.Fatal(err)
	}
	defer mic.Close()
	if other, err := manager.Microphone(u); err == nil {
		other.Close()
		t.Fatal("two microphone owners")
	}
	if err := mic.Write([]byte{0}); err == nil {
		t.Fatal("accepted malformed PCM")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tool, _ := exec.LookPath("tuxee-pacat")
	recorder := u.Command(ctx, tool, "--record", "--raw", "--format=s16le", "--rate=48000", "--channels=1", "--latency-msec=20")
	recorder.Env = append(recorder.Env, env...)
	output, err := recorder.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = recorder.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); recorder.Wait() }()
	// The default recording source must carry microphone samples, not speaker output.
	found := make(chan bool, 1)
	go func() {
		packet := make([]byte, MicrophonePacketBytes)
		for {
			if _, err := io.ReadFull(output, packet); err != nil {
				found <- false
				return
			}
			for i := 0; i < len(packet); i += 2 {
				if binary.LittleEndian.Uint16(packet[i:]) == 4321 {
					found <- true
					return
				}
			}
		}
	}()
	packet := make([]byte, MicrophonePacketBytes)
	for i := 0; i < len(packet); i += 2 {
		binary.LittleEndian.PutUint16(packet[i:], 4321)
	}
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			t.Fatal("microphone did not reach default recording source")
		case ok := <-found:
			if !ok {
				t.Fatal("recording stopped")
			}
			mic.Close()
			next, err := manager.Microphone(u)
			if err != nil {
				t.Fatal(err)
			}
			defer next.Close()
			release()
			select {
			case <-next.Done():
			case <-time.After(time.Second):
				t.Fatal("last terminal left microphone running")
			}
			return
		case <-ticker.C:
			if err := mic.Write(packet); err != nil {
				t.Fatal(err)
			}
		}
	}
}
