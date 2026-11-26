/*
 * Runs before first paint (a blocking classic script in <head>), so a chosen
 * theme or motion preference never flashes. UI preferences only; nothing else
 * is ever read from or written to localStorage. No imports, no exports.
 */
try {
  const root = document.documentElement;
  const theme = localStorage.getItem("galahad:theme");
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  const motion = localStorage.getItem("galahad:motion");
  if (motion === "reduce" || motion === "full") root.dataset.motion = motion;
  if (localStorage.getItem("galahad:sidebar") === "collapsed") root.dataset.sidebar = "collapsed";
} catch {
  /* storage blocked: system defaults apply */
}
