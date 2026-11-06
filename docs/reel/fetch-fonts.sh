#!/bin/bash
# fetch-fonts.sh : download the reel's fonts (SIL Open Font License 1.1) from google/fonts and cut
# the static instances the reel uses. They are the app's own typefaces: Bricolage Grotesque for
# the interface and Newsreader for transcripts. Needs fonttools: plain python3 if it has it,
# otherwise uv runs it in a throwaway environment.
set -eu
R=$(cd "$(dirname "$0")" && pwd); mkdir -p "$R/fonts"; cd "$R/fonts"
G=https://raw.githubusercontent.com/google/fonts/main/ofl
curl -sSfL -o Bricolage.ttf "$G/bricolagegrotesque/BricolageGrotesque%5Bopsz,wdth,wght%5D.ttf"
curl -sSfL -o Newsreader.ttf "$G/newsreader/Newsreader%5Bopsz,wght%5D.ttf"
curl -sSfL -o Newsreader-Italic.ttf "$G/newsreader/Newsreader-Italic%5Bopsz,wght%5D.ttf"
curl -sSfL -o OFL-Bricolage.txt "$G/bricolagegrotesque/OFL.txt"
curl -sSfL -o OFL-Newsreader.txt "$G/newsreader/OFL.txt"
if python3 -c 'import fontTools' 2>/dev/null; then FT=(python3 -m fontTools.varLib.instancer)
else FT=(uv run -q --no-project --with fonttools python -m fontTools.varLib.instancer); fi
"${FT[@]}" -q Bricolage.ttf opsz=96 wdth=75 wght=800 -o Display.ttf
"${FT[@]}" -q Bricolage.ttf opsz=14 wdth=100 wght=500 -o UI.ttf
"${FT[@]}" -q Bricolage.ttf opsz=14 wdth=100 wght=700 -o UIBold.ttf
"${FT[@]}" -q Newsreader.ttf opsz=72 wght=430 -o Text.ttf
"${FT[@]}" -q Newsreader-Italic.ttf opsz=72 wght=380 -o Spoken.ttf
rm Bricolage.ttf Newsreader.ttf Newsreader-Italic.ttf
ls "$R/fonts"
