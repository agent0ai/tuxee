package processes

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"time"
	"tuxee/internal/i18n"

	"golang.org/x/sys/unix"
	"tuxee/internal/identity"
)

type Request struct {
	Operation string `json:"operation"`
	AllowCore bool   `json:"allowCore,omitempty"`
	Sort      string `json:"sort,omitempty"`
	Targets   []Ref  `json:"targets,omitempty"`
	Signal    int    `json:"signal,omitempty"`
}
type Response struct {
	Text     *i18n.Message `json:"text,omitempty"`
	Snapshot *Snapshot     `json:"snapshot,omitempty"`
	Results  []Result      `json:"results,omitempty"`
	Error    string        `json:"error,omitempty"`
}

func Worker() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var input Request
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 8<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return err
	}
	var output Response
	var err error
	switch input.Operation {
	case "list":
		output.Snapshot, err = Sample(ctx, input.AllowCore)
		if err == nil {
			err = output.Snapshot.readCommandLines(ctx, "/proc", input.Sort)
		}
	case "signal":
		output.Results, err = Signal(ctx, input.Targets, input.Signal, input.AllowCore)
	case "check-parent-signal":
		// Signal zero checks the user's permission without interrupting the server.
		err = unix.Kill(os.Getppid(), 0)
	default:
		err = i18n.New("backend.processes.invalidProcessOperation")
	}
	if err != nil {
		output.Error = err.Error()
		output.Text = i18n.Describe(err)
	}
	return json.NewEncoder(os.Stdout).Encode(output)
}
func Run(ctx context.Context, user identity.User, input Request) (Response, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := user.Command(ctx, identity.Self, "__processes")
	cmd.Dir = "/"
	cmd.WaitDelay = time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return Response{}, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return Response{}, err
	}
	if err = cmd.Start(); err != nil {
		return Response{}, err
	}
	// Input can exceed a pipe buffer for large subtrees; write while decoding output.
	sent := make(chan error, 1)
	go func() { err := json.NewEncoder(stdin).Encode(input); stdin.Close(); sent <- err }()
	var output Response
	err = json.NewDecoder(io.LimitReader(stdout, 64<<20)).Decode(&output)
	if err != nil {
		cancel()
	}
	waitErr := cmd.Wait()
	inputErr := <-sent
	if ctx.Err() != nil {
		return Response{}, ctx.Err()
	}
	if err != nil {
		return Response{}, err
	}
	if inputErr != nil {
		return Response{}, inputErr
	}
	if waitErr != nil {
		return Response{}, waitErr
	}
	if output.Error != "" {
		return Response{}, i18n.From(output.Text, output.Error)
	}
	return output, nil
}
