// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `delulu-talks mcp …` serves the voice MCP server or runs its CLI,
    // without starting the app.
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some(delulu_voice::MCP_SUBCOMMAND) {
        let code = delulu_voice::run_cli_with(args.collect(), &delulu_talks_lib::cli_paths());
        std::process::exit(code);
    }
    delulu_talks_lib::run()
}
