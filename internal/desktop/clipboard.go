package desktop

import (
	"bytes"
	"context"
	"image/png"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"
	"tuxee/internal/i18n"
	"unicode/utf8"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xfixes"
	"github.com/jezek/xgb/xproto"
)

const MaxClipboardBytes = 16 << 20
const maxClipboardPixels = 16 << 20
const maxClipboardText = 256 << 10
const selectionChunk = 64 << 10

type ClipboardData struct {
	Text  string   `json:"text,omitempty"`
	PNG   []byte   `json:"png,omitempty"`
	Files []string `json:"files,omitempty"`
}

type ClipboardChange struct {
	Version uint64 `json:"version"`
	Local   bool   `json:"local"`
}

type selectionTransfer struct {
	target xproto.Atom
	data   []byte
	timer  *time.Timer
}
type selectionKey struct {
	window   xproto.Window
	property xproto.Atom
}

// This connection already belongs to one private terminal display. No filesystem
// access occurs here: file references are consumed under the receiving app's UID.
type clipboard struct {
	x                  *xgb.Conn
	root, window       xproto.Window
	atoms              map[string]xproto.Atom
	mu                 sync.Mutex
	change             ClipboardChange
	stamp              xproto.Timestamp
	data, dropData     map[xproto.Atom][]byte
	subscribers        map[chan ClipboardChange]bool
	requests           map[xproto.Window]chan xgb.Event
	sending            map[selectionKey]*selectionTransfer
	readGate, dropGate chan struct{}
	dropEvents         chan xproto.ClientMessageEvent
	done               chan struct{}
}

func newClipboard(x *xgb.Conn) (*clipboard, error) {
	c := &clipboard{x: x, root: xproto.Setup(x).DefaultScreen(x).Root, atoms: map[string]xproto.Atom{},
		subscribers: map[chan ClipboardChange]bool{}, requests: map[xproto.Window]chan xgb.Event{}, sending: map[selectionKey]*selectionTransfer{},
		readGate: make(chan struct{}, 1), dropGate: make(chan struct{}, 1), done: make(chan struct{})}
	for _, name := range []string{"CLIPBOARD", "TARGETS", "TIMESTAMP", "MULTIPLE", "ATOM_PAIR", "INCR", "UTF8_STRING", "TEXT", "STRING", "text/plain", "text/plain;charset=utf-8", "image/png", "text/uri-list", "x-special/gnome-copied-files", "_TUXEE_SELECTION", "XdndAware", "XdndProxy", "XdndEnter", "XdndPosition", "XdndStatus", "XdndLeave", "XdndDrop", "XdndFinished", "XdndSelection", "XdndActionCopy"} {
		a, err := xproto.InternAtom(x, false, uint16(len(name)), name).Reply()
		if err != nil {
			return nil, err
		}
		c.atoms[name] = a.Atom
	}
	var err error
	c.window, err = c.newWindow()
	if err != nil {
		return nil, err
	}
	if err = xfixes.Init(x); err != nil {
		return nil, err
	}
	if _, err = xfixes.QueryVersion(x, 5, 0).Reply(); err != nil {
		return nil, err
	}
	if err = xfixes.SelectSelectionInputChecked(x, c.window, c.atoms["CLIPBOARD"], xfixes.SelectionEventMaskSetSelectionOwner|xfixes.SelectionEventMaskSelectionWindowDestroy|xfixes.SelectionEventMaskSelectionClientClose).Check(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *clipboard) newWindow() (xproto.Window, error) {
	id, err := xproto.NewWindowId(c.x)
	if err != nil {
		return 0, err
	}
	err = xproto.CreateWindowChecked(c.x, 0, id, c.root, 0, 0, 1, 1, 0, xproto.WindowClassInputOnly, 0, xproto.CwEventMask, []uint32{xproto.EventMaskPropertyChange}).Check()
	return id, err
}

func (c *clipboard) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	close(c.done)
	for ch := range c.subscribers {
		close(ch)
	}
	for _, t := range c.sending {
		t.timer.Stop()
	}
	c.sending = nil
	c.data = nil
	c.dropData = nil
}

