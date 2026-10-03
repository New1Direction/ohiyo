# Security Policy

Ohiyo is an end-to-end-encrypted chat app, so we take security reports
seriously and we're grateful for them. Thank you for taking the time to help us
keep users safe.

## Reporting a vulnerability

**Please do not open a public issue, pull request, or discussion for a security
vulnerability.** Public reports tip off attackers before a fix is available.

Instead, report it privately through **GitHub Private Vulnerability Reporting**:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Fill in as much detail as you can.

This opens a private advisory visible only to you and the maintainers. If for
some reason you can't use the Security tab, open a minimal public issue that
says only "I'd like to report a security issue privately" — with no details — and
a maintainer will follow up with a private channel.

### What to include

A good report is much easier to act on. Where you can, include:

- A clear description of the issue and its impact.
- Steps to reproduce, or a small proof of concept.
- The affected component (`server/`, `client/`, the Tauri desktop shell, the
  plugin sandbox, the encryption layer, etc.) and version or commit.
- Any suggested fix or mitigation, if you have one in mind.

## Our commitment

This is an early, volunteer-run project, so we'll be honest about scope:

- We aim to **acknowledge your report within 5 business days**.
- We'll keep you updated as we investigate and work toward a fix, in good faith.
- We'll credit you in the advisory once a fix ships, unless you'd rather stay
  anonymous.
- We won't take legal action against good-faith research that respects user
  privacy and avoids data destruction, service disruption, and access to data
  that isn't yours.

Please give us a reasonable window to ship a fix before any public disclosure,
and let's coordinate timing together.

## Scope

In scope: the Ohiyo server, web/desktop client, plugin sandbox, encryption and
key-handling code, authentication, and the deploy configuration in this repo.

Out of scope: vulnerabilities in third-party dependencies (please report those
upstream, though a heads-up is welcome), issues that require a fully compromised
device or a malicious server operator, and findings against infrastructure you
don't own. Please do not test against the hosted service at ohiyo.gg — run your
own local or self-hosted instance for testing.

## A note on the cryptography

Ohiyo builds on standard primitives rather than inventing ciphers, but parts of the
design are our own and none of it has had an external audit. One-to-one encryption
uses the **Signal Protocol** (X3DH + Double Ratchet) through
`@privacyresearch/libsignal-protocol-typescript`, a community TypeScript port, not
Signal's own libsignal. Group encryption (sender keys), the voice-key exchange, the
safety number, attachment encryption and the recovery backup are Ohiyo's own
constructions on WebCrypto (AES-256-GCM, ECDSA P-256, PBKDF2); the desktop vault is our
own Rust code (an AES-256-GCM sealed file whose key lives in the OS keychain). Reports
about how we *use* the protocol — key handling, session management, trust and
verification flows, metadata exposure, or sandbox escapes — are exactly the kind of
thing we want to hear about.

Voice/video is encrypted media (LiveKit FrameCryptor when the SFU is on, DTLS-SRTP
on the peer-to-peer mesh), but the WebRTC **signaling** channel rides the gateway:
establishing a call assumes the server relays offers/answers honestly. A malicious
server operator could disrupt or man-in-the-middle *call setup* — consistent with
the out-of-scope note above — so the integrity guarantee for voice is "honest
server."

Message content has a narrower guarantee than Signal's today: encryption is opt-in per
conversation, and a new device for a contact is trusted on first use without a
warning, so a malicious server (or someone holding a stolen session) could add a
device and read messages sent after that. Compare safety numbers out of band for
conversations that matter. The current limits are listed in the
[README](README.md#known-limits-of-the-encryption).
