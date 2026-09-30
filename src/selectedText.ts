/** Native selection is session-only and never becomes a transcript implicitly. */
export type SelectedTextSession = { id: string; text: string; destination: string; capturedAt: number };
export type SelectedTextState = { enabled: boolean; supported: boolean; shortcut: string; session: SelectedTextSession | null; error: string | null };
export type SelectedTextApi = {
  getSelectedTextState(): Promise<SelectedTextState>;
  enableSelectedText(enabled: boolean): Promise<SelectedTextState>;
  discardSelectedText(id: string): Promise<void>;
  replaceSelectedText(id: string, text: string): Promise<void>;
  onSelectedTextState(callback: (state: SelectedTextState) => void): () => void;
};
