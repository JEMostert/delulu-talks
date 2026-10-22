//! `delulu-talks restore-profile …`: validates (default) or restores a profile
//! backup into a new isolated directory. Replaces `scripts/profile-restore.mjs`;
//! see docs/PROFILE_RECOVERY.md.

use std::path::PathBuf;

use delulu_data::profile_restore::{restore_profile_backup, validate_profile_backup, ProfileRestoreRequest};
use serde_json::{json, Value};

pub const SUBCOMMAND: &str = "restore-profile";
const USAGE: &str = "delulu-talks restore-profile --backup <completed snapshot> --target <new isolated directory> [--source-profile <original profile>] [--settings-only] [--restore]";

pub fn run(args: Vec<String>) -> i32 {
    if args.iter().any(|arg| arg == "--help") {
        println!("{USAGE}");
        return 0;
    }
    let (mut backup, mut target, mut source) = (None, None, None);
    let (mut restore, mut settings_only) = (false, false);
    let mut iter = args.into_iter();
    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--restore" => restore = true,
            "--settings-only" => settings_only = true,
            "--backup" | "--target" | "--source-profile" => {
                let Some(value) = iter.next().filter(|value| !value.starts_with("--")) else {
                    eprintln!("{USAGE}");
                    return 2;
                };
                let slot = match flag.as_str() {
                    "--backup" => &mut backup,
                    "--target" => &mut target,
                    _ => &mut source,
                };
                *slot = Some(PathBuf::from(value));
            }
            _ => {
                eprintln!("{USAGE}");
                return 2;
            }
        }
    }
    let (Some(backup_directory), Some(target_directory)) = (backup, target) else {
        eprintln!("{USAGE}");
        return 2;
    };
    let request = ProfileRestoreRequest {
        backup_directory,
        target_directory,
        source_profile_directory: source,
        allow_settings_only: settings_only,
    };
    let result = if restore { restore_profile_backup(&request) } else { validate_profile_backup(&request) };
    match result {
        Ok(plan) => {
            let mut output = json!({ "outcome": if restore { "restored" } else { "dry-run" } });
            if let (Value::Object(output), Ok(Value::Object(plan))) = (&mut output, serde_json::to_value(&plan)) {
                output.extend(plan);
            }
            println!("{}", serde_json::to_string_pretty(&output).unwrap_or_default());
            0
        }
        Err(error) => {
            eprintln!("{}", serde_json::to_string_pretty(&json!({ "outcome": "failed", "message": error.message, "causes": [] })).unwrap_or_default());
            1
        }
    }
}
