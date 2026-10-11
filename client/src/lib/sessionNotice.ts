// A one-line reason shown on the sign-in screen after the app signed this device out by
// itself, so landing there isn't a mystery. Read once, then gone.

const KEY = "ohiyo:sign-in-notice";

export function setSignInNotice(text: string): void {
  try {
    sessionStorage.setItem(KEY, text);
  } catch {
    /* storage disabled: the sign-in screen just shows no reason */
  }
}

export function takeSignInNotice(): string | null {
  try {
    const text = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return text;
  } catch {
    return null;
  }
}
