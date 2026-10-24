package desktop

import (
	"context"
	"errors"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
)

type FileDrop struct {
	Files  []string `json:"files"`
	Window uint32   `json:"window"`
	X      int16    `json:"x"`
	Y      int16    `json:"y"`
}

// Offer a copy through XDND. The receiving application owns open/import/paste
// semantics; neither a failed nor a successful drop deletes source files.
func (d *Display) DropFiles(ctx context.Context, drop FileDrop) error {
	if err := validateClipboard(ClipboardData{Files: drop.Files}); err != nil {
		return err
	}
	w, err := d.window(drop.Window)
	if err != nil {
		return err
	}
	c := w.clipboard
	select {
	case c.dropGate <- struct{}{}:
		defer func() { <-c.dropGate }()
	default:
		return errors.New("a file drop is already in progress")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	geometry, err := xproto.GetGeometry(c.x, xproto.Drawable(c.root)).Reply()
	if err != nil {
		return err
	}
	if drop.X < 0 || drop.Y < 0 || uint16(drop.X) >= geometry.Width || uint16(drop.Y) >= geometry.Height {
		return errors.New("drop is outside the display")
	}
	target := xproto.Window(drop.Window)
	// Descend through the point's children, retaining the innermost XDND target.
	var aware xproto.Window
	var version uint32
	for depth := 0; depth < 32 && target != 0; depth++ {
		p, e := xproto.GetProperty(c.x, false, target, c.atoms["XdndAware"], xproto.AtomAtom, 0, 1).Reply()
		if e == nil && p.Format == 32 && len(p.Value) == 4 {
			aware = target
			version = min(xgb.Get32(p.Value), 5)
		}
		pos, e := xproto.TranslateCoordinates(c.x, c.root, target, drop.X, drop.Y).Reply()
		if e != nil {
			return e
		}
		target = pos.Child
	}
	if aware == 0 || version < 3 {
		return errors.New("this application does not accept file drops")
	}
	destination := aware
	// Proxies must point back to themselves, as required by XDND.
	if p, e := xproto.GetProperty(c.x, false, aware, c.atoms["XdndProxy"], xproto.AtomWindow, 0, 1).Reply(); e == nil && len(p.Value) == 4 {
		proxy := xproto.Window(xgb.Get32(p.Value))
		if q, e := xproto.GetProperty(c.x, false, proxy, c.atoms["XdndProxy"], xproto.AtomWindow, 0, 1).Reply(); e == nil && len(q.Value) == 4 && xproto.Window(xgb.Get32(q.Value)) == proxy {
			destination = proxy
		}
	}
	events := make(chan xproto.ClientMessageEvent, 8)
	c.mu.Lock()
	c.dropData = c.formats(ClipboardData{Files: drop.Files})
	c.dropEvents = events
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.dropData = nil
		c.dropEvents = nil
		c.mu.Unlock()
		xproto.SetSelectionOwner(c.x, 0, c.atoms["XdndSelection"], xproto.TimeCurrentTime)
	}()
	if err = xproto.SetSelectionOwnerChecked(c.x, c.window, c.atoms["XdndSelection"], xproto.TimeCurrentTime).Check(); err != nil {
		return err
	}
	send := func(name string, fields ...uint32) error {
		values := make([]uint32, 5)
		values[0] = uint32(c.window)
		copy(values[1:], fields)
		event := xproto.ClientMessageEvent{Format: 32, Window: aware, Type: c.atoms[name], Data: xproto.ClientMessageDataUnionData32New(values)}
		return xproto.SendEventChecked(c.x, false, destination, 0, string(event.Bytes())).Check()
	}
	finished := false
	defer func() {
		if !finished {
			_ = send("XdndLeave")
		}
	}()
	if err = send("XdndEnter", version<<24, uint32(c.atoms["text/uri-list"]), uint32(c.atoms["UTF8_STRING"]), uint32(c.atoms["text/plain"])); err != nil {
		return err
	}
	if err = send("XdndPosition", 0, uint32(uint16(drop.X))<<16|uint32(uint16(drop.Y)), xproto.TimeCurrentTime, uint32(c.atoms["XdndActionCopy"])); err != nil {
		return err
	}
	dropped := false
	for {
		select {
		case <-ctx.Done():
			return errors.New("application did not finish the file drop")
		case <-c.done:
			return errors.New("display ended")
		case event := <-events:
			values := event.Data.Data32
			if event.Format != 32 || xproto.Window(values[0]) != aware {
				continue
			}
			if event.Type == c.atoms["XdndStatus"] && !dropped {
				if values[1]&1 == 0 || values[4] != uint32(c.atoms["XdndActionCopy"]) {
					return errors.New("this application does not accept these files here")
				}
				if err = send("XdndDrop", 0, xproto.TimeCurrentTime); err != nil {
					return err
				}
				dropped = true
			} else if event.Type == c.atoms["XdndFinished"] && dropped {
				finished = true
				if version >= 5 && values[1]&1 == 0 {
					return errors.New("application rejected the file drop")
				}
				return nil
			}
		}
	}
}
