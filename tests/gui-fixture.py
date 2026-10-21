"""Real GTK windows used only by the browser GUI integration test."""
import json
import os
import sys
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib, GdkPixbuf

window = Gtk.Window(title="GUI application proof")
picture = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, True, 8, 32, 32)
picture.fill(0x5599ddff)
Gtk.Window.set_default_icon(picture)
window.set_default_size(640, 480)
window.connect("destroy", Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18, margin=24)
window.add(box)
box.pack_start(Gtk.Label(label="Terminal display — real Linux application"), False, False, 0)
box.pack_start(Gtk.Label(label="Keyboard, dialogs and additional windows"), False, False, 0)
entry = Gtk.Entry(placeholder_text="Type here and press Enter")
box.pack_start(entry, False, False, 0)
result = Gtk.Label(label="Waiting for input")
controls = {"entry": entry}
entry.connect("activate", lambda widget: entered(widget))


def entered(widget):
    with open(sys.argv[1], "w") as output:
        json.dump(dict(text=widget.get_text(), uid=os.getuid(), pid=os.getpid(),
                       display=os.environ["DISPLAY"], auth=os.environ["XAUTHORITY"]), output)
    result.set_text("Input received: " + widget.get_text())


def dialog(_):
    child = Gtk.MessageDialog(transient_for=window, modal=True,
                              message_type=Gtk.MessageType.INFO,
                              buttons=Gtk.ButtonsType.OK,
                              text="Dialog inside the terminal display")
    child.set_title("GUI test dialog")
    child.format_secondary_text("The parent window remains behind this dialog.")
    child.run()
    child.destroy()
    entry.grab_focus()


def second(_, title="Second application window"):
    child = Gtk.Window(title=title)
    child.set_default_size(400, 260)
    area = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=20, margin=30)
    area.pack_start(Gtk.Label(label="Second application window"), False, False, 0)
    close = Gtk.Button(label="Close second window")
    close.connect("clicked", lambda _: child.destroy())
    area.pack_start(close, False, False, 0)
    child.add(area)
    child.show_all()


def many(_):
    for number in range(32):
        second(None, "Extra window %02d" % (number + 1))


def choose(_):
    child = Gtk.FileChooserDialog(title="Choose a file", transient_for=window,
                                  action=Gtk.FileChooserAction.OPEN)
    child.add_buttons("Cancel", Gtk.ResponseType.CANCEL, "Open", Gtk.ResponseType.OK)
    child.run()
    child.destroy()


for label, action in [("Open dialog", dialog), ("Open second window", second), ("Open file chooser", choose), ("Open many windows", many)]:
    control = Gtk.Button(label=label)
    control.connect("clicked", action)
    controls[label] = control
    box.pack_start(control, False, False, 0)
box.pack_start(result, False, False, 0)
def confirm_close(_, event):
    child = Gtk.MessageDialog(transient_for=window, modal=True,
                              message_type=Gtk.MessageType.QUESTION,
                              text="Close this application?")
    child.set_title("Confirm application close")
    child.add_buttons("Cancel", Gtk.ResponseType.CANCEL, "Close", Gtk.ResponseType.ACCEPT)
    child.set_default_response(Gtk.ResponseType.ACCEPT)
    response = child.run()
    child.destroy()
    return response != Gtk.ResponseType.ACCEPT


window.connect("delete-event", confirm_close)
window.show_all()
entry.grab_focus()


def report():
    values = {}
    for name, widget in controls.items():
        x, y = widget.translate_coordinates(window, 0, 0)
        bounds = widget.get_allocation()
        values[name] = dict(x=x + bounds.width / 2, y=y + bounds.height / 2)
    with open(sys.argv[1] + ".layout", "w") as output:
        json.dump(values, output)
    return True


GLib.timeout_add(100, report)
Gtk.main()
