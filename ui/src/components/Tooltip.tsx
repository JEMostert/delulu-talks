import { useEffect, useState } from "react";

type Tip = { text: string; x: number; y: number; below: boolean };

const GAP = 6;

/** The nearest element with a tooltip, from an event target. */
const tipOf = (target: EventTarget | null) =>
  target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;

/** A control's tooltip kept in a hidden `.tip-text` element it is described by. */
function describedTip(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return;
  for (const id of (target.getAttribute("aria-describedby") ?? "").split(" ")) {
    const el = id ? document.getElementById(id) : null;
    if (el?.classList.contains("tip-text")) return el.textContent ?? undefined;
  }
}

/**
 * Shows `data-tip` text next to the element under the pointer or with
 * keyboard focus, and on focus a control's `.tip-text` description. One layer for the window, fixed to the viewport, so a
 * scrolling list never clips a tip. Screen readers get the same text from the
 * element itself (`aria-label` or `aria-describedby`); the layer is hidden
 * from them.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip>();
  useEffect(() => {
    let anchor: Element | null = null;
    const show = (el: Element, text = (el as HTMLElement).dataset.tip) => {
      if (!text) return;
      anchor = el;
      const box = el.getBoundingClientRect();
      // Below unless the element sits in the bottom quarter of the window.
      const below = box.bottom < window.innerHeight * 0.75;
      setTip({
        text,
        x: box.left + box.width / 2,
        y: below ? box.bottom + GAP : box.top - GAP,
        below,
      });
    };
    const hide = () => {
      anchor = null;
      setTip(undefined);
    };
    const over = (e: PointerEvent) => {
      const el = tipOf(e.target);
      if (el && el !== anchor) show(el);
      else if (!el && anchor) hide();
    };
    const focus = (e: FocusEvent) => {
      const target = e.target as Element;
      if (!target.matches?.(":focus-visible")) return;
      const el = tipOf(target);
      const described = el ? undefined : describedTip(target);
      if (el) show(el);
      else if (described) show(target, described);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("pointerover", over);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", hide);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", hide);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);
  if (!tip) return null;
  return (
    <div
      className={`tooltip ${tip.below ? "below" : "above"}`}
      aria-hidden="true"
      style={{ left: tip.x, top: tip.y }}
      ref={(el) => {
        // Keep the tip inside the window horizontally.
        if (!el) return;
        el.style.marginLeft = "";
        const box = el.getBoundingClientRect();
        const shift =
          box.left < 8
            ? 8 - box.left
            : box.right > window.innerWidth - 8
              ? window.innerWidth - 8 - box.right
              : 0;
        el.style.marginLeft = shift ? `${shift}px` : "";
      }}
    >
      {tip.text}
    </div>
  );
}
