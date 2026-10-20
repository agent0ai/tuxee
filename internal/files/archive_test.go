package files

import (
	"archive/tar"
	"archive/zip"
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestArchiveRoundTripAndPasswords(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "hello.txt")
	if err := os.WriteFile(path, []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	literal := filepath.Join(dir, "literal*.txt")
	for _, name := range []string{literal, filepath.Join(dir, "literal-other.txt")} {
		if err := os.WriteFile(name, []byte("literal"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	formats := archiveFormats()
	if len(formats) == 0 {
		t.Skip("no archive tools")
	}
	for _, format := range formats {
		t.Run(format.Name, func(t *testing.T) {
			dest := filepath.Join(dir, "bundle."+format.Name)
			password := ""
			if format.Password {
				password = "test archive secret"
			}
			if err := archive(context.Background(), Request{Operation: "compress", Path: dir, Paths: []string{path, literal}, Destination: dest, Format: format.Name, Password: password}); err != nil {
				t.Fatal(err)
			}
			extracted := filepath.Join(dir, "out-"+format.Name)
			if err := archive(context.Background(), Request{Operation: "extract", Path: dest, Destination: extracted, Password: password}); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(filepath.Join(extracted, "hello.txt"))
			if err != nil || string(data) != "hello" {
				t.Fatal(err)
			}
			if data, err = os.ReadFile(filepath.Join(extracted, "literal*.txt")); err != nil || string(data) != "literal" {
				t.Fatal("lost literal filename", err)
			}
			if _, err = os.Stat(filepath.Join(extracted, "literal-other.txt")); !os.IsNotExist(err) {
				t.Fatal("archived a file that was not selected")
			}
			if err := archive(context.Background(), Request{Operation: "extract", Path: dest, Destination: extracted, Password: password}); err == nil {
				t.Fatal("overwrote destination")
			}
			if format.Password {
				failed := extracted + "-wrong"
				if err := archive(context.Background(), Request{Operation: "extract", Path: dest, Destination: failed, Password: "wrong"}); err == nil {
					t.Fatal("accepted bad password")
				}
				if _, err := os.Stat(failed); !os.IsNotExist(err) {
					t.Fatal("published failed extraction")
				}
			}
		})
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if len(entry.Name()) >= 7 && entry.Name()[:7] == ".tuxee-" {
			t.Fatal("left staging files")
		}
	}
}
func TestArchiveCannotWriteOutsideNewDestination(t *testing.T) {
	dir := t.TempDir()
	destination := filepath.Join(dir, "out")
	for _, format := range []string{"tar", "zip"} {
		if format == "zip" && sevenZip() == "" {
			continue
		}
		file, err := os.Create(filepath.Join(dir, "escape."+format))
		if err != nil {
			t.Fatal(err)
		}
		if format == "tar" {
			writer := tar.NewWriter(file)
			_ = writer.WriteHeader(&tar.Header{Name: "../escaped", Mode: 0600, Size: 4})
			_, _ = writer.Write([]byte("oops"))
			_ = writer.Close()
		} else {
			writer := zip.NewWriter(file)
			entry, _ := writer.Create("../escaped")
			_, _ = entry.Write([]byte("oops"))
			_ = writer.Close()
		}
		file.Close()
		_ = archive(context.Background(), Request{Operation: "extract", Path: file.Name(), Destination: destination + format})
		if _, err := os.Stat(filepath.Join(dir, "escaped")); !os.IsNotExist(err) {
			t.Fatal("archive escaped destination")
		}
	}
}

func TestArchiveLinkCannotOverwriteOutsideFile(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(dir, "outside")
	if err := os.Mkdir(outside, 0700); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(outside, "sentinel")
	if err := os.WriteFile(sentinel, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, format := range []string{"tar", "zip"} {
		if format == "zip" && sevenZip() == "" {
			continue
		}
		t.Run(format, func(t *testing.T) {
			file, err := os.Create(filepath.Join(dir, "link."+format))
			if err != nil {
				t.Fatal(err)
			}
			if format == "tar" {
				writer := tar.NewWriter(file)
				if err = writer.WriteHeader(&tar.Header{Name: "bridge", Typeflag: tar.TypeSymlink, Linkname: outside, Mode: 0777}); err != nil {
					t.Fatal(err)
				}
				if err = writer.WriteHeader(&tar.Header{Name: "bridge/sentinel", Mode: 0600, Size: 4}); err != nil {
					t.Fatal(err)
				}
				_, _ = writer.Write([]byte("oops"))
				_ = writer.Close()
			} else {
				writer := zip.NewWriter(file)
				header := &zip.FileHeader{Name: "bridge"}
				header.SetMode(os.ModeSymlink | 0777)
				link, err := writer.CreateHeader(header)
				if err != nil {
					t.Fatal(err)
				}
				_, _ = link.Write([]byte(outside))
				entry, _ := writer.Create("bridge/sentinel")
				_, _ = entry.Write([]byte("oops"))
				_ = writer.Close()
			}
			_ = file.Close()
			_ = archive(context.Background(), Request{Operation: "extract", Path: file.Name(), Destination: filepath.Join(dir, "out-"+format)})
			data, err := os.ReadFile(sentinel)
			if err != nil || string(data) != "keep" {
				t.Fatal("archive overwrote an external file", err)
			}
		})
	}
}
