# Desktop dependency security backport

## glib 0.18.5 — RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g

Tauri 2's GTK3/WebKit stack requires `glib ^0.18`. The latest compatible
published release is 0.18.5, which is vulnerable; adding glib 0.20 alongside it
does not replace that dependency. Until the stack accepts a fixed release,
Ohiyo owns this narrowly scoped backport, selected by `[patch.crates-io]` in
the desktop's `Cargo.toml`.

### Provenance and changes

`glib-0.18.5/` is the complete published MIT-licensed crate from
<https://static.crates.io/crates/glib/glib-0.18.5.crate>.

- Crate archive SHA-256:
  `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`
- Original source commit: `42b9caf98e03ded086362d9653ca58fe94dc8658`
- Upstream fix:
  <https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439bef2b5eea76c3aa25e5ae84839e34>
- Exact 0.18 backport (closed, not merged upstream):
  <https://github.com/gtk-rs/gtk-rs-core/commit/ea720152f28e293ef4362ee844ee5cc499f32d2a>

The only changes to published files are the two upstream changes in
`src/variant_iter.rs`: make the C string out-pointer mutable and pass `&mut p`
to `g_variant_get_child`. All APIs, features, dependencies, licenses and
copyright notices are preserved. The published normalized `Cargo.toml` keeps
sys/macro dependencies on crates.io, avoiding a duplicate Git-sourced GLib
dependency family.

### Verification and scanner limitations

CI runs the crate's existing `variant_iter::tests` in **release mode**: the
incorrect immutable out-pointer can crash under compiler optimization even
when debug tests pass.
It also audits both desktop and standalone vault lockfiles. To check locally:

```sh
cargo tree --manifest-path client/src-tauri/Cargo.toml --locked -i glib
cargo test --manifest-path client/src-tauri/vendor/glib-0.18.5/Cargo.toml --release --lib variant_iter::tests
```

Cargo generates a disposable lockfile for the standalone upstream tests; it is
not the desktop's release dependency graph. The desktop lockfile remains the
source of truth for app builds and audits.

**A clean cargo-audit is not proof that this backport is recognized as fixed.**
RustSec currently recognizes glib >=0.20 and skips local-path dependencies.
Dependabot likewise may stop reporting the registry package without validating
the local fix. The patch review and optimized tests provide the evidence for
this advisory; future glib advisories require manual review against this copy.
No ignore for this advisory is added.

Remove the vendored crate and Cargo override once Tauri's resolved dependency
graph uses a compatible, scanner-recognized patched release. Do not merely bump
this copy's version to make a scanner accept it.
