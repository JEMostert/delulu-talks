use delulu_hotkey::{Hotkey, DEFAULT_TRIGGER};

#[tokio::main]
async fn main() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let (hotkey, status) = Hotkey::bind(
        DEFAULT_TRIGGER,
        tx,
        Box::new(|status| println!("Status: {status:?}")),
    )
    .await;
    println!("Status: {status:?}");
    if let Some(hotkey) = hotkey {
        while let Some(event) = rx.recv().await {
            println!("{:?} {event:?}", std::time::SystemTime::now());
        }
        hotkey.close().await;
    }
}
