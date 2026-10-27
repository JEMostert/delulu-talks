use delulu_audio::{Recorder, SAMPLE_RATE};
use std::{
    error::Error,
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let mut device = None;
    let mut seconds = 3;
    while let Some(arg) = args.next() {
        if arg == "--device" {
            device = Some(args.next().ok_or("missing device ID")?);
        } else {
            seconds = arg.parse()?;
        }
    }
    let recorder = Recorder::new();
    let start = Instant::now();
    let printed = Arc::new(AtomicBool::new(false));
    recorder.start(
        device.as_deref(),
        Box::new(move |_| {
            if !printed.swap(true, Ordering::Relaxed) {
                println!(
                    "start latency: {:.1} ms",
                    start.elapsed().as_secs_f64() * 1000.0
                );
            }
        }),
    )?;
    std::thread::sleep(Duration::from_secs(seconds));
    let clip = recorder.stop()?;
    let mut file = std::fs::File::create("clip.wav")?;
    let size = (clip.samples.len() * 2) as u32;
    file.write_all(b"RIFF")?;
    file.write_all(&(36 + size).to_le_bytes())?;
    file.write_all(b"WAVEfmt ")?;
    file.write_all(&16u32.to_le_bytes())?;
    file.write_all(&1u16.to_le_bytes())?;
    file.write_all(&1u16.to_le_bytes())?;
    file.write_all(&SAMPLE_RATE.to_le_bytes())?;
    file.write_all(&(SAMPLE_RATE * 2).to_le_bytes())?;
    file.write_all(&2u16.to_le_bytes())?;
    file.write_all(&16u16.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&size.to_le_bytes())?;
    for sample in &clip.samples {
        file.write_all(&((*sample * i16::MAX as f32) as i16).to_le_bytes())?;
    }
    println!(
        "clip.wav: {} ms, RMS {:.5}, peak {:.5}",
        clip.duration_ms(),
        clip.rms,
        clip.peak
    );
    Ok(())
}
