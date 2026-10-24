"""A real GTK text field for the GUI clipboard integration checks."""
import json
import os
import sys
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib

window = Gtk.Window(title="GUI clipboard proof")
window.connect("destroy", Gtk.main_quit)
entry = Gtk.Entry()
entry.set_text("initial")
window.add(entry)


def save(*_):
    with open(sys.argv[1], "w") as output:
        json.dump(dict(text=entry.get_text(), selection=entry.get_selection_bounds(), display=os.environ["DISPLAY"],
                       auth=os.environ["XAUTHORITY"]), output)


entry.connect("changed", save)
entry.connect("notify::selection-bound", save)
entry.connect("notify::cursor-position", save)


def copy(widget):
    if os.path.exists(sys.argv[1] + ".delay"):
        widget.stop_emission_by_name("copy-clipboard")
        start, end = widget.get_selection_bounds()
        text = widget.get_text()[start:end]
        GLib.timeout_add(500, lambda: Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(text, -1))


entry.connect("copy-clipboard", copy)
window.show_all()
entry.grab_focus()
save()
Gtk.main()
