# Backend verification status

The backend is the recommended deployment path when exact byte accounting and enforcement are required. The Cloudflare Worker is **not equivalent**: its current proxy implementation explicitly does not enforce byte quotas, and its connection/device limit is not enforced.

## Tests

Pull requests and pushes to the hardening branch run Python compile checks and the backend pytest suite. A green workflow is necessary but not sufficient for release: perform a staging run with the actual Xray image and validate real client traffic, core restarts, quota crossing, expiry, and simultaneous clients.

## Enforcement caveats

- Byte quotas depend on Xray StatsService counters. If StatsService is unavailable, the panel must preserve stored usage and must not treat a missing response as zero usage.
- Counter deltas are accumulated to avoid resetting lifetime usage when Xray restarts. Traffic that occurs between the last poll and an abrupt Xray restart may not be observable; this requires an explicit restart/poll test before production use.
- A configured `device_limit` is metadata only in the current VLESS/Xray design. Multiple devices sharing one UUID are indistinguishable, so a simultaneous-device cap is **not enforced**. Do not advertise it as an enforced limit. Real enforcement requires per-device credentials or a core feature that reliably identifies devices.
- Expiry and quota checks are reflected in generated Xray config only after the panel refreshes/synchronizes state. Until background synchronization and integration tests are in place, do not treat the project as production-ready.
- The Compose file currently mounts the Docker socket into the web application. This is a high-privilege host-control surface and must be replaced with a narrowly scoped restart mechanism before internet-facing production deployment.
- Changing/removing secrets in a branch does not remove them from Git history. Rotate any credentials or private keys ever committed.

## Deployment

Use a supported Ubuntu LTS host with persistent storage for `/data` and `/xray`, keep the panel bound to localhost behind a properly configured TLS reverse proxy, and never expose the Xray StatsService or stats sidecar publicly. Back up the SQLite database before schema changes. Deploy only after CI passes and the staging checklist above is signed off.
