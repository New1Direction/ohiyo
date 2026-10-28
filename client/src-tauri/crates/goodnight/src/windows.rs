//! Narrow Kernel32 bindings. ABI and lifecycle references: docs/desktop-hardening.md.

use std::{ffi::c_void, io, ptr::NonNull};

const MEM_COMMIT: u32 = 0x1000;
const MEM_RESERVE: u32 = 0x2000;
const MEM_RELEASE: u32 = 0x8000;
const PAGE_READWRITE: u32 = 0x04;

// SYSTEM_INFO's first union occupies one DWORD (both branches are 4-byte,
// 4-aligned). We never interpret it. DWORD/WORD are u32/u16 even on Win64;
// pointers and DWORD_PTR are pointer-sized. repr(C) supplies the SDK padding.
#[repr(C)]
struct SystemInfo {
    processor_union: u32,
    page_size: u32,
    minimum_application_address: *mut c_void,
    maximum_application_address: *mut c_void,
    active_processor_mask: usize,
    number_of_processors: u32,
    processor_type: u32,
    allocation_granularity: u32,
    processor_level: u16,
    processor_revision: u16,
}

// WINAPI uses the system calling convention (stdcall on x86). SIZE_T is usize,
// DWORD is u32, BOOL is a signed 32-bit integer, not Rust bool.
#[link(name = "kernel32")]
extern "system" {
    fn GetSystemInfo(info: *mut SystemInfo);
    fn VirtualAlloc(address: *mut c_void, size: usize, kind: u32, protect: u32) -> *mut c_void;
    fn VirtualLock(address: *mut c_void, size: usize) -> i32;
    fn VirtualUnlock(address: *mut c_void, size: usize) -> i32;
    fn VirtualFree(address: *mut c_void, size: usize, kind: u32) -> i32;
}

pub(super) fn page_size() -> usize {
    let mut info = std::mem::MaybeUninit::<SystemInfo>::uninit();
    // SAFETY: GetSystemInfo initializes the complete SDK-compatible structure
    // at this valid, correctly aligned output pointer; it has no failure return.
    unsafe {
        GetSystemInfo(info.as_mut_ptr());
        info.assume_init().page_size as usize
    }
}

pub(super) fn allocate_locked(cap: usize) -> io::Result<NonNull<u8>> {
    allocate_with_lock(cap, |address, size| {
        // SAFETY: allocate_with_lock provides a fresh, committed, read/write
        // allocation valid for size bytes, and no secret has been copied yet.
        if unsafe { VirtualLock(address, size) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    })
}

// Keep allocation/rollback together; the callback lets tests force a lock error
// without changing the machine's working-set limits or relying on RAM pressure.
fn allocate_with_lock(
    cap: usize,
    lock: impl FnOnce(*mut c_void, usize) -> io::Result<()>,
) -> io::Result<NonNull<u8>> {
    // SAFETY: null requests a new, zero-filled private allocation. Both reserve
    // and commit are required; PAGE_READWRITE does not grant execute access.
    let raw = unsafe {
        VirtualAlloc(
            std::ptr::null_mut(),
            cap,
            MEM_RESERVE | MEM_COMMIT,
            PAGE_READWRITE,
        )
    };
    let ptr = NonNull::new(raw.cast::<u8>()).ok_or_else(io::Error::last_os_error)?;
    if let Err(error) = lock(raw, cap) {
        // No caller has received the allocation, so it still contains only OS
        // zeros. Preserve the original lock error before cleanup changes it.
        // SAFETY: raw is exactly the reservation base; MEM_RELEASE requires
        // size zero, and decommits as well as releasing the entire reservation.
        unsafe { release(ptr) };
        return Err(error);
    }
    Ok(ptr)
}

/// Release an owned, already wiped, locked allocation.
pub(super) unsafe fn release_locked(ptr: NonNull<u8>, cap: usize) {
    // SAFETY: caller owns this complete locked region and has wiped it before
    // making it pageable. Unlock exactly the range passed to VirtualLock.
    let unlocked = unsafe { VirtualUnlock(ptr.as_ptr().cast(), cap) };
    // Still release if unlock fails: VirtualFree decommits the region anyway.
    // SAFETY: caller transfers unique ownership of the original allocation.
    unsafe { release(ptr) };
    if unlocked == 0 {
        // An unexpected lifecycle violation is not a reason to return a
        // supposedly secure process to service. Avoid panic/unwind in Drop.
        std::process::abort();
    }
}

unsafe fn release(ptr: NonNull<u8>) {
    // SAFETY: ptr is the original reservation base, owned exclusively here;
    // zero size with MEM_RELEASE releases the complete reserved region.
    if unsafe { VirtualFree(ptr.as_ptr().cast(), 0, MEM_RELEASE) } == 0 {
        // Do not silently leak a locked allocation or continue after broken
        // ownership invariants. The OS reclaims memory on process termination.
        std::process::abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_info_abi() {
        assert_eq!(std::mem::offset_of!(SystemInfo, page_size), 4);
        assert_eq!(
            std::mem::offset_of!(SystemInfo, minimum_application_address),
            8
        );
        assert_eq!(
            std::mem::size_of::<SystemInfo>(),
            if cfg!(target_pointer_width = "64") {
                48
            } else {
                36
            }
        );
        assert_eq!(
            std::mem::align_of::<SystemInfo>(),
            std::mem::align_of::<usize>()
        );
        assert!(page_size().is_power_of_two());
    }

    #[test]
    fn lock_failure_returns_original_error_and_releases_reservation() {
        let mut address = std::ptr::null_mut();
        let error = allocate_with_lock(page_size(), |ptr, size| {
            address = ptr;
            // SAFETY: callback receives a fresh allocation valid for size bytes.
            assert!(
                unsafe { std::slice::from_raw_parts(ptr.cast::<u8>(), size) }
                    .iter()
                    .all(|&b| b == 0)
            );
            Err(io::Error::from_raw_os_error(1453)) // ERROR_WORKING_SET_QUOTA
        })
        .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(1453));
        // Reserving at the old base succeeds only if rollback released it.
        // SAFETY: address is used as an allocation hint, never dereferenced.
        let reserved = unsafe { VirtualAlloc(address, page_size(), MEM_RESERVE, PAGE_READWRITE) };
        assert_eq!(reserved, address);
        // SAFETY: newly reserved allocation is owned here and contains no secrets.
        unsafe { release(NonNull::new(reserved.cast()).unwrap()) };
    }

    #[test]
    fn allocation_failure_does_not_attempt_lock() {
        let error = allocate_with_lock(usize::MAX, |_, _| panic!("lock after allocation failure"))
            .unwrap_err();
        assert!(error.raw_os_error().is_some());
    }
}
