//! Secure memory primitives for dazai.
//!
//! A [`SecretBuffer`] owns a page-aligned anonymous mapping that is locked into
//! physical RAM ([`mlock`]) so it is never written to swap, excluded from core
//! dumps where the OS supports it, and **explicitly wiped** on drop with a
//! zeroing primitive the compiler is not permitted to elide.
//!
//! This is the *only* crate in the workspace allowed to use `unsafe`. Every
//! unsafe block carries a `// SAFETY:` comment. Consumers (watchdog, child,
//! the binary) build on the safe API exposed here and set
//! `#![deny(unsafe_code)]`.
//!
//! # Guarantees (best-effort, platform-dependent)
//! - page-aligned `mmap(MAP_ANON | MAP_PRIVATE)` allocation
//! - `mlock` on every buffer (degrades to a warning if `RLIMIT_MEMLOCK` forbids)
//! - `madvise(MADV_DONTDUMP)` on Linux (no-op on macOS)
//! - non-elidable wipe: `explicit_bzero` on Linux, `memset_s` on macOS,
//!   a volatile write loop elsewhere
//! - `Drop` wipes, then `munlock`, then `munmap`
//! - move-only: `SecretBuffer` is neither `Clone` nor `Copy`, and never hands
//!   out a raw pointer that can outlive the borrow

#![warn(missing_docs)]

use std::io;
use std::ptr::NonNull;
use std::slice;

/// Overwrite `buf` with zero bytes using a primitive the optimizer may not
/// remove (unlike `memset` / `ptr::write_bytes`, which are subject to
/// dead-store elimination).
pub fn secure_wipe(buf: &mut [u8]) {
    if buf.is_empty() {
        return;
    }

    #[cfg(target_os = "linux")]
    {
        // SAFETY: `explicit_bzero` writes exactly `buf.len()` zero bytes
        // starting at a pointer valid for that many writes (guaranteed by the
        // `&mut [u8]`), and is contractually never optimized away.
        unsafe { libc::explicit_bzero(buf.as_mut_ptr().cast(), buf.len()) };
    }

    #[cfg(target_os = "macos")]
    {
        // SAFETY: `memset_s` (C11 Annex K, provided by libSystem) writes
        // `buf.len()` zero bytes at a valid pointer and is guaranteed not to be
        // elided. The return value reports constraint violations; none can
        // occur here (count == smax, valid pointer), so it is ignored.
        unsafe { libc::memset_s(buf.as_mut_ptr().cast(), buf.len(), 0, buf.len()) };
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        for byte in buf.iter_mut() {
            // SAFETY: `byte` is a valid, exclusively-borrowed, aligned location.
            unsafe { std::ptr::write_volatile(byte, 0u8) };
        }
        std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
    }
}

/// The real user id of the calling process.
///
/// Exposed here (the workspace's sole `unsafe` crate) so unsafe-free crates can
/// build a per-user socket path without their own FFI.
pub fn current_uid() -> u32 {
    // SAFETY: `getuid` is a pure query that always succeeds and touches no
    // memory we provide.
    unsafe { libc::getuid() }
}

/// Whether a process with PID `pid` currently exists.
///
/// Uses `kill(pid, 0)` — portable on Linux and macOS: a `0` return, or `EPERM`,
/// means the process exists. Rejects pid 0 and values that would not fit a
/// positive `pid_t`, since those select a process *group* or every process
/// rather than one process.
pub fn pid_exists(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // SAFETY: `kill` with signal 0 performs only an existence/permission check;
    // it delivers no signal and touches no memory we own. `pid` is a validated
    // positive value within `pid_t` range.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if rc == 0 {
        return true;
    }
    // EPERM => the process exists but we lack permission to signal it.
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Send signal `signum` to PID `pid`. Returns whether it was delivered.
///
/// Rejects pid 0 and out-of-`pid_t`-range values so a wrapped or zero value can
/// never target a process group or every process.
pub fn send_signal(pid: u32, signum: i32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // SAFETY: `kill(pid, signum)` for a validated single positive pid; it
    // touches no memory we own.
    unsafe { libc::kill(pid as libc::pid_t, signum) == 0 }
}

