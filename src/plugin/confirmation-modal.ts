import { App, Modal, Setting } from 'obsidian';

export interface ConfirmationOptions {
  title: string;
  message: string;
  confirmText: string;
  dangerous?: boolean;
}

/** Show an Obsidian-native confirmation dialog and resolve with the choice. */
export function confirmAction(
  app: App,
  options: ConfirmationOptions,
): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmationModal(app, options, resolve).open();
  });
}

class ConfirmationModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly options: ConfirmationOptions,
    private readonly resolveChoice: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.options.title);
    this.contentEl.empty();

    for (const paragraph of this.options.message.split('\n\n')) {
      this.contentEl.createEl('p', { text: paragraph });
    }

    const actions = new Setting(this.contentEl);
    actions.addButton((button) =>
      button
        .setButtonText('Cancel')
        .onClick(() => this.finish(false)),
    );
    actions.addButton((button) => {
      button
        .setButtonText(this.options.confirmText)
        .setCta()
        .onClick(() => this.finish(true));
      if (this.options.dangerous) button.setWarning();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolveChoice(false);
    }
  }

  private finish(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveChoice(confirmed);
    this.close();
  }
}
