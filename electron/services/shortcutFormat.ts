export function portalTrigger(accelerator: string): string {
  const parts = accelerator.split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts.pop() ?? "space";
  const modifiers = parts.flatMap((part) => {
    const normalized = part.toLowerCase();
    if (["ctrl", "control", "commandorcontrol"].includes(normalized)) return ["CTRL"];
    if (normalized === "shift") return ["SHIFT"];
    if (["alt", "option"].includes(normalized)) return ["ALT"];
    if (["super", "meta", "command"].includes(normalized)) return ["LOGO"];
    return [];
  });
  const keys: Record<string, string> = {
    space: "space",
    enter: "Return",
    return: "Return",
    escape: "Escape",
    esc: "Escape",
    tab: "Tab",
  };
  return [...modifiers, keys[key.toLowerCase()] ?? key.toLowerCase()].join("+");
}
