# Rebuilding the demonstration

These scripts film and photograph the running product. They hold no
credentials: every password comes from the environment, because a password in
a repository is a password that has leaked, whatever it protects.

## What you need running

PostgreSQL and Redis, and a database the migrations have been applied to.

```sh
createdb detent_demo
DATABASE_URL=postgres://appowner@127.0.0.1:5433/detent_demo node tools/migrate.mjs
```

## The variables

| Variable | What it is |
|---|---|
| `DETENT_CONSOLE_PASSWORD` | The first operator's password. Choose one; it is not in this repository. |
| `DETENT_SESSION_SECRET` | 32 characters or more. Without a stable one, every session ends at the next restart. |
| `OPERATOR_PASSWORD` | The same value as `DETENT_CONSOLE_PASSWORD`, for the capture scripts to sign in with. |
| `SUPPORT_PASSWORD`, `VIEWER_PASSWORD` | The support and viewer console accounts, for the role scenes. |
| `APP_PASSWORD` | The customer-side account, for the customer scenes. |
| `DATABASE_URL`, `REDIS_URL` | Default to the local development ports. |

The additional console and customer accounts are created through the
product's own `UserService`, so they are hashed and enrolled exactly as a real
one would be. Create them once with a short script against the same database;
give the money-capable ones MFA, or every money action in the footage will be
refused, which is the platform working and not what these scenes are for.

## Running it

```sh
bash docs/demo/capture/start.sh     # boots on :8901 and writes wk.txt
bash docs/demo/capture/seed.sh      # four customers, through the real console forms

node docs/demo/capture/live.cjs     # the films: eleven clips into clips/
node docs/demo/capture/shoot.cjs    # the stills: public, console, customer, widget
node docs/demo/capture/shoot2.cjs   # the role views, and a second person approving
node docs/demo/capture/shoot3.cjs   # the account once the approval has landed
```

`live.cjs` is the one that matters now. It drives a real browser, so the
navigation, the typing and the responses are the product's own; what it adds
is the person. A recorded browser has no visible cursor, input appears
instantaneously and scrolling jumps, so the script injects a cursor that the
camera can see, types character by character, eases the pointer between
targets, draws a ring on each click and scrolls on a curve. Nothing about the
product is simulated. Only the hand is.

Clips are VP8 in WebM, which is what the bundled encoder produces. Chrome,
Edge and Firefox play them anywhere; Safari from version 14 on macOS.

`AWA_DEMO_SEED=1` is refused in a deployment. It writes credit to accounts,
and a fixture that can run against a customer's data is a fixture that
eventually will.
