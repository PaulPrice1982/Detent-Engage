# Embedded widget origin binding

The panel remains sandboxed without `allow-same-origin`. It therefore has an
opaque origin, and never authenticates API calls with an `Origin: null` exception.
Its standalone script is loaded as a classic deferred script because a module
script would require CORS from that opaque origin.

For embedded use, the launcher performs API fetches on the customer page. The
browser supplies that page's real Origin, and the existing API checks it against
the widget key and tenant's registered origins. The server's CORS and frame
ancestor lists include current tenant origins, so origin registration takes
effect without restarting the server. Customer CSP must permit the configured
API in `connect-src`, the launcher in `script-src`, and the panel in `frame-src`.

The bridge accepts messages only from its own attached iframe WindowProxy with
the expected opaque origin. It permits only locale and visitor-session routes;
the API destination, key and headers come from the launcher configuration.
Cookies are omitted and redirects refused. Responses use a separate MessagePort
for each request, avoiding wildcard delivery to a frame that might navigate.
The panel addresses its parent using the exact host origin supplied by the
launcher. This value routes messages; it never overrides server authentication.

The bridge buffers SSE responses before forwarding them. The final-answer safety
checks still run, and the panel renders the same sentence/done events. No
token-by-token latency improvement is claimed.

Run `tests/widget-embed.browser.mjs` using the repository TS loader with an
installed Playwright package. `PLAYWRIGHT_MODULE` and `BROWSER_EXECUTABLE` can
select an existing package and Chromium/Edge binary. The test uses separate
customer/API origins and production HTTP headers, verifies a streamed answer
and close/focus behavior, and rejects admin proxy requests, forged close
messages, unregistered sites, and direct null-origin API requests.
