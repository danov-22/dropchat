(() => {
  const root = document.documentElement;
  const preference = window.matchMedia('(prefers-color-scheme: dark)');
  let saved = null;
  try { saved = localStorage.getItem('dropchat-theme'); } catch (_) {}
  if (saved !== 'light' && saved !== 'dark') saved = null;
  function apply(theme) {
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#171717' : '#f8f7f3';
    for (const button of document.querySelectorAll('#theme-toggle, #room-theme-toggle')) {
      button.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
      button.setAttribute('aria-label', theme === 'dark' ? 'Use light mode' : 'Use dark mode');
      button.setAttribute('aria-pressed', String(theme === 'dark'));
    }
  }
  apply(saved || (preference.matches ? 'dark' : 'light'));
  preference.addEventListener('change', () => {
    if (!saved) apply(preference.matches ? 'dark' : 'light');
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== 'dropchat-theme' && event.key !== null) return;
    saved = event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : null;
    apply(saved || (preference.matches ? 'dark' : 'light'));
  });
  document.addEventListener('DOMContentLoaded', () => {
    apply(root.dataset.theme);
    for (const button of document.querySelectorAll('#theme-toggle, #room-theme-toggle')) button.addEventListener('click', () => {
      saved = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('dropchat-theme', saved); } catch (_) {}
      apply(saved);
    });
  });
})();
