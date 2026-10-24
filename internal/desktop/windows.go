package desktop

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"reflect"
	"strings"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
)

type Window struct {
	ID     uint32 `json:"id"`
	Title  string `json:"title"`
	Icon   string `json:"icon,omitempty"`
	Active bool   `json:"active"`
}

type windowManager struct {
	x         *xgb.Conn
	d         *Display
	root      xproto.Window
	atoms     map[string]xproto.Atom
	clipboard *clipboard
}

func newWindowManager(x *xgb.Conn, d *Display) (*windowManager, error) {
	w := &windowManager{x: x, d: d, root: xproto.Setup(x).DefaultScreen(x).Root, atoms: map[string]xproto.Atom{}}
	for _, name := range []string{"_NET_CLIENT_LIST", "_NET_ACTIVE_WINDOW", "_NET_CLOSE_WINDOW", "_NET_WM_NAME", "WM_NAME", "_NET_WM_ICON", "WM_TRANSIENT_FOR"} {
		a, err := xproto.InternAtom(x, false, uint16(len(name)), name).Reply()
		if err != nil {
			return nil, err
		}
		w.atoms[name] = a.Atom
	}
	err := xproto.ChangeWindowAttributesChecked(x, w.root, xproto.CwEventMask, []uint32{xproto.EventMaskPropertyChange}).Check()
	if err == nil {
		w.clipboard, err = newClipboard(x)
	}
	return w, err
}

func (w *windowManager) property(window xproto.Window, name string, length uint32) []byte {
	p, err := xproto.GetProperty(w.x, false, window, w.atoms[name], xproto.GetPropertyTypeAny, 0, length).Reply()
	if err != nil || p == nil {
		return nil
	}
	return p.Value
}

func (w *windowManager) refresh() {
	list := w.property(w.root, "_NET_CLIENT_LIST", 128)
	active := w.property(w.root, "_NET_ACTIVE_WINDOW", 1)
	var current uint32
	if len(active) == 4 {
		current = xgb.Get32(active)
	}
	windows := make([]Window, 0, len(list)/4)
	for len(list) >= 4 {
		id := xgb.Get32(list)
		list = list[4:]
		window := xproto.Window(id)
		if err := xproto.ChangeWindowAttributesChecked(w.x, window, xproto.CwEventMask, []uint32{xproto.EventMaskPropertyChange}).Check(); err != nil {
			continue
		}
		title := w.property(window, "_NET_WM_NAME", 256)
		if len(title) == 0 {
			title = w.property(window, "WM_NAME", 256)
		}
		icon := windowIcon(w.property(window, "_NET_WM_ICON", 256*256+2))
		if icon == "" {
			parent := w.property(window, "WM_TRANSIENT_FOR", 1)
			if len(parent) == 4 {
				icon = windowIcon(w.property(xproto.Window(xgb.Get32(parent)), "_NET_WM_ICON", 256*256+2))
			}
		}
		windows = append(windows, Window{ID: id, Title: strings.ToValidUTF8(strings.TrimRight(string(title), "\x00"), "�"), Icon: icon, Active: id == current})
	}
	w.d.mu.Lock()
	if w.d.windows != w {
		w.d.mu.Unlock()
		return
	}
	changed := !reflect.DeepEqual(w.d.state.Windows, windows)
	if len(windows) > 0 && w.d.idle != nil {
		w.d.idle.Stop()
		w.d.idle = nil
	} else if len(windows) == 0 && len(w.d.state.Windows) > 0 {
		// Window replacement can briefly leave the list empty.
		w.d.releaseAfterLocked(2 * time.Second)
	}
	w.d.state.Windows = windows
	w.d.mu.Unlock()
	if changed {
		w.d.changed()
	}
}

func (w *windowManager) watch() {
	defer w.clipboard.close()
	w.refresh()
	for {
		event, err := w.x.WaitForEvent()
		if event == nil && err == nil {
			return
		}
		w.clipboard.event(event)
		if p, ok := event.(xproto.PropertyNotifyEvent); ok {
			for _, a := range w.atoms {
				if p.Atom == a {
					w.refresh()
					break
				}
			}
		}
	}
}

func (w *windowManager) activate(id uint32) error {
	event := xproto.ClientMessageEvent{Format: 32, Window: xproto.Window(id), Type: w.atoms["_NET_ACTIVE_WINDOW"], Data: xproto.ClientMessageDataUnionData32New([]uint32{2, xproto.TimeCurrentTime, 0, 0, 0})}
	return xproto.SendEventChecked(w.x, false, w.root, xproto.EventMaskSubstructureRedirect|xproto.EventMaskSubstructureNotify, string(event.Bytes())).Check()
}

func (w *windowManager) closeWindow(id uint32) error {
	// Let the window manager deliver WM_DELETE_WINDOW so applications can ask to save.
	event := xproto.ClientMessageEvent{Format: 32, Window: xproto.Window(id), Type: w.atoms["_NET_CLOSE_WINDOW"], Data: xproto.ClientMessageDataUnionData32New([]uint32{xproto.TimeCurrentTime, 2, 0, 0, 0})}
	return xproto.SendEventChecked(w.x, false, w.root, xproto.EventMaskSubstructureRedirect|xproto.EventMaskSubstructureNotify, string(event.Bytes())).Check()
}

// Bound both X properties and decoded images: application-supplied dimensions are untrusted.
func windowIcon(data []byte) string {
	var best []byte
	var width, height uint32
	for len(data) >= 8 {
		x, y := xgb.Get32(data), xgb.Get32(data[4:])
		data = data[8:]
		if x == 0 || y == 0 || uint64(x)*uint64(y) > uint64(len(data)/4) {
			break
		}
		n := int(x*y) * 4
		if x <= 256 && y <= 256 && (best == nil || x >= 32 && (width < 32 || x < width)) {
			best = data[:n]
			width = x
			height = y
		}
		data = data[n:]
	}
	if best == nil {
		return ""
	}
	// Header icons need only 32 pixels, regardless of the application's source size.
	img := image.NewNRGBA(image.Rect(0, 0, 32, 32))
	for y := 0; y < 32; y++ {
		for x := 0; x < 32; x++ {
			i := (uint32(y)*height/32*width + uint32(x)*width/32) * 4
			argb := xgb.Get32(best[i:])
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(argb >> 16), G: uint8(argb >> 8), B: uint8(argb), A: uint8(argb >> 24)})
		}
	}
	var encoded bytes.Buffer
	if png.Encode(&encoded, img) != nil {
		return ""
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(encoded.Bytes())
}
