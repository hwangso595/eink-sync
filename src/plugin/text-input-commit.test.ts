import type { TextComponent } from 'obsidian';
import { blurFocusedDescendant, commitTextOnBlurOrEnter } from './text-input-commit';

interface KeyboardEventStub {
  key: string;
  isComposing: boolean;
  preventDefault: jest.Mock;
}

function textFixture(initialValue: string): {
  text: TextComponent;
  inputEl: HTMLInputElement;
  emit: (type: 'blur' | 'keydown', event?: Partial<KeyboardEventStub>) => KeyboardEventStub;
} {
  const listeners = new Map<string, EventListener[]>();
  const inputEl = {
    value: initialValue,
    addEventListener: jest.fn((type: string, listener: EventListener) => {
      const registered = listeners.get(type) ?? [];
      registered.push(listener);
      listeners.set(type, registered);
    }),
  } as unknown as HTMLInputElement;

  const emit = (
    type: 'blur' | 'keydown',
    event: Partial<KeyboardEventStub> = {},
  ): KeyboardEventStub => {
    const emitted = {
      key: '',
      isComposing: false,
      preventDefault: jest.fn(),
      ...event,
    };
    for (const listener of listeners.get(type) ?? []) {
      listener(emitted as unknown as Event);
    }
    return emitted;
  };

  inputEl.blur = jest.fn(() => emit('blur'));
  const text = {
    inputEl,
    getValue: () => inputEl.value,
    setValue: (value: string) => {
      inputEl.value = value;
      return text;
    },
  } as unknown as TextComponent;

  return { text, inputEl, emit };
}

describe('commitTextOnBlurOrEnter', () => {
  it('does nothing while typing and commits the trimmed value on blur', () => {
    const fixture = textFixture('old/path');
    const commit = jest.fn();
    commitTextOnBlurOrEnter(fixture.text, () => 'old/path', commit);

    fixture.inputEl.value = '  new/path  ';
    expect(commit).not.toHaveBeenCalled();

    fixture.emit('blur');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('new/path');
  });

  it('restores the current value for blank input', () => {
    const fixture = textFixture('   ');
    const commit = jest.fn();
    commitTextOnBlurOrEnter(fixture.text, () => 'old/path', commit);

    fixture.emit('blur');

    expect(fixture.inputEl.value).toBe('old/path');
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not commit an unchanged value', () => {
    const fixture = textFixture('old/path');
    const commit = jest.fn();
    commitTextOnBlurOrEnter(fixture.text, () => 'old/path', commit);

    fixture.emit('blur');

    expect(commit).not.toHaveBeenCalled();
  });

  it('commits Enter through blur exactly once', () => {
    const fixture = textFixture('new/path');
    const commit = jest.fn();
    commitTextOnBlurOrEnter(fixture.text, () => 'old/path', commit);

    const event = fixture.emit('keydown', { key: 'Enter' });

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(fixture.inputEl.blur).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it.each([
    { key: 'Tab', isComposing: false },
    { key: 'Enter', isComposing: true },
  ])('ignores $key when composing is $isComposing', ({ key, isComposing }) => {
    const fixture = textFixture('new/path');
    const commit = jest.fn();
    commitTextOnBlurOrEnter(fixture.text, () => 'old/path', commit);

    const event = fixture.emit('keydown', { key, isComposing });

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(fixture.inputEl.blur).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});

describe('blurFocusedDescendant', () => {
  it('blurs the active element only when it belongs to the settings tab', () => {
    const activeElement = { blur: jest.fn() };
    const containerEl = {
      ownerDocument: { activeElement },
      contains: jest.fn(() => true),
    } as unknown as HTMLElement;

    blurFocusedDescendant(containerEl);

    expect(activeElement.blur).toHaveBeenCalledTimes(1);

    containerEl.contains = jest.fn(() => false);
    blurFocusedDescendant(containerEl);

    expect(activeElement.blur).toHaveBeenCalledTimes(1);
  });
});
