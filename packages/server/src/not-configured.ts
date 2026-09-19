/**
 * What to serve when the app must not run.
 *
 * Refusing to serve a product that would lose a customer's data is right.
 * Exiting to say so is not: the platform restarts the process, calls it a
 * crash loop, and the reason ends up in a log the operator has to go and find.
 * A running server that answers every request with the reason puts it in front
 * of them in a browser, which is where they already are.
 *
 * Nothing here touches a database, a session or a payment. It answers, says
 * what is missing, and does nothing else.
 */

export interface NotConfiguredInput {
  /** One line per problem, in the operator's words rather than the code's. */
  readonly problems: readonly string[];
}

export function notConfiguredPage(input: NotConfiguredInput): string {
  const items = input.problems
    .map((problem) => `<li>${escapeText(problem)}</li>`)
    .join('');

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Detent is not configured yet</title>
<style>
  :root{color-scheme:light}
  body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
   background:#F6F8FB;color:#16202B;display:flex;min-height:100vh;align-items:center;
   justify-content:center;padding:24px}
  .box{max-width:620px;background:#fff;border:1px solid #E3E8EF;border-radius:14px;
   padding:32px 34px;box-shadow:0 18px 44px rgba(16,24,40,.08)}
  h1{font-size:22px;margin:0 0 6px;letter-spacing:-.01em}
  p{color:#42536B;margin:0 0 14px}
  ul{margin:0 0 18px;padding-left:20px;color:#16202B}
  li{margin:0 0 8px}
  code{background:#EEF2F6;padding:2px 6px;border-radius:5px;font-size:14px}
  .note{font-size:14px;color:#5B6B7F;border-top:1px solid #EEF2F6;padding-top:14px;margin:0}
</style>
</head>
<body>
  <div class="box">
    <h1>Detent is not configured yet</h1>
    <p>The application started and is deliberately not serving. It will not take a sign-up
       or store anything until this is put right.</p>
    <ul>${items}</ul>
    <p class="note">Nothing has been lost. Set what is listed above and restart, and the
       application will come up normally.</p>
  </div>
</body>
</html>`;
}

/** Small and local, so this page has no dependency that could itself fail. */
function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}


/**
 * Shown when the back office is asked for on a hostname that is not its own.
 *
 * Names the setting rather than the hostname. Whoever configured the console
 * host already knows it, and anybody else asking a public URL for /console is
 * not entitled to be told where the staff entrance is.
 */
export function consoleElsewherePage(): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex,nofollow">',
    '<title>Not here</title><style>',
    'body{margin:0;background:#0E1B2A;color:#E8EEF5;font:15px/1.6 ui-sans-serif,system-ui,',
    '-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;display:flex;min-height:100vh;',
    'align-items:center;justify-content:center;padding:32px}',
    'main{max-width:34rem}h1{font-size:1.4rem;margin:0 0 12px;font-weight:650}',
    'p{margin:0 0 12px;color:#B9C7D8}code{background:#17293D;padding:2px 6px;border-radius:4px;',
    'font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:#EFA13C}',
    '</style></head><body><main>',
    '<h1>The back office is not on this address.</h1>',
    '<p>It has been given a hostname of its own, which is the point of it: the ',
    'staff console is not reachable from a customer domain, whatever anything ',
    'else does.</p>',
    '<p>If that domain is not resolving yet, set ',
    '<code>DETENT_CONSOLE_ON_PLATFORM_HOST=true</code> and restart to reach it at ',
    '<code>/console</code> here in the meantime. Remove it the day the domain ',
    'goes live.</p>',
    '</main></body></html>',
  ].join('');
}
