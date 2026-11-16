package audio

import (
	"context"
	"os"
	"os/exec"
	"sync"
	"time"
	"tuxee/internal/i18n"
	"tuxee/internal/identity"
)

const MicrophonePacketBytes = Frames * 2

// Microphone is a single browser's mono PCM input, separate from speaker output.
type Microphone struct {
	input   *os.File
	cancel  context.CancelFunc
	done    chan struct{}
	release func()
	once    sync.Once
}

func (m *Manager) Microphone(user identity.User) (*Microphone, error) {
	a, release, err := m.acquire(user, true)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	ok := false
	defer func() {
		a.mu.Unlock()
		if !ok {
			release()
		}
	}()
	if a.microphone != nil {
		return nil, i18n.New("audio.microphoneBusy")
	}
	if err = a.startLocked(); err != nil {
		return nil, err
	}
	tool, err := exec.LookPath("tuxee-pacat")
	if err != nil {
		return nil, err
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	ctx, cancel := context.WithCancel(a.ctx)
	cmd := user.Command(ctx, tool, "--playback", "--raw", "--format=s16le", "--rate=48000", "--channels=1", "--latency-msec=20", "--process-time-msec=10", "--device=tuxee-microphone-input")
	cmd.Env = append(cmd.Env, "PULSE_SERVER=unix:"+a.dir+"/pulse/native", "PULSE_COOKIE="+a.dir+"/cookie")
	cmd.Stdin = reader
	if err = cmd.Start(); err != nil {
		cancel()
		writer.Close()
		return nil, err
	}
	mic := &Microphone{input: writer, cancel: cancel, done: make(chan struct{})}
	mic.release = func() {
		a.mu.Lock()
		if a.microphone == mic {
			a.microphone = nil
		}
		a.mu.Unlock()
		release()
	}
	a.microphone = mic
	a.workers.Add(1)
	go func() { defer a.workers.Done(); cmd.Wait(); writer.Close(); close(mic.done) }()
	ok = true
	return mic, nil
}

func (m *Microphone) Done() <-chan struct{} { return m.done }

func (m *Microphone) Write(packet []byte) error {
	if len(packet) != MicrophonePacketBytes {
		return i18n.New("audio.invalidData")
	}
	if err := m.input.SetWriteDeadline(time.Now().Add(250 * time.Millisecond)); err != nil {
		return err
	}
	_, err := m.input.Write(packet)
	return err
}

func (m *Microphone) Close() {
	m.once.Do(func() { m.cancel(); m.input.Close(); <-m.done; m.release() })
}
