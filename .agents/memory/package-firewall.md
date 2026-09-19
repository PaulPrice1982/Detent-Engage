---
name: Package firewall behavior
description: Dependency installs may fail when the Replit package firewall blocks a pinned tarball.
---

The package manager can be available and the lockfile can be current while installation still fails because the environment blocks a dependency tarball. In that state, workspace typechecks may cascade into missing-package errors.

**Why:** A finished imported repository should not be modified to work around an environment-level package fetch failure without an explicit decision.

**How to apply:** Preserve the repository's declared dependency versions, report the exact firewall error, and stop when the project's own run instructions say to stop on verification failure.