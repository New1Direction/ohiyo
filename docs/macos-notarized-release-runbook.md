# Ohiyo macOS notarized release runbook

macOS customers must never be asked to bypass Gatekeeper. Ad-hoc signing is only
for private QA. Public Mac downloads require Developer ID signing + Apple
notarization.

## What the user warning means

If macOS says:

> Apple could not verify “Ohiyo” is free of malware that may harm your Mac or compromise your privacy.

then the app is not notarized by Apple. It may still download and run with a
right-click/Open bypass, but it is not acceptable for customers.

## Required Apple assets

You need an Apple Developer Program membership.

Create/collect:

1. **Developer ID Application** certificate exported as `.p12`.
2. Password for that `.p12` export.
3. Exact signing identity name, usually like:
   `Developer ID Application: Your Name or Company (TEAMID)`
4. Apple ID email.
5. Apple app-specific password for notarization.
6. Apple Team ID.

## Convert certificate to GitHub secret value

On the Mac that has the exported `.p12`:

```bash
openssl base64 -A -in DeveloperIDApplication.p12 -out apple-certificate-base64.txt
```

The entire single-line contents of `apple-certificate-base64.txt` goes into
`APPLE_CERTIFICATE`.

## Set GitHub Actions secrets

Use GitHub UI or `gh secret set`. Do not paste secrets into chat.

```bash
gh secret set APPLE_CERTIFICATE < apple-certificate-base64.txt
gh secret set APPLE_CERTIFICATE_PASSWORD
gh secret set APPLE_SIGNING_IDENTITY
gh secret set APPLE_ID
gh secret set APPLE_PASSWORD
gh secret set APPLE_TEAM_ID
```

Optional if Apple asks for provider disambiguation:

```bash
gh secret set APPLE_PROVIDER_SHORT_NAME
```

## Build the notarized release

After all six required secrets are set:

```bash
git push origin feat/discord-import-phase2
# then either create/push a version tag:
git tag v0.1.2
git push origin v0.1.2
# or run the Release workflow manually in GitHub Actions.
```

The Release workflow will:

- refuse public macOS tag builds if Apple secrets are missing,
- build with Developer ID signing when secrets exist,
- ask Apple to notarize,
- validate the `.app` with `codesign` + `spctl`,
- validate the `.dmg` with `xcrun stapler validate` + `spctl`.

## Before publishing

The GitHub Release is a draft. Before publishing it:

1. Download the Apple Silicon `.dmg` on a clean Mac.
2. Open it normally from Downloads.
3. Confirm there is no “Apple could not verify” warning.
4. Repeat for Intel if possible.
5. Only then flip `macDownloadsTrusted` in `site/app.js` to `true`, restore direct
   Mac download copy if desired, deploy the landing site, and publish the release.

## Emergency policy

If notarization fails or Apple secrets are missing, keep Mac desktop downloads
paused and route users to `https://app.ohiyo.gg`.
