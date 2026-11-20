fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/macos/desktop.m");
        cc::Build::new()
            .file("src/macos/desktop.m")
            .flag("-fobjc-arc")
            .compile("desktop");
        for framework in ["AppKit", "Carbon", "ApplicationServices"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
}
