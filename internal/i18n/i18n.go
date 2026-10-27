// Package i18n owns the shared message catalogs and language-independent errors.
package i18n

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

//go:embed locales/*.json
var builtins embed.FS

const SystemDirectory = "/etc/tuxee/i18n"
const maxCatalogBytes = 2 << 20

var languageCode = regexp.MustCompile(`^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$`)
var variable = regexp.MustCompile(`\{([A-Za-z][A-Za-z0-9_]*)\}`)

type Vars map[string]any
type Message struct {
	Key  string `json:"key"`
	Vars Vars   `json:"vars,omitempty"`
}
type Error struct {
	Message
	cause error
}

func New(key string, vars ...Vars) *Error {
	e := &Error{Message: Message{Key: key}}
	if len(vars) > 0 {
		e.Vars = vars[0]
	}
	return e
}
func Wrap(key string, cause error, vars Vars) *Error { e := New(key, vars); e.cause = cause; return e }
func (e *Error) Error() string                       { return english().Text(e.Message) }
func (e *Error) Unwrap() error                       { return e.cause }
func From(message *Message, diagnostic string) error {
	if message != nil {
		return New(message.Key, message.Vars)
	}
	return errors.New(diagnostic)
}
func Describe(err error) *Message {
	if err == nil {
		return nil
	}
	if e, ok := err.(*Error); ok {
		return &e.Message
	}
	var path *fs.PathError
	if errors.As(err, &path) {
		return &Message{Key: "error.path", Vars: Vars{"operation": path.Op, "path": path.Path, "detail": Describe(path.Err)}}
	}
	var link *os.LinkError
	if errors.As(err, &link) {
		return &Message{Key: "error.link", Vars: Vars{"operation": link.Op, "source": link.Old, "destination": link.New, "detail": Describe(link.Err)}}
	}
	for _, item := range []struct {
		err error
		key string
	}{
		{context.Canceled, "error.cancelled"}, {context.DeadlineExceeded, "error.timedOut"}, {syscall.EACCES, "error.permissionDenied"}, {syscall.EPERM, "error.operationNotPermitted"}, {syscall.ENOENT, "error.fileOrDirectoryNotFound"}, {syscall.EEXIST, "error.fileExists"}, {syscall.ENOTDIR, "error.notDirectory"}, {syscall.EISDIR, "error.isDirectory"}, {syscall.ENOSPC, "error.deviceFull"}, {syscall.EROFS, "error.readOnlyFilesystem"}, {syscall.ENOTEMPTY, "error.directoryNotEmpty"}, {syscall.ESRCH, "error.processGone"},
	} {
		if errors.Is(err, item.err) {
			return &Message{Key: item.key}
		}
	}
	// External diagnostics remain data; Tuxee-owned errors carry their message key.
	return &Message{Key: "error.detail", Vars: Vars{"detail": err.Error()}}
}

type Catalog struct {
	Name  string            `json:"name"`
	Texts map[string]string `json:"texts"`
}
type Language struct {
	Code string `json:"code"`
	Name string `json:"name"`
}
type Bundle struct {
	Language  string            `json:"language"`
	Direction string            `json:"direction"`
	Texts     map[string]string `json:"texts"`
	Languages []Language        `json:"languages"`
	Cookie    string            `json:"cookie"`
}

func (c *Catalog) Text(m Message) string {
	values := make(map[string]string, len(m.Vars))
	for key, value := range m.Vars {
		switch v := value.(type) {
		case *Message:
			if v != nil {
				values[key] = c.Text(*v)
			}
		case Message:
			values[key] = c.Text(v)
		case map[string]any:
			if nested, ok := v["key"].(string); ok {
				vars, _ := v["vars"].(map[string]any)
				values[key] = c.Text(Message{Key: nested, Vars: Vars(vars)})
			} else {
				values[key] = fmt.Sprint(v)
			}
		default:
			values[key] = fmt.Sprint(value)
		}
	}
	template, ok := c.Texts[m.Key]
	if !ok {
		return missing(m.Key, m.Vars)
	}
	valid := true
	text := variable.ReplaceAllStringFunc(template, func(token string) string {
		value, ok := values[token[1:len(token)-1]]
		if !ok {
			valid = false
		}
		return value
	})
	if !valid {
		return missing(m.Key, m.Vars)
	}
	return text
}
func missing(key string, vars Vars) string {
	text := "[!" + key
	names := make([]string, 0, len(vars))
	for name := range vars {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		value, err := json.Marshal(vars[name])
		if err != nil {
			value = []byte(strconv.Quote(fmt.Sprint(vars[name])))
		}
		text += " " + name + "=" + string(value)
	}
	return text + "]"
}

