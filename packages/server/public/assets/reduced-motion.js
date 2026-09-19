// An autoplaying loop is motion the visitor did not ask for. A visitor who has
// asked their system for less of it gets a still frame with controls instead:
// the product is still there to be watched, on a press of play.
//
// This cannot be done in CSS: no property stops a video carrying the autoplay
// attribute. It is a file rather than an inline script so the page's content
// security policy can forbid inline script outright, which is what stops an
// injected <script> from running.
(function () {
  try {
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.querySelectorAll('figure.demo video').forEach(function (video) {
      video.autoplay = false;
      video.loop = false;
      video.pause();
    });
  } catch (error) { /* An older browser simply keeps the default behaviour. */ }
})();
