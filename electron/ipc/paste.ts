import { validateText } from "./validation";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerPasteIpc(
  { handle }: IpcRegistrar,
  { paste, pill }: Pick<IpcDependencies, "paste" | "pill">,
): void {
  handle("platform:capabilities", () =>
    paste.capabilities(pill.method, pill.detail),
  );
  handle("clipboard:copy", (_event, text: unknown) =>
    paste.copy(validateText(text, 500_000)),
  );
  handle("paste:authorize", () => paste.authorize());
  handle("paste:test", async () => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
    await paste.paste("Delulu Talks paste test");
  });
}
