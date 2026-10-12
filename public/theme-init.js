// Applies an explicitly chosen appearance before first paint (no inline script, CSP-friendly).
try {
  var theme = localStorage.getItem('preprati.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  /* storage unavailable */
}
