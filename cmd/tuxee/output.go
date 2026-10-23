package main

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

type reportedError struct{ error }

func (e reportedError) Unwrap() error { return e.error }

func colored(out *os.File, color, message string) string {
	_, err := unix.IoctlGetTermios(int(out.Fd()), unix.TCGETS)
	if err != nil || os.Getenv("NO_COLOR") != "" || os.Getenv("TERM") == "dumb" {
		return message
	}
	return "\x1b[" + color + "m" + message + "\x1b[0m"
}

func updateResult(out *os.File, message, command string, failed bool) {
	color := "32"
	if failed {
		color = "31"
	}
	fmt.Fprintln(out, "\n"+colored(out, color, message))
	fmt.Fprintln(out, "\nChanges take effect after restarting Tuxee, which kills all running terminals.")
	fmt.Fprintln(out, "Restart using: "+colored(out, "33", command))
}
