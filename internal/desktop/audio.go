package desktop

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
)

// Audio captures this display's virtual output as 48 kHz stereo signed 16-bit PCM.
func (d *Display) Audio(ctx context.Context) (io.ReadCloser, func(), error) {
	if state := d.State(); state == nil || !state.Ready || !state.Audio {
		return nil, nil, errors.New("display audio is unavailable")
	}
	tool, err := exec.LookPath("tuxee-pacat")
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(d.ctx, cancel)
	cmd := d.user.Command(ctx, tool, "--record", "--raw", "--format=s16le", "--rate=48000", "--channels=2", "--latency-msec=20", "--process-time-msec=10", "--device=tuxee.monitor")
	cmd.Env = append(cmd.Env, d.Env...)
	cmd.Stderr = os.Stderr
	output, err := cmd.StdoutPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		stop()
		cancel()
		if output != nil {
			output.Close()
		}
		return nil, nil, err
	}
	return output, func() { stop(); cancel(); output.Close(); cmd.Wait() }, nil
}
