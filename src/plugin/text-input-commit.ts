import type { TextComponent } from 'obsidian';

/** Commit a trimmed text value when the field loses focus or Enter is pressed. */
export function commitTextOnBlurOrEnter(
  text: TextComponent,
  getCurrentValue: () => string,
  onCommit: (value: string) => void | Promise<void>,
): void {
  const commit = (): void => {
    const value = text.getValue().trim();
    const currentValue = getCurrentValue();

    if (!value) {
      text.setValue(currentValue);
      return;
    }
    if (value === currentValue) return;

    void onCommit(value);
  };

  text.inputEl.addEventListener('blur', commit);
  text.inputEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;

    event.preventDefault();
    // Blur is the single commit path, so Enter cannot commit twice.
    text.inputEl.blur();
  });
}

/** Flush a focused field before Obsidian removes the settings tab DOM. */
export function blurFocusedDescendant(containerEl: HTMLElement): void {
  const activeElement = containerEl.ownerDocument.activeElement;
  if (
    activeElement
    && containerEl.contains(activeElement)
    && 'blur' in activeElement
    && typeof activeElement.blur === 'function'
  ) {
    activeElement.blur();
  }
}
