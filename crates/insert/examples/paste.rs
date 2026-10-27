use delulu_insert::{Inserter, PasteKey};
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let text = args
        .next()
        .ok_or("usage: paste TEXT shift-insert|ctrl-v|ctrl-shift-v")?;
    let key = match args.next().as_deref() {
        Some("shift-insert") => PasteKey::ShiftInsert,
        Some("ctrl-v") => PasteKey::CtrlV,
        Some("ctrl-shift-v") => PasteKey::CtrlShiftV,
        _ => return Err("expected shift-insert, ctrl-v or ctrl-shift-v".into()),
    };
    let data_dir = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".local/share"))
        })
        .ok_or("XDG_DATA_HOME and HOME are unset")?
        .join("delulu-talks");
    let token_path = data_dir.join("paste-example-token");
    let token = std::fs::read_to_string(&token_path)
        .ok()
        .filter(|token| !token.is_empty());
    let inserter = Inserter::new(
        token,
        Box::new(move |token| {
            if let Some(token) = token {
                if let Err(error) = std::fs::create_dir_all(&data_dir)
                    .and_then(|_| std::fs::write(&token_path, token))
                {
                    eprintln!("Could not save portal restore token: {error}");
                }
            }
        }),
    );
    let status = inserter.prepare().await;
    if !status.ready {
        return Err(status
            .error
            .unwrap_or_else(|| "Portal unavailable".into())
            .into());
    }
    eprintln!("Focus the target window within 3 seconds...");
    tokio::time::sleep(Duration::from_secs(3)).await;
    println!("{:?}", inserter.insert(&text, key).await?);
    Ok(())
}
