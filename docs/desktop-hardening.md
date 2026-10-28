# Desktop hardening gates

Secure memory, native platform verification, and release trust are separate gates.
A successful Rust cross-check is not permission to publish an installer.

## Secure-memory boundary

`client/src-tauri/crates/goodnight` is the unsafe boundary; `kikka-vault` retains
its existing safe API and dependency shape. No Windows SDK crate is needed for
the five Kernel32 functions used here.

| Platform | Allocation and locking | Wipe and release | Important limits |
| --- | --- | --- | --- |
| Linux | Private anonymous `mmap`, best-effort `mlock` | `explicit_bzero` over every allocated page, then `munlock` if locked, then `munmap` | Upstream degraded/swappable behavior on lock failure is preserved; `MADV_DONTDUMP` is advisory and its result is not enforced. |
| macOS | Same Unix allocation/locking behavior | `memset_s` over every allocated page, unlock, unmap | Same best-effort locking; no mapping-level dump exclusion. |
| Windows | `VirtualAlloc(NULL, cap, MEM_RESERVE \| MEM_COMMIT, PAGE_READWRITE)`, then mandatory `VirtualLock` | Volatile writes over every committed page plus compiler fence, then `VirtualUnlock`, then `VirtualFree(base, 0, MEM_RELEASE)` | Lock failure returns an error before any secret can be written; never falls back to a pageable buffer. No crash-dump or hibernation exclusion. |

Lengths are checked before allocation, rounded to the actual OS page size, and
restricted to `isize::MAX` so both logical and full-allocation slices are valid.
Zero, overflow, and impossible slice lengths return `InvalidInput`, not a panic
or wrapped allocation. Normal Unix allocation, locking, wiping and release
behavior is otherwise unchanged.

On Windows, failed allocation returns the OS error. Failed locking preserves
the original OS error and releases the still-zero reservation; the caller never
receives it. The implementation does not raise working-set quotas or require a
new privilege. Working-set limits can legitimately prevent storing more keys;
`Vault::set` already propagates allocation errors and does not replace an old
entry until the new buffer exists. `Vault::open` propagates errors too.

Windows drop wipes **before** making the pages pageable. An unexpected unlock
failure still attempts to free the allocation, then aborts; release failure
also aborts rather than silently leaking or resuming after a broken ownership
invariant. These cleanup failures are not recoverable through `Drop`.

The Unix-only UID, signal/PID and `RLIMIT_MEMLOCK` helpers are explicitly
`cfg(unix)`, not fake Windows implementations. The vault uses none of them.
`set_process_undumpable` continues to return `Unsupported` off Linux. The
`SecretBuffer`/wipe APIs used by the vault are unchanged.

This does **not** make all key material non-pageable: JS heap, returned strings,
serialization/decryption temporaries, crypto state, and keychain/master-key
handling are outside this allocation guarantee. Kernel/admin access, process
memory readers, hibernation, and system/diagnostic dumps require separate threat
modeling. Unix callers must not describe best-effort `mlock` as unconditional.

### Windows ABI and primary references

The bindings use `extern "system"`/Kernel32, `BOOL = i32`, `DWORD = u32`,
`WORD = u16`, and pointer-sized `SIZE_T`/`DWORD_PTR`. The `repr(C)` `SYSTEM_INFO`
mirror uses a four-byte first union slot, page-size offset 4, first-pointer
offset 8, and total size 48 on Win64 / 36 on Win32. The unused union is represented
by its `DWORD` branch, not a guessed opaque buffer. Native tests check these
layout expectations and query the real page size.

Reviewed against Microsoft's contracts:

- [Windows data types and WINAPI calling convention](https://learn.microsoft.com/en-us/windows/win32/winprog/windows-data-types)
- [SYSTEM_INFO layout](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/ns-sysinfoapi-system_info)
- [GetSystemInfo](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getsysteminfo)
- [VirtualAlloc](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-virtualalloc): zero initialization, page rounding, reserve/commit, NULL on failure.
- [VirtualLock](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-virtuallock): committed accessible pages only, working-set quota, nonzero success, locked pages not written to the pagefile.
- [VirtualUnlock](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-virtualunlock): unlock the same complete region; no lock reference count.
- [VirtualFree](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-virtualfree): `MEM_RELEASE` requires original base and size zero, decommits and releases the reservation.

## Native regression gate (no installer or signing credentials)

`.github/workflows/desktop-security.yml` runs independently of the existing
`ci.yml` on PRs, main pushes, and manual dispatch. Its Linux, macOS, and Windows
jobs run standalone goodnight and vault tests in debug **and optimized** builds.
Goodnight also gets formatting and warnings-as-errors Clippy checks. Lockfiles
are enforced; goodnight's standalone lock pins the same libc as the desktop and
vault locks. Bash makes every failing command fail the step on every runner.

Goodnight tests cover alignment, zero initialization, actual small-allocation
locking (including on Unix), checked lengths, short/oversized writes, full-page
slack wiping, repeated allocations and cross-thread drop. Windows adds layout,
allocation failure, and forced lock-error rollback/error-preservation tests.
The rollback test reserves the released address again; tests run serially so
other tests in that binary do not race to reuse it. It injects a quota error
without changing host working-set limits. Successful allocation/drop tests use
the actual native lock/unlock/free functions. No test reads freed memory.

The existing six vault tests exercise CRUD, empty values, burn, AES-GCM
seal/open, wrong-key rejection and tamper rejection against each platform's
backend. They do not prove end-to-end Tauri/keychain/WebView behavior, absence
of plaintext copies, or resistance to OS dumps. The current macOS matrix tests
the architecture of `macos-latest`; it is not native Intel-mac coverage.

Local reproduction from the repository root:

```sh
cargo fmt --manifest-path client/src-tauri/crates/goodnight/Cargo.toml --check
cargo clippy --locked --all-targets --manifest-path client/src-tauri/crates/goodnight/Cargo.toml -- -D warnings
cargo test --locked --manifest-path client/src-tauri/crates/goodnight/Cargo.toml -- --test-threads=1
cargo test --locked --release --manifest-path client/src-tauri/crates/goodnight/Cargo.toml -- --test-threads=1
cargo test --locked --manifest-path client/src-tauri/crates/vault/Cargo.toml -- --test-threads=1
cargo test --locked --release --manifest-path client/src-tauri/crates/vault/Cargo.toml -- --test-threads=1
```

Passing Linux tests or Windows/macOS `cargo check` does not constitute native
runtime verification. Windows and macOS CI results must be reviewed on the
proposed release revision. Maintainers must make the matrix jobs required in
branch protection if they are to block merging; adding a workflow alone cannot
change repository settings or make the separate release workflow depend on it.

## Release trust: preserve the existing fail-closed path

`release.yml` already rejects missing updater signing keys, and rejects missing
Developer ID/notarization credentials for macOS. Its macOS path signs and
notarizes, then verifies app codesign/Gatekeeper trust and DMG stapling/Gatekeeper
trust. Do not duplicate, bypass, or relax those checks. This hardening change
does not alter that workflow or signing credentials. Updater signatures and OS
code signing are different requirements; neither substitutes for the other.

**Windows installers remain disabled in the release matrix.** Its comment points
to these remaining gates. The backend is fail-closed, not a pageable-memory
fallback, and implementing it is only one prerequisite. Before a separate change
enables Windows releases:

1. Obtain passing native Windows goodnight/vault results on the release revision,
   including optimized tests, and review the FFI/error paths.
2. Build and exercise the complete Tauri app on supported Windows versions:
   keychain-backed vault startup, persistence/reopen, burn, quota/error handling,
   upgrade, uninstall/reinstall, and relevant diagnostic/dump behavior. Do not
   infer this from standalone crate tests or cross compilation.
3. Establish an authorized Authenticode signing/timestamping path for the app
   and installer and fail-closed verification of the resulting artifacts on a
   clean Windows machine. Keep signed-updater enforcement too. The currently
   disabled Windows path has no OS-signing gate; enabling its matrix row alone
   would be insufficient.
4. Review all native test results and signed artifacts before publication. Do not
   treat draft-release upload as independent evidence of trusted installation.

For macOS, retain the existing Developer ID/notarization/Gatekeeper checks and
verify the complete app/keychain on both intended release architectures. This
document and credential-free test workflow do not claim those release checks
have been run, provision signing secrets, or authorize publishing installers.
