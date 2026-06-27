# Ohiyo launch status

_Last checked: 2026-06-27_

## Ready

- `https://ohiyo.gg` returns 200 and serves the public landing site.
- `https://app.ohiyo.gg` returns 200 and serves the current React bundle.
- `https://ohiyo.fly.dev/healthz` returns `ok`.
- `https://api.ohiyo.gg/healthz` returns `ok`.
- Production backend exposes current v0.2 routes; auth-gated routes return `401` instead of stale `404`.
- Latest `main` CI and E2E runs are green.
- Fly app `ohiyo` is running one healthy machine with 30-day volume snapshot retention.
- Fly provisioning secrets for Instant Servers are deployed and wildcard `*.ohiyo.gg` reaches the router.
- Landing site has Privacy, Terms, robots.txt, sitemap.xml, and security.txt.

## Not blocking web launch

- Public macOS desktop downloads are paused until Developer ID signing/notarization is configured.
- Windows desktop builds are still disabled until the key-vault dependency is made Windows-compatible.
- Litestream continuous backup is documented but not configured; Fly daily snapshots are the current baseline.

## Before broad desktop launch

1. Add Apple Developer ID/notarization secrets to GitHub Actions.
2. Run the Release workflow and verify notarized Apple Silicon + Intel DMGs on a clean Mac.
3. Flip `macDownloadsTrusted` in `site/app.js` to `true` only after verification.
4. Re-enable direct Mac download copy on the landing page.

## Before broadly advertising Instant Servers

1. Run an authenticated production smoke for `POST /api/v1/instances`.
2. Confirm a real `ohiyo-instances` machine boots healthy.
3. Confirm `https://<subdomain>.ohiyo.gg/healthz` routes through Fly replay to that machine.
4. Confirm cleanup/suspend/delete behavior on the provisioned machine and volume.
