//! Play an audio file through the station player and report its position.
//! `cargo run -p delulu-radio --example play -- <file.wav|flac> [seconds] [volume]`
use delulu_radio::{audio, Player, PlayerEvent};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: play <file> [seconds] [volume]");
    let seconds: f64 = args.next().map_or(5.0, |s| s.parse().expect("seconds"));
    let volume: f32 = args.next().map_or(0.5, |s| s.parse().expect("volume"));
    let started = Instant::now();
    let audio = audio::decode(path.as_ref()).expect("decode");
    let checks = audio::check(&audio, 1.0).expect("checks");
    println!(
        "decoded {:.1} s at {} Hz in {} ms, peak {:.2}",
        checks.seconds,
        audio.rate,
        started.elapsed().as_millis(),
        checks.peak
    );
    let player = Player::new(|event| match event {
        PlayerEvent::Ended(id) => println!("ended {id}"),
        PlayerEvent::Failed(e) => println!("failed: {e}"),
    });
    player.set_volume(volume);
    player.play("track", Arc::new(audio));
    let start = Instant::now();
    while start.elapsed().as_secs_f64() < seconds {
        std::thread::sleep(Duration::from_secs(1));
        if let Some(p) = player.position() {
            println!("{:.1}/{:.1} s", p.seconds, p.total);
        }
    }
    player.pause();
    std::thread::sleep(Duration::from_millis(300));
    let paused = player.position().map(|p| p.seconds);
    std::thread::sleep(Duration::from_secs(1));
    println!(
        "paused at {paused:?}, still {:?}",
        player.position().map(|p| p.seconds)
    );
}