var english = sync.OnceValue(func() *Catalog {
	data, err := builtins.ReadFile("locales/en.json")
	if err != nil {
		panic(err)
	}
	catalog, err := decode(data, false)
	if err != nil {
		panic(err)
	}
	return catalog
})

func decode(data []byte, partial bool) (*Catalog, error) {
	var catalog Catalog
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&catalog); err != nil {
		return nil, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, errors.New("catalog must contain one JSON object")
	}
	if (!partial && strings.TrimSpace(catalog.Name) == "") || len(catalog.Name) > 100 || catalog.Texts == nil {
		return nil, errors.New("catalog requires a name and texts")
	}
	for key, value := range catalog.Texts {
		if key == "" || len(key) > 160 || len(value) > 16384 {
			return nil, errors.New("invalid catalog message")
		}
	}
	return &catalog, nil
}

type Store struct {
	directory string
	mu        sync.Mutex
	catalogs  map[string]*Catalog
	bundles   map[string]*Bundle
}

func NewStore(directory string) *Store { s := &Store{directory: directory}; s.Refresh(); return s }

// Refresh runs at login or explicit language selection, never for individual texts.
func (s *Store) Refresh() {
	s.mu.Lock()
	defer s.mu.Unlock()
	catalogs := map[string]*Catalog{}
	entries, _ := builtins.ReadDir("locales")
	for _, entry := range entries {
		data, _ := builtins.ReadFile("locales/" + entry.Name())
		catalog, err := decode(data, false)
		if err != nil {
			panic(err)
		}
		catalogs[strings.TrimSuffix(entry.Name(), ".json")] = catalog
	}
	entries, err := os.ReadDir(s.directory)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		log.Printf("i18n: %v", err)
	}
	totalBytes := 0
	for i, entry := range entries {
		if i >= 256 {
			log.Print("i18n: ignoring files beyond the 256-file limit")
			break
		}
		code := strings.TrimSuffix(entry.Name(), ".json")
		if !strings.HasSuffix(entry.Name(), ".json") || !languageCode.MatchString(code) || !entry.Type().IsRegular() {
			continue
		}
		file, err := os.OpenFile(filepath.Join(s.directory, entry.Name()), os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
		if err != nil {
			log.Printf("i18n: %s: %v", entry.Name(), err)
			continue
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			file.Close()
			continue
		}
		data, err := io.ReadAll(io.LimitReader(file, maxCatalogBytes+1))
		file.Close()
		if err != nil || len(data) > maxCatalogBytes {
			log.Printf("i18n: cannot read %s (maximum 2 MiB)", entry.Name())
			continue
		}
		totalBytes += len(data)
		if totalBytes > 16<<20 {
			log.Print("i18n: system catalogs exceed 16 MiB")
			break
		}
		override, err := decode(data, true)
		if err != nil {
			log.Printf("i18n: %s: %v", entry.Name(), err)
			continue
		}
		catalog := catalogs[code]
		if catalog == nil {
			if strings.TrimSpace(override.Name) == "" {
				log.Printf("i18n: %s needs a language name", entry.Name())
				continue
			}
			catalog = &Catalog{Name: override.Name, Texts: map[string]string{}}
			catalogs[code] = catalog
		}
		if override.Name != "" {
			catalog.Name = override.Name
		}
		maps.Copy(catalog.Texts, override.Texts)
	}
	unchanged := len(s.catalogs) == len(catalogs)
	for code, catalog := range catalogs {
		previous := s.catalogs[code]
		if previous == nil || previous.Name != catalog.Name || !maps.Equal(previous.Texts, catalog.Texts) {
			unchanged = false
			break
		}
	}
	if unchanged {
		return
	}
	s.catalogs = catalogs
	s.bundles = map[string]*Bundle{}
}
func (s *Store) Bundle(code, cookie string) *Bundle {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.catalogs[code]; !ok {
		code = "en"
	}
	if bundle := s.bundles[code]; bundle != nil {
		result := *bundle
		result.Cookie = cookie
		return &result
	}
	texts := maps.Clone(s.catalogs["en"].Texts)
	maps.Copy(texts, s.catalogs[code].Texts)
	languages := make([]Language, 0, len(s.catalogs))
	for code, catalog := range s.catalogs {
		languages = append(languages, Language{code, catalog.Name})
	}
	sort.Slice(languages, func(i, j int) bool {
		return languages[i].Code < languages[j].Code
	})
	direction := "ltr"
	base, _, _ := strings.Cut(code, "-")
	switch base {
	case "ar", "fa", "he":
		direction = "rtl"
	}
	bundle := &Bundle{Language: code, Direction: direction, Texts: texts, Languages: languages}
	s.bundles[code] = bundle
	result := *bundle
	result.Cookie = cookie
	return &result
}
