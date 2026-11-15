//! Pure logic for Delulu Talks. Nothing in this crate does I/O, reads clocks or
//! spawns threads: callers pass time in and carry out the returned effects. That
//! keeps every rule here testable with plain values.

pub mod dictation;
pub mod gesture;
pub mod gpu;

#[cfg(test)]
pub(crate) mod rng;
