//! Prints the input devices the app can record from: `cargo run -p delulu-audio --example list`.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for d in delulu_audio::list_inputs()? {
        println!("{}\t{}{}", d.id, d.name, if d.is_default { "\t(default)" } else { "" });
    }
    Ok(())
}
