// Classic (non-module) script loaded in <head>: applies the theme passed by the
// main process (?theme=dark|light) before the first paint, so there is no flash.
(function () {
  var theme = new URLSearchParams(window.location.search).get('theme');
  if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);
})();
