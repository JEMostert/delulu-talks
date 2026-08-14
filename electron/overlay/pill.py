#!/usr/bin/python3
"""Click-through Wayland dictation HUD driven by newline-delimited JSON on stdin."""

from __future__ import annotations

import json
import sys
import threading
import time

import cairo
import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Gtk4LayerShell", "1.0")

from gi.repository import Gdk, GLib, Gtk, Gtk4LayerShell, Pango  # noqa: E402


CSS = b"""
window { background: transparent; }

.hud {
  min-width: 312px;
  border: 1px solid #2a2b26;
  border-radius: 8px;
  background: alpha(#141511, .95);
  box-shadow: 0 16px 36px alpha(#000000, .46), inset 0 1px 0 alpha(#ffffff, .05);
}

.rail {
  min-width: 3px;
  min-height: 52px;
  background: #c9f542;
  border-top-left-radius: 7px;
  border-bottom-left-radius: 7px;
}
.listening .rail { background: #f45b3b; }
.transcribing .rail, .magic .rail, .delivering .rail { background: #c9f542; }
.success .rail { background: #3ca36b; }
.error .rail { background: #bd3a28; }

.body { padding: 9px 13px 9px 11px; }

.header { min-height: 16px; }
.footer { margin-top: 6px; min-height: 18px; }

.beacon {
  min-width: 16px;
  min-height: 16px;
  margin-right: 8px;
}

.dot {
  min-width: 8px;
  min-height: 8px;
  border-radius: 4px;
  background: #c9f542;
}
.listening .dot {
  background: #f45b3b;
  box-shadow: 0 0 0 0 alpha(#f45b3b, .5);
  animation: ping 1.15s ease-out infinite;
}
.success .dot { background: #3ca36b; }
.error .dot { background: #bd3a28; }

.glyph {
  color: #c9f542;
  font-size: 11px;
  font-weight: 800;
}
.success .glyph { color: #3ca36b; }
.error .glyph { color: #bd3a28; }

.title {
  color: #f3f2ec;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .8px;
}
.detail { color: #9a9c93; font-size: 10px; font-weight: 500; }
.clock {
  color: #c9f542;
  font-size: 10px;
  font-weight: 700;
  font-family: "IBM Plex Mono", "ui-monospace", monospace;
  letter-spacing: .4px;
}
.listening .clock { color: #f45b3b; }

.wave { min-height: 16px; margin-left: 10px; }
.bar {
  min-width: 2px;
  background: #c9f542;
  border-radius: 1px;
}
.listening .bar { background: #f45b3b; }
.listening .wave.idle .bar { animation: meter .62s ease-in-out infinite alternate; }
.listening .wave.idle .b0 { animation-delay: 0s; }
.listening .wave.idle .b1 { animation-delay: .05s; }
.listening .wave.idle .b2 { animation-delay: .1s; }
.listening .wave.idle .b3 { animation-delay: .03s; }
.listening .wave.idle .b4 { animation-delay: .14s; }
.listening .wave.idle .b5 { animation-delay: .07s; }
.listening .wave.idle .b6 { animation-delay: .16s; }
.listening .wave.idle .b7 { animation-delay: .09s; }
.listening .wave.idle .b8 { animation-delay: .18s; }
.listening .wave.idle .b9 { animation-delay: .12s; }
.listening .wave.idle .b10 { animation-delay: .2s; }

spinner { min-width: 12px; min-height: 12px; color: #c9f542; }

@keyframes ping {
  0% { box-shadow: 0 0 0 0 alpha(#f45b3b, .45); }
  75% { box-shadow: 0 0 0 7px alpha(#f45b3b, 0); }
  100% { box-shadow: 0 0 0 0 alpha(#f45b3b, 0); }
}
@keyframes meter {
  from { min-height: 3px; }
  to { min-height: 14px; }
}
"""

STATES = {
    "listening": ("", "LISTENING", "Release to send"),
    "transcribing": ("", "TRANSCRIBING", "On this device"),
    "magic": ("✦", "MAGIC", "Rewriting locally"),
    "delivering": ("↗", "DELIVERING", "To your cursor"),
    "success": ("✓", "DONE", "Ready"),
    "error": ("!", "COULD NOT FINISH", "Open Delulu Talks"),
}

WAVE_SHAPE = (0.22, 0.36, 0.54, 0.76, 0.92, 1.0, 0.84, 0.62, 0.44, 0.3, 0.18)
PREVIEW_STATES = ("listening", "transcribing", "magic", "delivering", "success", "error")


