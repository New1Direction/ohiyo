# Ohiyo launch status

_Last checked: 2026-06-27_

## Ready

- `https://ohiyo.gg` returns 200 and serves the public landing site.
- `https://app.ohiyo.gg` returns 200 and serves the current React bundle.
- `https://ohiyo.fly.dev/healthz` returns `ok`.
- `https://api.ohiyo.gg/healthz` returns `ok`.
- Production backend exposes current v0.2 routes; auth-gated routes return `401` instead of stale `404`.
- Latest `main` CI and 28-suite E2E runs are green.
- Fly app `ohiyo` is running one healthy machine with 30-day volume snapshot retention.
- Backend image `registry.fly.io/ohiyo:deployment-01KW4G8KMFM0C6YBXMXB1CVSTD` is deployed.
- Current `registry.fly.io/ohiyo-instances:latest` image has been pushed for newly provisioned community machines.
- Fly provisioning secrets for Instant Servers are deployed and wildcard `*.ohiyo.gg` reaches the router.
- Authenticated Instant Server production smoke passed: a temporary instance at `https://launch-smoke-01b801.ohiyo.gg/healthz` returned `ok`, then `DELETE /api/v1/instances/{id}` removed its machine/volume/registry row and the subdomain returned the expected router 404.
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

## Instant Servers smoke procedure

- Use `scripts/instant-server-prod-smoke.sh` to register a temporary smoke user, create an instance, wait for `https://<subdomain>.ohiyo.gg/healthz`, and delete the instance afterward.
- Existing long-lived demo machine: `founders-hall-99de3e` is still running in `ohiyo-instances` and answers health through the wildcard router.
