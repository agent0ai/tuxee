package desktop

import (
	"context"
	"encoding/binary"
	"golang.org/x/sys/unix"
	"net"
	"os"
	"os/exec"
	"runtime"
	"testing"
	"time"

	"tuxee/internal/identity"
)

func testUser(t *testing.T) identity.User {
	t.Helper()
	if os.Getenv("TUXEE_SYSTEM_TEST") != "1" || os.Geteuid() != 0 {
		t.Skip("requires GUI runtime and dedicated Linux user")
	}
	u, err := identity.Lookup("tuxee-poc-desktop")
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func waitFor(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("display condition timed out")
}

func TestLazyDisplay(t *testing.T) {
	u := testUser(t)
	d, err := Prepare(u)
	if err != nil || d == nil {
		t.Fatalf("prepare: %v", err)
	}
	defer d.Close()
	if d.process != nil || d.State().Ready {
		t.Fatal("idle terminal started display")
	}
	// A different UID cannot trigger startup, including through the abstract socket.
	c, err := net.Dial("unix", d.abstract.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	c.SetReadDeadline(time.Now().Add(time.Second))
	b := make([]byte, 1)
	_, err = c.Read(b)
	c.Close()
	if err == nil || d.process != nil {
		t.Fatal("another UID triggered the display")
	}
	cmd := u.Command(context.Background(), "xterm", "-title", "Lazy test")
	cmd.Env = append(cmd.Env, d.Env...)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	second := u.Command(context.Background(), "xterm", "-title", "Concurrent launch")
	second.Env = append(second.Env, d.Env...)
	if err := second.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { second.Process.Kill(); second.Wait() }()
	waitFor(t, func() bool { return len(d.State().Windows) == 2 })
	if !d.State().Ready {
		t.Fatal(d.State().Error)
	}
	if err = d.Activate(d.State().Windows[0].ID); err != nil {
		t.Fatal(err)
	}
	if err = d.Activate(0); err == nil {
		t.Fatal("unknown window accepted")
	}
	if err = d.CloseWindow(0); err == nil {
		t.Fatal("close accepted an unknown window")
	}
	if err = d.CloseWindow(d.State().Windows[0].ID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(d.State().Windows) == 1 })
	conn, err := net.DialTimeout("unix", d.Address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	d.Close()
	d.Close()
	if _, err = os.Stat(d.dir); !os.IsNotExist(err) {
		t.Fatal("credentials remain after close")
	}
}

func TestRepeatedDisplayStartup(t *testing.T) {
	d, err := Prepare(testUser(t))
	if err != nil || d == nil {
		t.Fatalf("prepare: %v", err)
	}
	defer d.Close()
	for cycle := range 50 {
		conn, err := d.connect()
		if err != nil {
			t.Fatalf("startup %d: %v", cycle+1, err)
		}
		conn.Close()
		d.runtime.Lock()
		d.stop(nil, nil)
		d.runtime.Unlock()
	}
}

func TestIconBounds(t *testing.T) {
	for _, data := range [][]byte{nil, {1, 2, 3}, make([]byte, 8), {255, 255, 255, 255, 255, 255, 255, 255}} {
		if windowIcon(data) != "" {
			t.Fatal("invalid icon accepted")
		}
	}
	data := make([]byte, 12)
	binary.LittleEndian.PutUint32(data, 1)
	binary.LittleEndian.PutUint32(data[4:], 1)
	binary.LittleEndian.PutUint32(data[8:], 0xff123456)
	if windowIcon(data) == "" {
		t.Fatal("valid icon rejected")
	}
}

func TestIdleDisplayMemory(t *testing.T) {
	u := testUser(t)
	// Warm allocation pools first, then measure live heap rather than cumulative allocations.
	d, err := Prepare(u)
	if err != nil || d == nil {
		t.Fatal(err)
	}
	d.Close()
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	displays := make([]*Display, 32)
	for i := range displays {
		displays[i], err = Prepare(u)
		if err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		for _, d := range displays {
			d.Close()
		}
	}()
	runtime.GC()
	runtime.ReadMemStats(&after)
	t.Logf("32 idle endpoints: live heap delta %d bytes (%.1f KiB/terminal), stack delta %d bytes, goroutines %d", int64(after.HeapAlloc)-int64(before.HeapAlloc), float64(int64(after.HeapAlloc)-int64(before.HeapAlloc))/32/1024, int64(after.StackInuse)-int64(before.StackInuse), runtime.NumGoroutine())
	var startCPU, endCPU unix.Rusage
	unix.Getrusage(unix.RUSAGE_SELF, &startCPU)
	time.Sleep(time.Second)
	unix.Getrusage(unix.RUSAGE_SELF, &endCPU)
	micros := func(r unix.Rusage) int64 {
		return r.Utime.Sec*1000000 + r.Utime.Usec + r.Stime.Sec*1000000 + r.Stime.Usec
	}
	t.Logf("32 idle endpoints: %.3f ms process CPU in one second", float64(micros(endCPU)-micros(startCPU))/1000)
	for _, d := range displays {
		if d.process != nil {
			t.Fatal("allocated an idle X server")
		}
	}
}

func TestOrdinaryTerminalWithoutRuntime(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	display, err := Prepare(identity.User{})
	if err != nil || display != nil {
		t.Fatalf("optional runtime changed ordinary terminal setup: %v %v", display, err)
	}
}
func TestCloseDuringLaunch(t *testing.T) {
	u := testUser(t)
	d, err := Prepare(u)
	if err != nil || d == nil {
		t.Fatal(err)
	}
	defer d.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := u.Command(ctx, "xterm")
	cmd.Env = append(cmd.Env, d.Env...)
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	d.Close()
	_ = cmd.Wait()
	if ctx.Err() != nil {
		t.Fatal("client hung after close during launch")
	}
	if _, err = os.Stat(d.dir); !os.IsNotExist(err) {
		t.Fatal("credentials leaked")
	}
}

func TestIdleReleaseAndRelaunch(t *testing.T) {
	u := testUser(t)
	d, err := Prepare(u)
	if err != nil || d == nil {
		t.Fatal(err)
	}
	defer d.Close()
	env := append([]string(nil), d.Env...)
	launch := func() *exec.Cmd {
		cmd := u.Command(context.Background(), "xterm", "-title", "Reclaim display")
		cmd.Env = append(cmd.Env, env...)
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
		waitFor(t, func() bool {
			state := d.State()
			if state.Error != "" {
				t.Fatal(state.Error)
			}
			return len(state.Windows) == 1
		})
		return cmd
	}
	for cycle := 0; cycle < 3; cycle++ {
		cmd := launch()
		d.runtime.Lock()
		p := d.process
		d.runtime.Unlock()
		if cycle == 0 {
			cmd.Process.Kill()
			waitFor(t, func() bool { return len(d.State().Windows) == 0 })
			cmd = launch()
			time.Sleep(2500 * time.Millisecond)
			if !d.State().Ready {
				t.Fatal("stale idle timer killed a replacement window")
			}
		}
		cmd.Process.Kill()
		waitFor(t, func() bool { return !d.State().Ready })
		select {
		case <-p.done:
		case <-time.After(3 * time.Second):
			t.Fatal("runtime group survived reclamation")
		}
		d.runtime.Lock()
		released := d.process == nil && d.windows == nil && d.x == nil
		d.runtime.Unlock()
		if !released || d.State().Error != "" {
			t.Fatalf("reclamation retained state or reported failure: %+v", d.State())
		}
		if _, err := os.Stat(d.dir + "/Xauthority"); err != nil {
			t.Fatal("reclamation removed the terminal's credentials")
		}
		for _, name := range []string{"ready", "bus-ready", "vnc", "bus", "passwd"} {
			waitFor(t, func() bool { _, err := os.Stat(d.dir + "/" + name); return os.IsNotExist(err) })
		}
	}
}
