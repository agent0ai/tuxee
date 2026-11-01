package files

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestBatchFileOperations(t *testing.T) {
	home, _ := trashFixture(t)
	var paths []string
	for i := range 87 {
		path := filepath.Join(home, fmt.Sprintf("file-%03d.txt", i))
		trashWrite(t, path, fmt.Sprint(i))
		paths = append(paths, path)
	}
	destination := filepath.Join(home, "destination")
	if err := os.Mkdir(destination, 0700); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{"copy", "move", "stat", "chmod", "trash", "trash-restore", "delete"} {
		response, _, err := execute(context.Background(), Request{Operation: operation, Paths: paths, Destination: destination, Mode: "640"}, nil)
		if err != nil || len(response.Results) != len(paths) {
			t.Fatal(operation, len(response.Results), err)
		}
		for i, result := range response.Results {
			if result.Error != "" {
				t.Fatal(operation, result.Error)
			}
			if operation == "delete" {
				if _, err := os.Lstat(paths[i]); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("not deleted", paths[i], err)
				}
				continue
			}
			if data, err := os.ReadFile(result.Path); err != nil || string(data) != fmt.Sprint(i) {
				t.Fatal(operation, result.Path, "content lost", err)
			}
			if operation == "copy" {
				if data, err := os.ReadFile(paths[i]); err != nil || string(data) != fmt.Sprint(i) {
					t.Fatal("copy changed source", err)
				}
				// Copying again in place must use the existing sibling naming policy.
				duplicate, _, err := execute(context.Background(), Request{Operation: "copy", Paths: []string{result.Path}, Destination: destination}, nil)
				if err != nil || len(duplicate.Results) != 1 || duplicate.Results[0].Error != "" || duplicate.Results[0].Path == result.Path {
					t.Fatal("duplicate", duplicate, err)
				}
			} else if operation == "chmod" {
				info, err := os.Stat(result.Path)
				if err != nil || info.Mode().Perm() != 0640 {
					t.Fatal("permissions", err)
				}
			}
			paths[i] = result.Path
		}
		// The next step moves the copies into a different folder.
		if operation == "copy" {
			destination = filepath.Join(home, "moved")
			if err := os.Mkdir(destination, 0700); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestBatchFailureAndCancellation(t *testing.T) {
	for _, operation := range []string{"copy", "move", "stat", "chmod", "trash", "trash-restore", "trash-delete", "delete"} {
		t.Run(operation, func(t *testing.T) {
			home, _ := trashFixture(t)
			paths := []string{filepath.Join(home, "first"), "relative", filepath.Join(home, "last")}
			for _, i := range []int{0, 2} {
				trashWrite(t, paths[i], "keep")
				if operation == "trash-restore" || operation == "trash-delete" {
					result, err := moveToTrash(context.Background(), paths[i])
					if err != nil {
						t.Fatal(err)
					}
					paths[i] = result.Path
				}
			}
			destination := filepath.Join(home, "destination")
			if err := os.Mkdir(destination, 0700); err != nil {
				t.Fatal(err)
			}
			request := Request{Operation: operation, Paths: paths, Destination: destination, Mode: "640"}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if _, _, err := execute(ctx, request, nil); !errors.Is(err, context.Canceled) {
				t.Fatal("cancellation", err)
			}
			for _, path := range []string{paths[0], paths[2]} {
				if data, err := os.ReadFile(path); err != nil || string(data) != "keep" {
					t.Fatal("cancelled operation changed source", err)
				}
			}
			response, _, err := execute(context.Background(), request, nil)
			if err != nil || len(response.Results) != 2 || response.Results[0].Error != "" || response.Results[1].Error == "" || response.Results[1].Text == nil {
				t.Fatal("missing ordered partial result", response, err)
			}
			if data, err := os.ReadFile(paths[2]); err != nil || string(data) != "keep" {
				t.Fatal("continued after failure", err)
			}
			request.Paths = paths[2:]
			response, _, err = execute(context.Background(), request, nil)
			if err != nil || len(response.Results) != 1 || response.Results[0].Error != "" {
				t.Fatal("remaining item cannot be retried", response, err)
			}
		})
	}
}

func TestBatchRequestValidation(t *testing.T) {
	home, _ := trashFixture(t)
	path := filepath.Join(home, "keep")
	trashWrite(t, path, "keep")
	for _, request := range []Request{
		{Operation: "trash", Paths: make([]string, 10001)},
		{Operation: "copy", Paths: []string{path}, Destination: ""},
		{Operation: "move", Paths: []string{path}, Destination: "relative"},
		{Operation: "copy", Paths: []string{path}, Destination: home + "\x00"},
	} {
		if result, _, err := execute(context.Background(), request, nil); err == nil || len(result.Results) != 0 {
			t.Fatal("accepted invalid batch", err)
		}
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "keep" {
		t.Fatal("invalid request changed source", err)
	}
}