/// Send `SIGKILL` to PID `pid`. Returns whether the signal was delivered.
pub fn sigkill_pid(pid: u32) -> bool {
    send_signal(pid, libc::SIGKILL)
}

/// Send `SIGKILL` to the current process. Never returns.
pub fn raise_sigkill() -> ! {
    // SAFETY: `raise(SIGKILL)` targets the current process and takes no memory
    // arguments; SIGKILL is uncatchable, so control never returns here.
    unsafe {
        libc::raise(libc::SIGKILL);
    }
    // Unreachable in practice (SIGKILL already terminated us); spin to honor the
    // `!` return type if the kernel were ever to return.
    loop {
        std::hint::spin_loop();
    }
}

/// Query the system page size, falling back to 4 KiB.
fn page_size() -> usize {
    // SAFETY: `sysconf` is a pure query with no memory arguments.
    let ps = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if ps <= 0 {
        4096
    } else {
        ps as usize
    }
}

/// Best-effort raise of `RLIMIT_MEMLOCK`.
///
/// On Linux this targets `RLIM_INFINITY` (requires `CAP_IPC_LOCK`); elsewhere it
/// raises the soft limit to the hard limit. Returns `Ok(true)` if the limit was
/// successfully raised, `Ok(false)` if the kernel refused (caller should warn
/// and continue), or `Err` if the limit could not even be read.
pub fn try_raise_memlock_rlimit() -> io::Result<bool> {
    let mut lim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `getrlimit` fills a valid, fully-owned `rlimit` we point it at.
    let rc = unsafe { libc::getrlimit(libc::RLIMIT_MEMLOCK, &mut lim) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }

    #[cfg(target_os = "linux")]
    {
        lim.rlim_cur = libc::RLIM_INFINITY;
        lim.rlim_max = libc::RLIM_INFINITY;
    }
    #[cfg(not(target_os = "linux"))]
    {
        lim.rlim_cur = lim.rlim_max;
    }

    // SAFETY: `setrlimit` reads a valid, fully-owned `rlimit`.
    let rc = unsafe { libc::setrlimit(libc::RLIMIT_MEMLOCK, &lim) };
    Ok(rc == 0)
}

/// Disable core dumps and ptrace attachment for this process.
///
/// On Linux this is `prctl(PR_SET_DUMPABLE, 0)`. On other platforms it returns
/// [`io::ErrorKind::Unsupported`] so the caller can warn that the guarantee is
/// absent.
pub fn set_process_undumpable() -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: `prctl(PR_SET_DUMPABLE, 0, …)` takes scalar args only.
        let rc = unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "PR_SET_DUMPABLE is not available on this OS",
        ))
    }
}

/// A page-aligned, `mlock`'d, explicitly-zeroizable byte buffer.
///
/// The allocation is rounded up to a whole number of pages. `len()` reports the
/// requested logical length; the full allocation is wiped on [`SecretBuffer::wipe`]
/// and on drop. The type deliberately does not implement `Clone`/`Copy` and
/// exposes its bytes only through borrow-checked slices, so no pointer into the
/// secret can outlive the buffer.
pub struct SecretBuffer {
    ptr: NonNull<u8>,
    len: usize,
    cap: usize,
    locked: bool,
}