func (d *Display) clipboard() (*clipboard, error) {
	if d == nil {
		return nil, i18n.New("backend.desktop.displayUnavailable")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.state.Ready || d.windows == nil {
		return nil, i18n.New("backend.desktop.displayUnavailable")
	}
	return d.windows.clipboard, nil
}

func (d *Display) ClipboardChanges() (<-chan ClipboardChange, func(), error) {
	c, err := d.clipboard()
	if err != nil {
		return nil, nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	select {
	case <-c.done:
		return nil, nil, i18n.New("backend.desktop.displayUnavailable")
	default:
	}
	if len(c.subscribers) >= 16 {
		return nil, nil, i18n.New("backend.desktop.tooManyClipboardViewers")
	}
	ch := make(chan ClipboardChange, 1)
	ch <- c.change
	c.subscribers[ch] = true
	return ch, func() { c.mu.Lock(); delete(c.subscribers, ch); c.mu.Unlock() }, nil
}

func (c *clipboard) event(event xgb.Event) {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch e := event.(type) {
	case xfixes.SelectionNotifyEvent:
		if e.Selection != c.atoms["CLIPBOARD"] {
			return
		}
		c.change = ClipboardChange{Version: c.change.Version + 1, Local: e.Owner == c.window || e.Owner == 0}
		c.stamp = e.SelectionTimestamp
		if e.Owner != c.window {
			// A newer browser paste may already own the selection while this
			// notification was queued behind other X events.
			owner, err := xproto.GetSelectionOwner(c.x, c.atoms["CLIPBOARD"]).Reply()
			if err != nil || owner.Owner != c.window {
				c.data = nil
			}
		}
		for ch := range c.subscribers {
			select {
			case <-ch:
			default:
			}
			ch <- c.change
		}
	case xproto.SelectionRequestEvent:
		c.serve(e)
	case xproto.SelectionNotifyEvent:
		if ch := c.requests[e.Requestor]; ch != nil {
			select {
			case ch <- e:
			default:
			}
		}
	case xproto.PropertyNotifyEvent:
		if ch := c.requests[e.Window]; ch != nil {
			select {
			case ch <- e:
			default:
			}
		}
		if e.State == xproto.PropertyDelete {
			key := selectionKey{e.Window, e.Atom}
			t := c.sending[key]
			if t == nil {
				return
			}
			n := min(len(t.data), selectionChunk)
			xproto.ChangeProperty(c.x, xproto.PropModeReplace, e.Window, e.Atom, t.target, 8, uint32(n), t.data[:n])
			t.data = t.data[n:]
			if n == 0 {
				t.timer.Stop()
				delete(c.sending, key)
			}
		}
	case xproto.ClientMessageEvent:
		if c.dropEvents != nil && (e.Type == c.atoms["XdndStatus"] || e.Type == c.atoms["XdndFinished"]) {
			select {
			case c.dropEvents <- e:
			default:
			}
		}
	}
}

func (c *clipboard) serve(e xproto.SelectionRequestEvent) {
	property := e.Property
	if property == 0 {
		property = e.Target
	}
	data := c.data
	if e.Selection == c.atoms["XdndSelection"] {
		data = c.dropData
	} else if e.Selection != c.atoms["CLIPBOARD"] {
		data = nil
	}
	if e.Selection == c.atoms["CLIPBOARD"] && e.Time != 0 && int32(e.Time-c.stamp) < 0 {
		data = nil
	}
	ok := false
	if data != nil && e.Target == c.atoms["MULTIPLE"] {
		pairs, err := xproto.GetProperty(c.x, false, e.Requestor, property, xproto.GetPropertyTypeAny, 0, 128).Reply()
		if err == nil && pairs.Format == 32 && pairs.BytesAfter == 0 && len(pairs.Value)%8 == 0 {
			for i := 0; i < len(pairs.Value); i += 8 {
				target, dest := xproto.Atom(xgb.Get32(pairs.Value[i:])), xproto.Atom(xgb.Get32(pairs.Value[i+4:]))
				if dest == property || !c.provide(e.Requestor, target, dest, data) {
					xgb.Put32(pairs.Value[i+4:], 0)
				}
			}
			ok = xproto.ChangePropertyChecked(c.x, xproto.PropModeReplace, e.Requestor, property, c.atoms["ATOM_PAIR"], 32, uint32(len(pairs.Value)/4), pairs.Value).Check() == nil
		}
	} else if data != nil {
		ok = c.provide(e.Requestor, e.Target, property, data)
	}
	if !ok {
		property = 0
	}
	notify := xproto.SelectionNotifyEvent{Time: e.Time, Requestor: e.Requestor, Selection: e.Selection, Target: e.Target, Property: property}
	xproto.SendEvent(c.x, false, e.Requestor, 0, string(notify.Bytes()))
}

func (c *clipboard) provide(window xproto.Window, target, property xproto.Atom, data map[xproto.Atom][]byte) bool {
	if property == 0 {
		return false
	}
	typ, format := target, byte(8)
	value, ok := data[target]
	switch target {
	case c.atoms["TARGETS"]:
		typ, format = xproto.AtomAtom, 32
		value = make([]byte, 0, 4*(len(data)+3))
		for _, a := range []xproto.Atom{c.atoms["TARGETS"], c.atoms["TIMESTAMP"], c.atoms["MULTIPLE"]} {
			value = append32(value, uint32(a))
		}
		for a := range data {
			value = append32(value, uint32(a))
		}
		ok = true
	case c.atoms["TIMESTAMP"]:
		typ, format = xproto.AtomInteger, 32
		value = append32(nil, uint32(c.stamp))
		ok = true
	}
	if !ok {
		return false
	}
	if len(value) > selectionChunk {
		key := selectionKey{window, property}
		if len(c.sending) >= 16 || c.sending[key] != nil {
			return false
		}
		if xproto.ChangeWindowAttributesChecked(c.x, window, xproto.CwEventMask, []uint32{xproto.EventMaskPropertyChange}).Check() != nil {
			return false
		}
		t := &selectionTransfer{target: typ, data: value}
		t.timer = time.AfterFunc(15*time.Second, func() {
			c.mu.Lock()
			if c.sending[key] == t {
				delete(c.sending, key)
			}
			c.mu.Unlock()
		})
		c.sending[key] = t
		return xproto.ChangePropertyChecked(c.x, xproto.PropModeReplace, window, property, c.atoms["INCR"], 32, 1, append32(nil, uint32(len(value)))).Check() == nil
	}
	return xproto.ChangePropertyChecked(c.x, xproto.PropModeReplace, window, property, typ, format, uint32(len(value)*8/int(format)), value).Check() == nil
}
func append32(b []byte, v uint32) []byte {
	n := len(b)
	b = append(b, 0, 0, 0, 0)
	xgb.Put32(b[n:], v)
	return b
}

func validateClipboard(data ClipboardData) error {
	count := 0
	if data.PNG != nil {
		count++
		cfg, err := png.DecodeConfig(bytes.NewReader(data.PNG))
		if err != nil || len(data.PNG) > MaxClipboardBytes || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxClipboardPixels {
			return i18n.New("backend.desktop.clipboardPNGSizeLimit", i18n.Vars{"maxMiB": float64(MaxClipboardBytes) / (1 << 20), "maxPixels": maxClipboardPixels})
		}
	}
	if data.Files != nil {
		count++
		if len(data.Files) == 0 || len(data.Files) > 1000 {
			return i18n.New("backend.desktop.invalidClipboardFileCount")
		}
		n := 0
		for _, p := range data.Files {
			n += len(p)
			if !utf8.ValidString(p) || !strings.HasPrefix(p, "/") || path.Clean(p) != p || strings.ContainsRune(p, 0) || n > maxClipboardText {
				return i18n.New("backend.desktop.invalidClipboardFilePaths")
			}
		}
	}
	if data.Text != "" {
		count++
		if len(data.Text) > maxClipboardText || !utf8.ValidString(data.Text) || strings.ContainsRune(data.Text, 0) {
			return i18n.New("backend.desktop.invalidOrOversizedClipboardText")
		}
	}
	if count > 1 {
		return i18n.New("backend.desktop.chooseOneClipboardRepresentation")
	}
	return nil
}
func (c *clipboard) formats(data ClipboardData) map[xproto.Atom][]byte {
	result := map[xproto.Atom][]byte{}
	if data.PNG != nil {
		result[c.atoms["image/png"]] = data.PNG
		return result
	}
	text := data.Text
	if data.Files != nil {
		uris := make([]string, len(data.Files))
		for i, p := range data.Files {
			uris[i] = (&url.URL{Scheme: "file", Path: p}).String()
		}
		result[c.atoms["text/uri-list"]] = []byte(strings.Join(uris, "\r\n") + "\r\n")
		result[c.atoms["x-special/gnome-copied-files"]] = []byte("copy\n" + strings.Join(uris, "\n"))
		text = strings.Join(data.Files, "\n")
	}
	for _, name := range []string{"UTF8_STRING", "TEXT", "text/plain", "text/plain;charset=utf-8"} {
		result[c.atoms[name]] = []byte(text)
	}
	return result
}
func (d *Display) SetClipboard(data ClipboardData) error {
	if err := validateClipboard(data); err != nil {
		return err
	}
	c, err := d.clipboard()
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	select {
	case <-c.done:
		return i18n.New("backend.desktop.displayUnavailable")
	default:
	}
	c.data = c.formats(data)
	return xproto.SetSelectionOwnerChecked(c.x, c.window, c.atoms["CLIPBOARD"], xproto.TimeCurrentTime).Check()
}

func (d *Display) ReadClipboard(ctx context.Context, version uint64) (ClipboardData, error) {
	c, err := d.clipboard()
	if err != nil {
		return ClipboardData{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	select {
	case c.readGate <- struct{}{}:
		defer func() { <-c.readGate }()
	default:
		return ClipboardData{}, i18n.New("backend.desktop.clipboardReadAlreadyInProgress")
	}
	c.mu.Lock()
	change, stamp := c.change, c.stamp
	c.mu.Unlock()
	if change.Version != version {
		return ClipboardData{}, i18n.New("backend.desktop.clipboardChanged")
	}
	read := func(name string) ([]byte, error) { return c.read(ctx, c.atoms[name], stamp) }
	targets, err := read("TARGETS")
	if err != nil {
		return ClipboardData{}, err
	}
	has := map[xproto.Atom]bool{}
	for i := 0; i+4 <= len(targets); i += 4 {
		has[xproto.Atom(xgb.Get32(targets[i:]))] = true
	}
	var result ClipboardData
	for _, name := range []string{"x-special/gnome-copied-files", "text/uri-list", "image/png", "UTF8_STRING", "text/plain;charset=utf-8", "text/plain", "TEXT", "STRING"} {
		if !has[c.atoms[name]] {
			continue
		}
		value, e := read(name)
		if e != nil {
			return result, e
		}
		switch name {
		case "x-special/gnome-copied-files", "text/uri-list":
			if len(value) > maxClipboardText {
				return result, i18n.New("backend.desktop.clipboardFileListIsTooLarge")
			}
			result.Files, e = clipboardPaths(string(value))
			if e != nil {
				// URI lists also represent copied web links; try their image/text
				// representations without treating URLs as filesystem access.
				if name == "text/uri-list" {
					continue
				}
				return result, e
			}
		case "image/png":
			result.PNG = value
		default:
			if name == "STRING" {
				runes := make([]rune, len(value))
				for i, b := range value {
					runes[i] = rune(b)
				}
				result.Text = string(runes)
			} else {
				result.Text = string(value)
			}
		}
		if err = validateClipboard(result); err != nil {
			return ClipboardData{}, err
		}
		c.mu.Lock()
		same := c.change.Version == version
		c.mu.Unlock()
		if !same {
			return ClipboardData{}, i18n.New("backend.desktop.clipboardChanged")
		}
		return result, nil
	}
	return result, i18n.New("backend.desktop.theApplicationCopiedAnUnsupportedClipboardFormat")
}
func clipboardPaths(value string) ([]string, error) {
	var paths []string
	for _, line := range strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n") {
		if line == "" || line == "copy" || line == "cut" || strings.HasPrefix(line, "#") {
			continue
		}
		u, err := url.Parse(line)
		if err != nil || u.Scheme != "file" || (u.Host != "" && u.Host != "localhost") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return nil, i18n.New("backend.desktop.clipboardContainsANonLocalFileReference")
		}
		paths = append(paths, u.Path)
	}
	if len(paths) == 0 {
		return nil, i18n.New("backend.desktop.clipboardContainsNoFiles")
	}
	return paths, validateClipboard(ClipboardData{Files: paths})
}

func (c *clipboard) read(ctx context.Context, target xproto.Atom, stamp xproto.Timestamp) ([]byte, error) {
	window, err := c.newWindow()
	if err != nil {
		return nil, err
	}
	ch := make(chan xgb.Event, 8)
	c.mu.Lock()
	c.requests[window] = ch
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.requests, window); c.mu.Unlock(); xproto.DestroyWindow(c.x, window) }()
	property := c.atoms["_TUXEE_SELECTION"]
	if err = xproto.ConvertSelectionChecked(c.x, window, c.atoms["CLIPBOARD"], target, property, stamp).Check(); err != nil {
		return nil, err
	}
	incr := false
	var value []byte
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-c.done:
			return nil, i18n.New("backend.desktop.displayEnded")
		case event := <-ch:
			switch e := event.(type) {
			case xproto.SelectionNotifyEvent:
				if e.Property == 0 {
					return nil, i18n.New("backend.desktop.applicationRefusedClipboardData")
				}
			case xproto.PropertyNotifyEvent:
				if !incr || e.State != xproto.PropertyNewValue || e.Atom != property {
					continue
				}
			default:
				continue
			}
			p, e := xproto.GetProperty(c.x, true, window, property, xproto.GetPropertyTypeAny, 0, MaxClipboardBytes/4+1).Reply()
			if e != nil {
				return nil, e
			}
			if p.BytesAfter != 0 || len(value)+len(p.Value) > MaxClipboardBytes {
				return nil, i18n.New("backend.desktop.clipboardByteLimit", i18n.Vars{"maxMiB": float64(MaxClipboardBytes) / (1 << 20)})
			}
			if p.Type == c.atoms["INCR"] {
				if incr || p.Format != 32 || len(p.Value) != 4 || xgb.Get32(p.Value) > MaxClipboardBytes {
					return nil, i18n.New("backend.desktop.invalidIncrementalClipboard")
				}
				incr = true
				continue
			}
			if p.Type == 0 {
				continue
			}
			if target == c.atoms["TARGETS"] {
				if p.Format != 32 || len(p.Value) > 4096 {
					return nil, i18n.New("backend.desktop.invalidClipboardTargets")
				}
			} else if p.Format != 8 {
				return nil, i18n.New("backend.desktop.invalidClipboardDataFormat", i18n.Vars{"format": p.Format})
			}
			value = append(value, p.Value...)
			if !incr || len(p.Value) == 0 {
				return value, nil
			}
		}
	}
}
