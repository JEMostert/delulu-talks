//! The dictation pipeline that the Delulu Talks app and the daemon share.
//!
//! `delulu-core` decides *what* happens (the state machine, the hotkey gesture).
//! This crate does the work in between, without knowing whether it runs in the
//! window or in the daemon:
//!
//! * [`stop`]: from the recorded clip to delivered text and a History entry;
//! * [`context`]: what the last dictation was about, carried to the next one;
//! * [`cleanup`]: what the cleanup model's answer means for the text.

pub mod cleanup;
pub mod context;
pub mod stop;
