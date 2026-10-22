// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `delulu-talks mcp …` serves the voice MCP server or runs its CLI,
    // without starting the app.
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some(delulu_voice::MCP_SUBCOMMAND) => {
            std::process::exit(delulu_voice::run_cli_with(args.collect(), &delulu_talks_lib::cli_paths()))
        }
        Some(delulu_talks_lib::restore_cli::SUBCOMMAND) => std::process::exit(delulu_talks_lib::restore_cli::run(args.collect())),
        #[cfg(target_os = "linux")]
        Some(delulu_talks_lib::appimage::VERSION_FLAG) => return delulu_talks_lib::appimage::print_webkit_version(),
        _ => {}
    }
    delulu_talks_lib::run()
}
