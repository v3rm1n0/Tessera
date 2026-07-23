// Applies the saved (or system) theme before first paint to avoid a flash.
// Kept as a standalone classic script so the page needs no inline <script>
// and can run under a strict script-src 'self' CSP.
(function () {
  var p = localStorage.getItem('voreinlass_theme');
  var eff = (p === 'light' || p === 'dark') ? p
    : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = eff;
})();