impl SecretBuffer {
    /// Allocate, lock, and zero a new buffer of `len` bytes.
    ///
    /// Fails only if `len == 0` or the mapping cannot be created. A failed
    /// `mlock` is non-fatal: the buffer is returned in a degraded (swappable)
    /// state with [`is_locked`](Self::is_locked) reporting `false`.
    pub fn new(len: usize) -> io::Result<Self> {
        if len == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "SecretBuffer length must be > 0",
            ));
        }
        let ps = page_size();
        let cap = len.div_ceil(ps) * ps;

        // SAFETY: a null `addr` lets the kernel choose the location;
        // `MAP_ANON | MAP_PRIVATE` returns a fresh, zero-filled private mapping
        // of `cap` bytes. We check the result against `MAP_FAILED` before use.
        let raw = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                cap,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_ANON | libc::MAP_PRIVATE,
                -1,
                0,
            )
        };
        if raw == libc::MAP_FAILED {
            return Err(io::Error::last_os_error());
        }
        let ptr = NonNull::new(raw.cast::<u8>()).expect("mmap returned non-null on success");

        let mut buf = SecretBuffer {
            ptr,
            len,
            cap,
            locked: false,
        };
        buf.lock();
        buf.dontdump();
        Ok(buf)
    }

    fn lock(&mut self) {
        // SAFETY: `ptr`/`cap` describe our own valid, page-aligned mapping.
        let rc = unsafe { libc::mlock(self.ptr.as_ptr().cast(), self.cap) };
        if rc == 0 {
            self.locked = true;
        } else {
            eprintln!(
                "[goodnight] WARN: mlock failed ({}); buffer is DEGRADED (swappable)",
                io::Error::last_os_error()
            );
        }
    }

    #[cfg(target_os = "linux")]
    fn dontdump(&self) {
        // SAFETY: valid mapping; `madvise` is advisory and cannot corrupt us.
        let _ = unsafe { libc::madvise(self.ptr.as_ptr().cast(), self.cap, libc::MADV_DONTDUMP) };
    }

    #[cfg(not(target_os = "linux"))]
    fn dontdump(&self) {
        // MADV_DONTDUMP does not exist on this OS; nothing to do.
    }

    /// The requested logical length in bytes.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Whether the buffer is empty (always false; `new` rejects zero length).
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Whether `mlock` succeeded for this buffer.
    pub fn is_locked(&self) -> bool {
        self.locked
    }

    /// Borrow the logical contents immutably.
    pub fn as_slice(&self) -> &[u8] {
        // SAFETY: `ptr` is valid for `len` bytes for at least the lifetime of
        // `&self` (the mapping outlives every borrow), and `&self` forbids
        // concurrent mutation.
        unsafe { slice::from_raw_parts(self.ptr.as_ptr(), self.len) }
    }

    /// Borrow the logical contents mutably.
    pub fn as_mut_slice(&mut self) -> &mut [u8] {
        // SAFETY: `ptr` is valid for `len` bytes; `&mut self` guarantees
        // exclusive access for the borrow's lifetime.
        unsafe { slice::from_raw_parts_mut(self.ptr.as_ptr(), self.len) }
    }

    /// Copy `data` into the buffer and zero any trailing slack.
    ///
    /// Errors if `data` is longer than the buffer.
    pub fn write(&mut self, data: &[u8]) -> io::Result<()> {
        if data.len() > self.len {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "data exceeds SecretBuffer capacity",
            ));
        }
        let used = data.len();
        let s = self.as_mut_slice();
        s[..used].copy_from_slice(data);
        secure_wipe(&mut s[used..]);
        Ok(())
    }

    /// Overwrite the *entire* allocation (all `cap` bytes) with zeros using
    /// [`secure_wipe`]. Idempotent and safe to call repeatedly.
    pub fn wipe(&mut self) {
        // SAFETY: `ptr` is valid for `cap` bytes (the full allocation) and
        // `&mut self` guarantees exclusive access.
        let full = unsafe { slice::from_raw_parts_mut(self.ptr.as_ptr(), self.cap) };
        secure_wipe(full);
    }
}

impl Drop for SecretBuffer {
    fn drop(&mut self) {
        self.wipe();
        if self.locked {
            // SAFETY: unlocking the same range we locked, exactly once.
            unsafe { libc::munlock(self.ptr.as_ptr().cast(), self.cap) };
        }
        // SAFETY: unmapping our own mapping exactly once — `Drop` runs once and
        // no slice borrows can be live here (they borrow `&self`/`&mut self`).
        unsafe { libc::munmap(self.ptr.as_ptr().cast(), self.cap) };
    }
}

// `SecretBuffer` owns a unique mapping with no interior aliasing, so it is sound
// to move between threads. It is intentionally NOT `Sync` (no shared access) and
// NOT `Clone`/`Copy`.
// SAFETY: the single owner has exclusive control of the mapping; moving the
// owning value to another thread transfers that exclusive control wholesale.
unsafe impl Send for SecretBuffer {}
