/** Opens a link in the browser. */
export const openPage = (url: string) =>
  void window.aria.openExternal(url).catch(() => {
    // Main ignores what it can't open, so this is only the window going away: nothing to show then.
  });
