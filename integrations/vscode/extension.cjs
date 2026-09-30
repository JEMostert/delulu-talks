const vscode = require("vscode");
const fs = require("node:fs/promises");
const path = require("node:path");

function activate(context) {
  let previewSequence = 0;
  const previews = new Map();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("delulu-preview", {
    provideTextDocumentContent: (uri) => previews.get(uri.toString()) ?? "Preview has been discarded.",
  }));
  const register = (command, action) => context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
    try { await action(); } catch (error) { void vscode.window.showErrorMessage(`Delulu: ${error.message}`); }
  }));

  async function request(route, body) {
    const config = vscode.workspace.getConfiguration("deluluTalks");
    const connectionFile = config.get("connectionFile");
    const token = await context.secrets.get("integration-token");
    if (!connectionFile || !path.isAbsolute(connectionFile)) throw new Error("Set deluluTalks.connectionFile to the path shown in desktop Settings.");
    if (!token) throw new Error("Run Delulu: Set Scoped Integration Token with a token granted in desktop Settings.");
    const connection = JSON.parse(await fs.readFile(connectionFile, "utf8"));
    if (connection.schemaVersion !== 1 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(connection.url)) throw new Error("Invalid local connection file.");
    const response = await fetch(`${connection.url}/v1/${route}`, {
      method: body ? "POST" : "GET", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(route === "rewrite" || route === "transcribe" ? 4 * 60 * 60 * 1000 : 30_000),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
    return value;
  }

  function target(requireSelection = false) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || (requireSelection && editor.selection.isEmpty)) throw new Error("Select text in an editor first.");
    if (editor.document.uri.scheme !== "file" && editor.document.uri.scheme !== "untitled") throw new Error("Use an editable local document.");
    const selection = new vscode.Selection(editor.selection.anchor, editor.selection.active);
    return { editor, selection, uri: editor.document.uri.toString(), version: editor.document.version, source: editor.document.getText(selection) };
  }

  async function apply(snapshot, text) {
    if (typeof text !== "string") throw new Error("The model returned no replacement text.");
    const { editor, selection, uri, version, source } = snapshot;
    if (vscode.window.activeTextEditor !== editor || editor.document.isClosed || editor.document.uri.toString() !== uri || editor.document.version !== version || !editor.selection.isEqual(selection) || editor.document.getText(selection) !== source) {
      throw new Error("The document or selection changed. Original text is preserved; request a new preview.");
    }
    const accepted = await editor.edit((edit) => edit.replace(selection, text), { undoStopBefore: true, undoStopAfter: true });
    if (!accepted) throw new Error("The editor rejected this edit. Original text is preserved.");
  }

  async function preview(snapshot, replacement) {
    if (typeof replacement !== "string") throw new Error("No replacement text returned.");
    const id = ++previewSequence;
    const sourceUri = vscode.Uri.parse(`delulu-preview:/original-${id}.txt`);
    const resultUri = vscode.Uri.parse(`delulu-preview:/rewrite-${id}.txt`);
    previews.set(sourceUri.toString(), snapshot.source);
    previews.set(resultUri.toString(), replacement);
    try {
      let choice = await vscode.window.showQuickPick(["Review diff", "Apply preview", "Discard"], { title: "Delulu rewrite preview", placeHolder: "Original text stays unchanged until you apply." });
      if (choice === "Review diff") {
        await vscode.commands.executeCommand("vscode.diff", sourceUri, resultUri, "Delulu: Original ↔ Rewrite", { preview: true });
        choice = await vscode.window.showQuickPick(["Apply preview", "Discard"], { title: "Apply to the original document?" });
        // Returning to the original editor is explicit; stale range/version guards still apply.
        if (choice === "Apply preview") await vscode.window.showTextDocument(snapshot.editor.document, { viewColumn: snapshot.editor.viewColumn, preserveFocus: false });
      }
      if (choice === "Apply preview") await apply(snapshot, replacement);
    } finally { previews.delete(sourceUri.toString()); previews.delete(resultUri.toString()); }
  }

  register("deluluTalks.setToken", async () => {
    const token = await vscode.window.showInputBox({ title: "Delulu integration token", password: true, prompt: "Grant only the capabilities you need in Delulu Settings. Stored in VS Code SecretStorage." });
    if (token === undefined) return;
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid scoped token.");
    await context.secrets.store("integration-token", token);
  });
  register("deluluTalks.rewriteSelection", async () => {
    const snapshot = target(true);
    let editorContext;
    if (vscode.workspace.getConfiguration("deluluTalks").get("sendEditorContext")) {
      const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", snapshot.editor.document.uri) ?? [];
      const names = [];
      const collect = (items, depth = 0) => {
        if (depth > 8) return;
        for (const symbol of items) {
          if (names.length >= 64) break;
          if (typeof symbol.name === "string") names.push(symbol.name.slice(0, 80));
          if (Array.isArray(symbol.children)) collect(symbol.children, depth + 1);
        }
      };
      collect(symbols);
      editorContext = { fileType: snapshot.editor.document.languageId, selection: `Local editor symbol names: ${[...new Set(names)].join(", ")}`.slice(0, 4000) };
    }
    const result = await request("rewrite", { text: snapshot.source, preset: "polish", context: editorContext });
    await preview(snapshot, result.text);
  });
  register("deluluTalks.insertLatest", async () => {
    const snapshot = target();
    const history = await request("history");
    const record = Array.isArray(history) ? history.reduce((latest, item) => !latest || item.createdAt > latest.createdAt ? item : latest, null) : null;
    if (!record) throw new Error("There is no saved transcript.");
    await apply(snapshot, record.editedText ?? record.magicText ?? record.personalizedText ?? record.text);
  });
  register("deluluTalks.transcribeFile", async () => {
    const snapshot = target();
    const sources = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Audio: ["wav", "flac", "mp3", "m4a", "ogg", "opus", "webm", "mp4", "mov", "mkv"] } });
    if (!sources?.[0]) return;
    const record = await request("transcribe", { path: sources[0].fsPath });
    await preview(snapshot, record.editedText ?? record.magicText ?? record.personalizedText ?? record.text);
  });
  register("deluluTalks.chooseProfile", async () => {
    const profiles = await request("profiles");
    const choices = [{ label: "Global settings", id: null }, ...profiles.map((profile) => ({ label: profile.name, id: profile.id }))];
    const choice = await vscode.window.showQuickPick(choices, { title: "Delulu dictation profile" });
    if (choice) await request("profiles/activate", { id: choice.id });
  });
  context.subscriptions.push({ dispose: () => previews.clear() });
}
module.exports = { activate };
