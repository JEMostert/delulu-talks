#!/usr/bin/python3
"""Click-through Wayland dictation pill driven by newline-delimited JSON on stdin.

A tiny Deep Sea pill: a pearl and a few wave bars that follow your voice. Text
appears only when something needs a word (done, too short, an error).
"""

from __future__ import annotations

import json
import math
import sys
import threading
import time

import cairo
import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Gtk4LayerShell", "1.0")

from gi.repository import Gdk, Gio, GLib, Gtk, Gtk4LayerShell  # noqa: E402

STATES = {"listening", "transcribing", "magic", "delivering", "success", "error"}
PREVIEW_STATES = ("listening", "transcribing", "magic", "delivering", "success", "error")
BARS = 9
HEIGHT = 40
# Deep Sea palette (see src/styles/tokens.css).
SHELL = (0.024, 0.098, 0.169, 0.95)
RIM = (0.745, 0.91, 1.0, 0.22)
INK = (0.918, 0.965, 1.0)
CORAL = (1.0, 0.435, 0.525)
FOAM = (0.459, 0.894, 1.0)
SEAGLASS = (0.373, 0.863, 0.749)
AMBER = (0.965, 0.788, 0.475)
LAVENDER = (0.76, 0.68, 0.86)


def rounded(cr: cairo.Context, x: float, y: float, w: float, h: float, r: float) -> None:
    r = min(r, w / 2, h / 2)
    cr.new_sub_path()
    cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    cr.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    cr.close_path()


