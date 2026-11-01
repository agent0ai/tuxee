package keeper

import (
	"context"
	"golang.org/x/sys/unix"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
	"tuxee/internal/identity"
)

func TestElevatedDescendantCleanup(t *testing.T) {
	if os.Geteuid() != 0 || os.Getenv("TUXEE_SYSTEM_TEST") != "1" {
		t.Skip("root and marked test user required")
	}
	user, err := identity.Lookup("tuxee-poc-desktop")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err = os.Chmod(dir, 0755); err != nil {
		t.Fatal(err)
	}
	// t.TempDir's parent must also be traversable by the dedicated account.
	if err = os.Chmod(filepath.Dir(dir), 0755); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(dir, "child.c")
	binary := filepath.Join(dir, "child")
	if err = os.WriteFile(source, []byte("#include <unistd.h>\nint main(void){if(setuid(0))return 1;write(1,\"ready\",5);for(;;)pause();}"), 0644); err != nil {
		t.Fatal(err)
	}
	if output, e := exec.Command("gcc", source, "-o", binary).CombinedOutput(); e != nil {
		t.Fatalf("build fixture: %s %v", output, e)
	}
	if err = os.Chmod(binary, os.ModeSetuid|0755); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(dir, "home")
	os.Mkdir(home, 0700)
	os.Chown(home, int(user.UID), int(user.GID))
	user.Home = home
	c, err := Start(user, "012345678901234567890125", "elevated-test")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	defer c.Stop()
	if c.peer == nil {
		t.Skip("kernel SO_PEERPIDFD required for privileged cleanup assistance")
	}
	cwd, err := OpenDirectory(user, home)
	if err != nil {
		t.Fatal(err)
	}
	defer cwd.Close()
	null, err := os.OpenFile("/dev/null", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer null.Close()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	cmd := user.Command(context.Background(), binary)
	job, err := c.Spawn(1, cmd.Args, cmd.Env, cwd, null, w, null, false)
	if err != nil {
		t.Fatal(err)
	}
	r.SetReadDeadline(time.Now().Add(5 * time.Second))
	b := make([]byte, 5)
	if _, err = r.Read(b); err != nil || string(b) != "ready" {
		t.Fatalf("setuid fixture failed: %q %v", b, err)
	}
	if err = c.Stop(); err != nil {
		t.Fatal(err)
	}
	if err = unix.Kill(job.PID, 0); err != unix.ESRCH {
		t.Fatal("elevated process survived", err)
	}
}
