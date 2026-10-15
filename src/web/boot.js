/* Theme and language before first paint. External file: the page CSP disallows inline scripts. */
(function () {
  var pref = "system";
  var locale = null;
  try {
    pref = localStorage.getItem("piShellTheme") || "system";
    locale = localStorage.getItem("piShellLocale");
  } catch (error) {
    /* storage disabled: fall back to the defaults */
  }
  var light = window.matchMedia("(prefers-color-scheme: light)").matches;
  document.documentElement.dataset.theme = pref === "system" ? (light ? "light" : "dark") : pref;
  if (locale) document.documentElement.lang = locale;
})();
