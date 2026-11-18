//! Locking a `std::sync::Mutex` without panicking on poison.
//!
//! A mutex is poisoned when a thread panicked while holding it. The relay's
//! shared tables (connection registry, pairing allow-lists) stay usable after
//! such a panic: every write to them is a single insert or remove, so there is
//! no half-applied update to protect against. Unwrapping the poison instead
//! would turn one panic into a panic on every later lock, taking down every
//! connection, so the guard is recovered and the poisoning is logged.

use std::sync::{Mutex, MutexGuard};

/// Lock `m`, recovering the guard if a previous holder panicked.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| {
        tracing::error!("recovered a poisoned lock (a thread panicked while holding it)");
        poisoned.into_inner()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_poisoned_lock_is_recovered_with_its_data() {
        let m = Arc::new(Mutex::new(vec![1]));
        let m2 = Arc::clone(&m);
        let joined = std::thread::spawn(move || {
            let _guard = m2.lock();
            panic!("poison it");
        })
        .join();
        assert!(joined.is_err());
        assert!(m.is_poisoned());
        lock(&m).push(2);
        assert_eq!(*lock(&m), vec![1, 2]);
    }
}
