// useShortcut (Req 24.10): "/" moves focus to the First Name input, but only while
// focus is not already in a text entry control (so typing "/" in a field is unaffected).
//
// The First Name input is built in task 12.3; this hook targets it by a stable id and
// no-ops until it exists. Keeping the handler here means the shortcut is wired once at
// the shell level rather than inside the form.
import { useEffect } from 'react';

/** The id the First Name input will carry (shared with the search form, task 12.3). */
export const FIRST_NAME_INPUT_ID = 'criteria-firstName';

/** True when the element is a text-entry control where "/" should type, not navigate. */
function isTextEntry(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    // Non-text input types (checkbox, radio, button…) should still accept the shortcut.
    const textLike = ['text', 'search', 'email', 'tel', 'url', 'password', 'number'];
    return textLike.includes(type);
  }
  return false;
}

export function useShortcut(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTextEntry(document.activeElement)) return;

      const target = document.getElementById(FIRST_NAME_INPUT_ID);
      if (target instanceof HTMLElement) {
        event.preventDefault();
        target.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}
