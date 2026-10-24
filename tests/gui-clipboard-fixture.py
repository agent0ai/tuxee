"""A real GTK text field for the GUI clipboard integration checks."""
import json
import os
import sys
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib, GdkPixbuf

window = Gtk.Window(title="GUI clipboard proof")
window.connect("destroy", Gtk.main_quit)
entry = Gtk.Entry()
entry.set_text("initial")
received = {}
window.add(entry)


def save(*_):
    with open(sys.argv[1], "w") as output:
        json.dump(dict(received=received, text=entry.get_text(), selection=entry.get_selection_bounds(), display=os.environ["DISPLAY"],
                       auth=os.environ["XAUTHORITY"]), output)


entry.connect("changed", save)
entry.connect("notify::selection-bound", save)
entry.connect("notify::cursor-position", save)


def copy(widget):
    if os.path.exists(sys.argv[1] + ".copy-image"):
        widget.stop_emission_by_name("copy-clipboard")
        Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_image(GdkPixbuf.Pixbuf.new_from_file(sys.argv[1] + ".png"))
        return
    if os.path.exists(sys.argv[1] + ".delay"):
        widget.stop_emission_by_name("copy-clipboard")
        start, end = widget.get_selection_bounds()
        text = widget.get_text()[start:end]
        GLib.timeout_add(500, lambda: Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(text, -1))


entry.connect("copy-clipboard", copy)


def paste(widget):
    clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    uris = clipboard.wait_for_uris()
    if uris:
        widget.stop_emission_by_name("paste-clipboard")
        received["files"] = uris
        save()
    elif clipboard.wait_is_image_available():
        widget.stop_emission_by_name("paste-clipboard")
        image = clipboard.wait_for_image()
        image.savev(sys.argv[1] + ".png", "png", [], [])
        received["image"] = [image.get_width(), image.get_height()]
        save()


def drop(widget, context, x, y, data, info, timestamp):
    widget.stop_emission_by_name("drag-data-received")
    received["drop"] = data.get_uris()
    context.finish(bool(received["drop"]), False, timestamp)
    save()


entry.connect("paste-clipboard", paste)
entry.drag_dest_set(Gtk.DestDefaults.ALL, [Gtk.TargetEntry.new("text/uri-list", 0, 0)], Gdk.DragAction.COPY)
entry.connect("drag-data-received", drop)


def key(widget, event):
    if event.keyval == Gdk.KEY_F8:
        entry.drag_dest_unset()
        received["drop_disabled"] = True
        save()
        return True
    return False


window.connect("key-press-event", key)
window.show_all()
entry.grab_focus()
save()
Gtk.main()
