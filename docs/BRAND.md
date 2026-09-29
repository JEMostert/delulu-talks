# Delulu Talks identity

The voice current is an abstract ocean-blue speech mark: a continuous rounded outline and three unequal voice pulses. It connects speaking to text without depending on a microphone illustration. The navy tile is the application icon; the mark also works on its own with transparency.

![Voice mark, icon, small sizes, and palette](assets/brand-preview.png)

## Assets

| Asset                                           | Purpose                                                     |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `public/delulu-talks-icon.svg`                  | Editable app icon master, also used in the renderer/favicon |
| `public/delulu-talks-mark.svg`                  | Transparent editable voice-mark master                      |
| `build/icon.png`, `.ico`, `.icns`               | Native Linux, Windows, and Mac app icons                    |
| `build/tray.png`                                | Transparent color tray icon                                 |
| `build/trayTemplate.png`, `trayTemplate@2x.png` | Monochrome transparent Mac menu-bar templates               |
| `docs/assets/readme-header.svg`                 | Editable repository banner                                  |
| `docs/assets/brand-preview.svg`                 | Portable presentation with embedded vector copies           |

Colors: foam `#75E4FF`, current `#32BAFF`, ocean `#237BFF`, and depth `#071E34`. The gradient is for the mark; interface controls should continue using semantic theme colors with independently verified contrast. Do not use pale blue for small text on white.

Keep the mark's aspect ratio. Leave clear space around it of at least one pulse width; the icon tile supplies its own padding. Use the color master at 24 px or larger where possible. Inspect 16 px use in the actual launcher; a future simplified micro-mark must be validated before replacing it. Mac menu-bar assets use template rendering so the system selects the appropriate monochrome appearance.

## Rebuild native assets

Install `rsvg-convert` and Pillow, then run:

```sh
python3 scripts/build-brand-assets.py
```

The script renders icons and previews from the editable vector masters. It generates multiple ICO/ICNS resolutions and both Mac tray scales. The presentation embeds vector snapshots for portability; the build script refreshes those copies from the masters. Logo rendering uses vectors and standard rasterization, so no image-generation service or tracing step is required.