class PillApplication(Gtk.Application):
    def __init__(self, preview: str | None = None, preview_reduce_motion: bool = False) -> None:
        super().__init__(application_id="com.joran.delulu_talks.pill", flags=Gio.ApplicationFlags.NON_UNIQUE)
        self.preview = preview
        self.force_reduced_motion = bool(preview and preview_reduce_motion)
        self.reduce_motion = False
        self.state = "hidden"
        self.label = ""
        self.paused = False
        self.level = 0.0
        self.shown_level = 0.0
        self.phase = 0.0
        self.started = time.monotonic()
        self.window: Gtk.ApplicationWindow | None = None
        self.area: Gtk.DrawingArea | None = None
        self.animation_settings: Gtk.Settings | None = None
        self.animation_listener: int | None = None
        self.tick: int | None = None
        self.hide_timer: int | None = None

    # Lifecycle -------------------------------------------------------------
    def do_activate(self) -> None:
        layer_shell = Gtk4LayerShell.is_supported()
        if not layer_shell and not self.preview:
            print(json.dumps({"type": "error", "message": "layer-shell is unsupported"}), flush=True)
            raise SystemExit(1)
        window = Gtk.ApplicationWindow(application=self)
        window.set_decorated(False)
        window.set_resizable(False)
        window.set_title("delulu-talks-pill")
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
        provider.load_from_data(b"window, window.background { background: transparent; }")
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )
        area = Gtk.DrawingArea()
        area.set_draw_func(self._draw)
        window.set_child(area)
        window.connect("realize", self._make_click_through)
        self.window = window
        self.area = area
        self._resize()
        self.animation_settings = Gtk.Settings.get_default()
        if self.animation_settings is not None:
            self.animation_listener = self.animation_settings.connect(
                "notify::gtk-enable-animations", lambda *_args: self._sync_motion_preference()
            )
        self._sync_motion_preference()
        if self.preview:
            self._set_state({"state": self.preview, "level": 0.62,
                             "title": {"error": "Too short", "success": "Typed"}.get(self.preview)})
            GLib.timeout_add(320, self._export_preview)
        else:
            self._set_state({"state": "hidden"})
            print(json.dumps({"type": "ready"}), flush=True)
            threading.Thread(target=self._read_commands, daemon=True).start()

    def do_shutdown(self) -> None:
        self._clear_hide_timer()
        self._stop_tick()
        if self.animation_settings is not None and self.animation_listener is not None:
            self.animation_settings.disconnect(self.animation_listener)
            self.animation_listener = None
        Gtk.Application.do_shutdown(self)

    def _sync_motion_preference(self) -> None:
        enabled = self.animation_settings.get_property("gtk-enable-animations") if self.animation_settings else True
        self.reduce_motion = self.force_reduced_motion or not enabled
        self._sync_tick()

    def _make_click_through(self, window: Gtk.Window) -> None:
        surface = window.get_surface()
        if surface is not None:
            surface.set_input_region(cairo.Region())

    def _read_commands(self) -> None:
        try:
            for line in sys.stdin:
                try:
                    GLib.idle_add(self._set_state, json.loads(line))
                except (json.JSONDecodeError, TypeError):
                    continue
        finally:
            GLib.idle_add(self.quit)

    # State -----------------------------------------------------------------
    def _set_state(self, payload: object) -> bool:
        if not isinstance(payload, dict) or self.window is None:
            return GLib.SOURCE_REMOVE
        state = str(payload.get("state", "hidden"))
        self._clear_hide_timer()
        if state == "hidden" or state not in STATES:
            self.state = "hidden"
            self._sync_tick()
            self.window.set_visible(False)
            return GLib.SOURCE_REMOVE
        if "level" in payload:
            try:
                self.level = max(0.0, min(1.0, float(payload.get("level"))))
            except (TypeError, ValueError):
                pass
        if state != self.state:
            self.started = time.monotonic()
            if state != "listening":
                self.level = 0.0
        self.state = state
        title = payload.get("title")
        self.paused = state == "listening" and str(title or "").lower() == "paused"
        # Words only where they help: results and problems, never while talking.
        self.label = (
            str(title)[:28] if title and state in {"success", "error"}
            else ("Paused" if self.paused else "")
        )
        self._resize()
        self._sync_tick()
        if not self.window.get_visible():
            self.window.present()
        self._make_click_through(self.window)
        if self.area is not None:
            self.area.queue_draw()
        if state in {"success", "error"}:
            self.hide_timer = GLib.timeout_add(1300 if state == "success" else 2600, self._auto_hide)
        return GLib.SOURCE_REMOVE

    def _label_width(self) -> int:
        if not self.label:
            return 0
        surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, 1, 1)
        cr = cairo.Context(surface)
        cr.select_font_face("Inter", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(12.5)
        return int(cr.text_extents(self.label).x_advance) + 12

    def _resize(self) -> None:
        if self.window is None or self.area is None:
            return
        show_bars = self.state in {"listening", "transcribing", "magic", "delivering"} and not self.paused
        width = 8 + 28 + (BARS * 6 + 10 if show_bars else 0) + self._label_width() + 8
        width = max(width, 52)
        self.area.set_content_width(width)
        self.area.set_content_height(HEIGHT)
        self.window.set_default_size(width, HEIGHT)

    def _auto_hide(self) -> bool:
        self.hide_timer = None
        self.state = "hidden"
        self._sync_tick()
        if self.window is not None:
            self.window.set_visible(False)
        return GLib.SOURCE_REMOVE

    def _clear_hide_timer(self) -> None:
        if self.hide_timer is not None:
            GLib.source_remove(self.hide_timer)
            self.hide_timer = None

    # Animation ---------------------------------------------------------------
    def _sync_tick(self) -> None:
        animate = self.state in {"listening", "transcribing", "magic", "delivering"} and not self.reduce_motion
        if animate and self.tick is None and self.area is not None:
            self.tick = self.area.add_tick_callback(self._on_tick)
        elif not animate:
            self._stop_tick()

    def _stop_tick(self) -> None:
        if self.tick is not None and self.area is not None:
            self.area.remove_tick_callback(self.tick)
        self.tick = None

    def _on_tick(self, area: Gtk.Widget, _clock: object) -> bool:
        self.phase = time.monotonic() - self.started
        # Rise quickly with the voice, fall back gently like water.
        rate = 0.45 if self.level > self.shown_level else 0.12
        self.shown_level += (self.level - self.shown_level) * rate
        area.queue_draw()
        return GLib.SOURCE_CONTINUE

    # Drawing -----------------------------------------------------------------
    def _accent(self) -> tuple[float, float, float]:
        if self.state == "listening":
            return LAVENDER if self.paused else CORAL
        if self.state == "success":
            return SEAGLASS
        if self.state == "error":
            return AMBER
        return FOAM

    def _draw(self, _area: Gtk.DrawingArea, cr: cairo.Context, width: int, height: int) -> None:
        cr.set_operator(cairo.OPERATOR_SOURCE)
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        cr.set_operator(cairo.OPERATOR_OVER)
        accent = self._accent()
        # Shell: smoked navy glass with a cool rim and a soft accent glow.
        rounded(cr, 0.5, 0.5, width - 1, height - 1, height / 2)
        cr.set_source_rgba(*SHELL)
        cr.fill_preserve()
        cr.set_source_rgba(*RIM)
        cr.set_line_width(1)
        cr.stroke()
        top = cairo.LinearGradient(0, 0, 0, height / 2)
        top.add_color_stop_rgba(0, 1, 1, 1, 0.08)
        top.add_color_stop_rgba(1, 1, 1, 1, 0)
        rounded(cr, 1.5, 1.5, width - 3, height / 2, height / 2 - 1)
        cr.set_source(top)
        cr.fill()
        self._draw_pearl(cr, 22, height / 2, accent)
        x = 44
        if self.state in {"listening", "transcribing", "magic", "delivering"} and not self.paused:
            self._draw_bars(cr, x, height / 2, accent)
            x += BARS * 6 + 10
        if self.label:
            cr.select_font_face("Inter", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            cr.set_font_size(12.5)
            extents = cr.text_extents(self.label)
            cr.set_source_rgb(*INK)
            cr.move_to(x - 2, height / 2 - extents.y_bearing - extents.height / 2)
            cr.show_text(self.label)

    def _draw_pearl(self, cr: cairo.Context, cx: float, cy: float, accent: tuple[float, float, float]) -> None:
        radius = 11.0
        if self.state == "listening" and not self.paused:
            # A halo that breathes with the voice.
            halo = radius + 2 + 5 * self.shown_level
            glow = cairo.RadialGradient(cx, cy, radius, cx, cy, halo + 3)
            glow.add_color_stop_rgba(0, *accent, 0.55)
            glow.add_color_stop_rgba(1, *accent, 0)
            cr.arc(cx, cy, halo + 3, 0, 2 * math.pi)
            cr.set_source(glow)
            cr.fill()
        elif self.state in {"transcribing", "magic", "delivering"} and not self.reduce_motion:
            pulse = 0.5 + 0.5 * math.sin(self.phase * 3.2)
            glow = cairo.RadialGradient(cx, cy, radius, cx, cy, radius + 6)
            glow.add_color_stop_rgba(0, *accent, 0.25 + 0.3 * pulse)
            glow.add_color_stop_rgba(1, *accent, 0)
            cr.arc(cx, cy, radius + 6, 0, 2 * math.pi)
            cr.set_source(glow)
            cr.fill()
        # Mother-of-pearl body: warm white core, cool rim, a tint of the state.
        body = cairo.RadialGradient(cx - 3.5, cy - 4, 1, cx, cy, radius)
        body.add_color_stop_rgb(0, 1, 1, 1)
        body.add_color_stop_rgb(0.45, 0.95, 0.93, 0.91)
        body.add_color_stop_rgb(1, 0.77, 0.81, 0.86)
        cr.arc(cx, cy, radius, 0, 2 * math.pi)
        cr.set_source(body)
        cr.fill()
        tint = cairo.RadialGradient(cx, cy + 5, 1, cx, cy + 2, radius + 1)
        tint.add_color_stop_rgba(0, *accent, 0.55 if self.state == "listening" else 0.35)
        tint.add_color_stop_rgba(1, *accent, 0)
        cr.arc(cx, cy, radius, 0, 2 * math.pi)
        cr.set_source(tint)
        cr.fill()
        # Iridescent sheen and a crisp highlight.
        sheen = cairo.LinearGradient(cx - radius, cy - radius, cx + radius, cy + radius)
        sheen.add_color_stop_rgba(0, 1.0, 0.66, 0.78, 0.22)
        sheen.add_color_stop_rgba(0.5, 0.62, 0.88, 1.0, 0.18)
        sheen.add_color_stop_rgba(1, 0.74, 0.66, 1.0, 0.2)
        cr.arc(cx, cy, radius, 0, 2 * math.pi)
        cr.set_source(sheen)
        cr.fill()
        cr.arc(cx - 3.8, cy - 4.2, 2.6, 0, 2 * math.pi)
        cr.set_source_rgba(1, 1, 1, 0.95)
        cr.fill()
        cr.arc(cx, cy, radius, 0, 2 * math.pi)
        cr.set_source_rgba(1, 1, 1, 0.55)
        cr.set_line_width(0.8)
        cr.stroke()
        if self.state == "success":
            cr.set_source_rgb(0.03, 0.32, 0.27)
            cr.set_line_width(2.2)
            cr.set_line_cap(cairo.LINE_CAP_ROUND)
            cr.set_line_join(cairo.LINE_JOIN_ROUND)
            cr.move_to(cx - 4.5, cy + 0.5)
            cr.line_to(cx - 1.2, cy + 3.8)
            cr.line_to(cx + 4.8, cy - 3.2)
            cr.stroke()
        glyph = {"error": "!"}.get(self.state)
        if glyph:
            cr.select_font_face("Inter", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            cr.set_font_size(12)
            extents = cr.text_extents(glyph)
            cr.set_source_rgb(0.03, 0.15, 0.25)
            cr.move_to(cx - extents.width / 2 - extents.x_bearing, cy - extents.y_bearing - extents.height / 2)
            cr.show_text(glyph)

    def _draw_bars(self, cr: cairo.Context, x: float, cy: float, accent: tuple[float, float, float]) -> None:
        listening = self.state == "listening"
        for index in range(BARS):
            # A travelling wave; while listening its swell follows the voice.
            envelope = math.sin(math.pi * (index + 0.5) / BARS) ** 0.8
            wave = 0.5 + 0.5 * math.sin(self.phase * (5.0 if listening else 3.0) - index * 0.75)
            if listening:
                amount = 0.12 + envelope * (0.25 + 0.75 * self.shown_level) * (0.55 + 0.45 * wave)
            else:
                amount = 0.15 + 0.35 * envelope * wave
            if self.reduce_motion:
                amount = 0.15 + 0.5 * envelope * (self.shown_level if listening else 0.4)
            bar = max(3.0, min(22.0, 22.0 * amount))
            left = x + index * 6
            gradient = cairo.LinearGradient(0, cy - bar / 2, 0, cy + bar / 2)
            gradient.add_color_stop_rgba(0, *accent, 0.95)
            gradient.add_color_stop_rgba(1, *FOAM, 0.75 if listening else 0.95)
            rounded(cr, left, cy - bar / 2, 3, bar, 1.5)
            cr.set_source(gradient)
            cr.fill()

    def _export_preview(self) -> bool:
        try:
            if self.area is None:
                return GLib.SOURCE_REMOVE
            width = self.area.get_content_width()
            surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, width * 2, HEIGHT * 2)
            cr = cairo.Context(surface)
            cr.scale(2, 2)
            self.phase = 0.9
            self.shown_level = 0.62
            self._draw(self.area, cr, width, HEIGHT)
            suffix = "-reduced-motion" if self.reduce_motion else ""
            path = f"/tmp/delulu-pill-{self.preview}{suffix}.png"
            surface.write_to_png(path)
            print(json.dumps({"type": "export", "path": path, "width": width, "height": HEIGHT}), flush=True)
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
    raise SystemExit(PillApplication(preview_state(), "--reduced-motion" in sys.argv).run([sys.argv[0]]))