class PillApplication(Gtk.Application):
    def __init__(self, preview: str | None = None) -> None:
        super().__init__(application_id="com.joran.delulu_talks.pill")
        self.preview = preview
        self.window: Gtk.ApplicationWindow | None = None
        self.hud: Gtk.Box | None = None
        self.dot: Gtk.Box | None = None
        self.glyph: Gtk.Label | None = None
        self.spinner: Gtk.Spinner | None = None
        self.title: Gtk.Label | None = None
        self.detail: Gtk.Label | None = None
        self.clock: Gtk.Label | None = None
        self.wave: Gtk.Box | None = None
        self.bars: list[Gtk.Box] = []
        self.hide_timer: int | None = None
        self.clock_timer: int | None = None
        self.listen_started = 0.0
        self.live_level = False

    def do_activate(self) -> None:
        layer_shell = Gtk4LayerShell.is_supported()
        if not layer_shell and not self.preview:
            print(json.dumps({"type": "error", "message": "layer-shell is unsupported"}), flush=True)
            raise SystemExit(1)

        window = Gtk.ApplicationWindow(application=self)
        window.set_decorated(False)
        window.set_resizable(False)
        window.set_title("delulu-talks-pill")
        window.set_default_size(320, 64)
        if layer_shell:
            Gtk4LayerShell.init_for_window(window)
            Gtk4LayerShell.set_namespace(window, "delulu-talks-pill")
            layer = getattr(Gtk4LayerShell.Layer, "OVERLAY", Gtk4LayerShell.Layer.TOP)
            Gtk4LayerShell.set_layer(window, layer)
            Gtk4LayerShell.set_anchor(window, Gtk4LayerShell.Edge.BOTTOM, True)
            Gtk4LayerShell.set_margin(window, Gtk4LayerShell.Edge.BOTTOM, 28)
            Gtk4LayerShell.set_exclusive_zone(window, 0)
            Gtk4LayerShell.set_keyboard_mode(window, Gtk4LayerShell.KeyboardMode.NONE)

        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )

        hud = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        hud.add_css_class("hud")
        rail = Gtk.Box()
        rail.add_css_class("rail")
        rail.set_size_request(3, 52)
        rail.set_vexpand(True)
        rail.set_valign(Gtk.Align.FILL)

        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        body.add_css_class("body")
        body.set_hexpand(True)

        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        header.add_css_class("header")
        beacon = Gtk.Overlay()
        beacon.add_css_class("beacon")
        beacon.set_valign(Gtk.Align.CENTER)
        dot = Gtk.Box()
        dot.add_css_class("dot")
        dot.set_size_request(8, 8)
        dot.set_halign(Gtk.Align.CENTER)
        dot.set_valign(Gtk.Align.CENTER)
        glyph = Gtk.Label()
        glyph.add_css_class("glyph")
        glyph.set_halign(Gtk.Align.CENTER)
        spinner = Gtk.Spinner()
        spinner.set_halign(Gtk.Align.CENTER)
        spinner.set_valign(Gtk.Align.CENTER)
        beacon.set_child(dot)
        beacon.add_overlay(glyph)
        beacon.add_overlay(spinner)
        title = Gtk.Label(xalign=0)
        title.add_css_class("title")
        title.set_hexpand(True)
        title.set_ellipsize(Pango.EllipsizeMode.END)
        title.set_max_width_chars(22)
        clock = Gtk.Label(label="0:00", xalign=1)
        clock.add_css_class("clock")
        header.append(beacon)
        header.append(title)
        header.append(clock)

        footer = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        footer.add_css_class("footer")
        detail = Gtk.Label(xalign=0)
        detail.add_css_class("detail")
        detail.set_hexpand(True)
        detail.set_ellipsize(Pango.EllipsizeMode.END)
        detail.set_max_width_chars(24)
        wave = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=2)
        wave.add_css_class("wave")
        wave.set_valign(Gtk.Align.CENTER)
        bars: list[Gtk.Box] = []
        for index in range(11):
            bar = Gtk.Box()
            bar.add_css_class("bar")
            bar.add_css_class(f"b{index}")
            bar.set_valign(Gtk.Align.CENTER)
            bar.set_size_request(2, 4)
            wave.append(bar)
            bars.append(bar)
        footer.append(detail)
        footer.append(wave)

        body.append(header)
        body.append(footer)
        hud.append(rail)
        hud.append(body)
        window.set_child(hud)
        window.connect("realize", self._make_click_through)

        self.window = window
        self.hud = hud
        self.dot = dot
        self.glyph = glyph
        self.spinner = spinner
        self.title = title
        self.detail = detail
        self.clock = clock
        self.wave = wave
        self.bars = bars
        if self.preview:
            self._set_state({"state": self.preview, "level": 0.62})
            GLib.timeout_add(280, self._export_preview)
        else:
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

    def _clear_hide_timer(self) -> None:
        if self.hide_timer is not None:
            GLib.source_remove(self.hide_timer)
            self.hide_timer = None

    def _clear_clock_timer(self) -> None:
        if self.clock_timer is not None:
            GLib.source_remove(self.clock_timer)
            self.clock_timer = None

    def _tick_clock(self) -> bool:
        if self.clock is None or self.listen_started <= 0:
            return GLib.SOURCE_REMOVE
        elapsed = max(0, int(time.monotonic() - self.listen_started))
        self.clock.set_label(f"{elapsed // 60}:{elapsed % 60:02d}")
        return GLib.SOURCE_CONTINUE

    def _apply_level(self, level: object) -> None:
        if self.wave is None:
            return
        try:
            value = max(0.0, min(1.0, float(level)))
        except (TypeError, ValueError):
            return
        self.live_level = True
        self.wave.remove_css_class("idle")
        for index, bar in enumerate(self.bars):
            height = max(3, int(16 * WAVE_SHAPE[index] * (0.16 + 0.84 * value)))
            bar.set_size_request(2, height)

    def _set_state(self, payload: object) -> bool:
        if not isinstance(payload, dict) or self.window is None or self.hud is None:
            return GLib.SOURCE_REMOVE
        state = str(payload.get("state", "hidden"))
        self._clear_hide_timer()
        if state == "hidden":
            self._clear_clock_timer()
            self.window.set_visible(False)
            return GLib.SOURCE_REMOVE
        if state not in STATES:
            return GLib.SOURCE_REMOVE

        symbol, title, detail = STATES[state]
        custom_title = payload.get("title")
        custom_detail = payload.get("detail")
        self.glyph.set_label(symbol)
        self.title.set_label(str(custom_title)[:28].upper() if custom_title else title)
        self.detail.set_label(str(custom_detail)[:36] if custom_detail else detail)
        for name in STATES:
            self.hud.remove_css_class(name)
        self.hud.add_css_class(state)

        busy = state in {"transcribing", "magic", "delivering"}
        self.spinner.set_visible(busy)
        if busy:
            self.spinner.start()
        else:
            self.spinner.stop()
        self.dot.set_visible(not busy and not symbol)
        self.glyph.set_visible(not busy and bool(symbol))

        listening = state == "listening"
        self.clock.set_visible(listening)
        self.wave.set_visible(listening)
        if listening:
            if "level" in payload:
                self._apply_level(payload.get("level"))
            elif not self.live_level:
                self.wave.add_css_class("idle")
            if self.clock_timer is None:
                self.listen_started = time.monotonic()
                self.clock.set_label("0:00")
                self.clock_timer = GLib.timeout_add(200, self._tick_clock)
        else:
            self._clear_clock_timer()
            self.live_level = False
            self.wave.add_css_class("idle")

        if self.window.get_visible():
            self._make_click_through(self.window)
        else:
            self.window.present()
            self._make_click_through(self.window)
        if state in {"success", "error"}:
            delay = 1600 if state == "success" else 2600
            self.hide_timer = GLib.timeout_add(delay, self._auto_hide)
        return GLib.SOURCE_REMOVE

    def _auto_hide(self) -> bool:
        self.hide_timer = None
        if self.window is not None:
            self.window.set_visible(False)
        return GLib.SOURCE_REMOVE

    def _export_preview(self) -> bool:
        try:
            gi.require_version("Graphene", "1.0")
            from gi.repository import Graphene
            if self.window is None or self.hud is None:
                return GLib.SOURCE_REMOVE
            width = max(1, self.hud.get_width())
            height = max(1, self.hud.get_height())
            paintable = Gtk.WidgetPaintable.new(self.hud)
            snapshot = Gtk.Snapshot()
            paintable.snapshot(snapshot, float(width), float(height))
            node = snapshot.to_node()
            native = self.window.get_native()
            renderer = native.get_renderer() if native is not None else None
            if node is not None and renderer is not None:
                texture = renderer.render_texture(node, Graphene.Rect().init(0, 0, float(width), float(height)))
                path = f"/tmp/delulu-pill-{self.preview}.png"
                texture.save_to_png(path)
                print(json.dumps({"type": "export", "path": path, "width": width, "height": height}), flush=True)
        finally:
            self.quit()
        return GLib.SOURCE_REMOVE


def preview_state() -> str | None:
    if "--preview" not in sys.argv:
        return None
    index = sys.argv.index("--preview")
    requested = sys.argv[index + 1] if index + 1 < len(sys.argv) else "listening"
    return requested if requested in PREVIEW_STATES else "listening"


if __name__ == "__main__":
    raise SystemExit(PillApplication(preview_state()).run([sys.argv[0]]))
