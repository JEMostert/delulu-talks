#!/usr/bin/python3
"""Click-through Wayland dictation pill driven by newline-delimited JSON on stdin."""

from __future__ import annotations

import json
import sys
import threading

import cairo
import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Gtk4LayerShell", "1.0")

from gi.repository import Gdk, GLib, Gtk, Gtk4LayerShell  # noqa: E402


CSS = b"""
window { background: transparent; }
.pill {
  min-width: 208px;
  min-height: 42px;
  padding: 0 13px 0 8px;
  border: 1px solid alpha(#ffffff, .15);
  border-radius: 22px;
  color: #f8f8f4;
  background: alpha(#161713, .96);
  box-shadow: 0 8px 24px alpha(#000000, .38);
}
.signal {
  min-width: 26px;
  min-height: 26px;
  border-radius: 13px;
  color: #161713;
  background: #d8ff72;
  font-size: 13px;
  font-weight: 800;
}
.copy { margin-left: 9px; }
.title { color: #ffffff; font-size: 11px; font-weight: 700; }
.detail { margin-top: 1px; color: #aeb0a8; font-size: 9px; }
.listening .signal { color: #ffffff; background: #eb5948; }
.transcribing .signal, .magic .signal, .delivering .signal { background: #d8ff72; }
.success .signal { color: #ffffff; background: #3ca36b; }
.error .signal { color: #ffffff; background: #bd3a28; }
spinner { min-width: 14px; min-height: 14px; color: #161713; }
"""

STATES = {
    "listening": ("●", "Listening", "Release to send"),
    "transcribing": ("", "Transcribing", "Speech stays on this device"),
    "magic": ("✦", "Applying Magic", "Rewriting locally"),
    "delivering": ("↗", "Delivering", "Copying and pasting"),
    "success": ("✓", "Done", "Text delivered"),
    "error": ("!", "Could not finish", "Open Delulu Talks for details"),
}


class PillApplication(Gtk.Application):
    def __init__(self) -> None:
        super().__init__(application_id="com.joran.delulu_talks.pill")
        self.window: Gtk.ApplicationWindow | None = None
        self.container: Gtk.Box | None = None
        self.symbol: Gtk.Label | None = None
        self.spinner: Gtk.Spinner | None = None
        self.title: Gtk.Label | None = None
        self.detail: Gtk.Label | None = None
        self.hide_timer: int | None = None

    def do_activate(self) -> None:
        if not Gtk4LayerShell.is_supported():
            print(json.dumps({"type": "error", "message": "layer-shell is unsupported"}), flush=True)
            self.quit()
            return

        window = Gtk.ApplicationWindow(application=self)
        window.set_decorated(False)
        window.set_resizable(False)
        Gtk4LayerShell.init_for_window(window)
        Gtk4LayerShell.set_namespace(window, "delulu-talks-pill")
        Gtk4LayerShell.set_layer(window, Gtk4LayerShell.Layer.TOP)
        Gtk4LayerShell.set_anchor(window, Gtk4LayerShell.Edge.BOTTOM, True)
        Gtk4LayerShell.set_margin(window, Gtk4LayerShell.Edge.BOTTOM, 32)
        Gtk4LayerShell.set_exclusive_zone(window, 0)
        Gtk4LayerShell.set_keyboard_mode(window, Gtk4LayerShell.KeyboardMode.NONE)

        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )

        container = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        container.add_css_class("pill")
        signal = Gtk.Overlay()
        signal.add_css_class("signal")
        symbol = Gtk.Label(label="●")
        spinner = Gtk.Spinner()
        signal.set_child(symbol)
        signal.add_overlay(spinner)
        copy = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        copy.add_css_class("copy")
        title = Gtk.Label(xalign=0)
        title.add_css_class("title")
        detail = Gtk.Label(xalign=0)
        detail.add_css_class("detail")
        copy.append(title)
        copy.append(detail)
        container.append(signal)
        container.append(copy)
        window.set_child(container)
        window.connect("realize", self._make_click_through)

        self.window = window
        self.container = container
        self.symbol = symbol
        self.spinner = spinner
        self.title = title
        self.detail = detail
        self._set_state({"state": "hidden"})
        print(json.dumps({"type": "ready"}), flush=True)
        threading.Thread(target=self._read_commands, daemon=True).start()

    def _make_click_through(self, window: Gtk.Window) -> None:
        surface = window.get_surface()
        if surface is not None:
            surface.set_input_region(cairo.Region())

    def _read_commands(self) -> None:
        try:
            for line in sys.stdin:
                try:
                    payload = json.loads(line)
                    GLib.idle_add(self._set_state, payload)
                except (json.JSONDecodeError, TypeError):
                    continue
        finally:
            GLib.idle_add(self.quit)

    def _set_state(self, payload: object) -> bool:
        if not isinstance(payload, dict) or self.window is None:
            return GLib.SOURCE_REMOVE
        state = str(payload.get("state", "hidden"))
        if self.hide_timer is not None:
            GLib.source_remove(self.hide_timer)
            self.hide_timer = None
        if state == "hidden":
            self.window.set_visible(False)
            return GLib.SOURCE_REMOVE
        if state not in STATES:
            return GLib.SOURCE_REMOVE

        symbol, title, detail = STATES[state]
        custom_title = payload.get("title")
        custom_detail = payload.get("detail")
        self.symbol.set_label(symbol)
        self.title.set_label(str(custom_title)[:48] if custom_title else title)
        self.detail.set_label(str(custom_detail)[:72] if custom_detail else detail)
        for name in STATES:
            self.container.remove_css_class(name)
        self.container.add_css_class(state)
        if state == "transcribing":
            self.spinner.start()
            self.spinner.set_visible(True)
        else:
            self.spinner.stop()
            self.spinner.set_visible(False)
        self.window.present()
        self._make_click_through(self.window)
        if state in {"success", "error"}:
            delay = 1100 if state == "success" else 2400
            self.hide_timer = GLib.timeout_add(delay, self._auto_hide)
        return GLib.SOURCE_REMOVE

    def _auto_hide(self) -> bool:
        self.hide_timer = None
        if self.window is not None:
            self.window.set_visible(False)
        return GLib.SOURCE_REMOVE


if __name__ == "__main__":
    raise SystemExit(PillApplication().run(sys.argv))
