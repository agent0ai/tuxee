package processes

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"time"

	"tuxee/internal/identity"
)

type Request struct {
	Operation string `json:"operation"`
	Targets   []Ref  `json:"targets,omitempty"`
	Signal    int    `json:"signal,omitempty"`
}
type Response struct {
	Snapshot *Snapshot `json:"snapshot,omitempty"`
	Results  []Result  `json:"results,omitempty"`
	Error    string    `json:"error,omitempty"`
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
		output.Snapshot, err = Sample(ctx)
	case "signal":
		output.Results, err = Signal(ctx, input.Targets, input.Signal)
	default:
		err = errors.New("invalid process operation")
	}
	if err != nil {
		output.Error = err.Error()
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
		return Response{}, errors.New(output.Error)
	}
	return output, nil
}
