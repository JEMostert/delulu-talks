//! Spells out what Supertonic would misread, per language. The model reads raw
//! characters, so "v1.5.0" came out as "van Impton 5-ton norm" and "src/main.rs" as
//! "Sursje Mijnerres" in the spike. Numbers, versions, file names, issue numbers,
//! units, abbreviations and acronyms become words here; the model's own
//! preprocessing (NFKD, quotes, dashes, emoji) still runs afterwards.
use crate::Lang;
use regex::{Captures, Regex};
use std::sync::LazyLock;

macro_rules! re {
    ($name:ident, $pattern:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pattern).expect($pattern));
    };
}

re!(MD_LINK, r"\[([^\]]+)\]\([^)\s]*\)");
re!(URL, r"\bhttps?://(?:www\.)?([A-Za-z0-9.-]+)[^\s)]*");
re!(FLAG, r"(^|[\s(])--?([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\b");
re!(VERSION_V, r"\b[vV](\d+(?:\.\d+){1,3})\b");
re!(VERSION_DOTS, r"\b(\d+(?:\.\d+){2,3})\b");
re!(
    FILE,
    r"(?:\b|\./|~/)((?:[\w.-]+/)*)([\w-]+(?:\.[\w-]+)*)\.(rs|ts|tsx|js|jsx|mjs|json|jsonl|md|toml|py|yaml|yml|txt|sh|lock|wav|css|html|go|c|h|cpp|hpp|log|sql|lua|rb|java|kt|swift|onnx|gguf|zip|tar|gz|pdf|png|jpg|svg|desktop|service|conf|ini|env|csv)\b"
);
re!(ISSUE, r"#(\d+)\b");
re!(ISO_DATE, r"\b(\d{4})-(\d{2})-(\d{2})\b");
re!(THOUSANDS_EN, r"\b(\d{1,3}(?:,\d{3})+)\b");
re!(ORDINAL_EN, r"\b(\d+)(st|nd|rd|th)\b");
re!(ORDINAL_NL, r"\b(\d+)(e|ste|de)\b");
re!(PERCENT, r"(\d+(?:[.,]\d+)?)\s?%");
re!(
    UNIT,
    r"\b(\d+(?:[.,]\d+)?)\s?(GB|MB|KB|TB|GiB|MiB|ms|kHz|Hz|fps|px)\b"
);
re!(TIMES, r"\b(\d+)x\b");
re!(CLOCK, r"\b(\d{1,2}):(\d{2})\b");
re!(RANGE, r"\b(\d+)\s?[-–]\s?(\d+)\b");
re!(DECIMAL_DOT, r"\b(\d+)\.(\d+)\b");
re!(DECIMAL_COMMA, r"\b(\d+),(\d+)\b");
re!(INTEGER, r"\b\d+\b");
re!(CAMEL, r"([a-z])([A-Z])");
re!(ACRONYM, r"\b([A-Z]{2,6})(s?)\b");
re!(CALL_PARENS, r"\(\)");
re!(SPACES, r"\s+");

const MONTHS: [(&str, &str); 12] = [
    ("January", "januari"),
    ("February", "februari"),
    ("March", "maart"),
    ("April", "april"),
    ("May", "mei"),
    ("June", "juni"),
    ("July", "juli"),
    ("August", "augustus"),
    ("September", "september"),
    ("October", "oktober"),
    ("November", "november"),
    ("December", "december"),
];

fn en_number(n: u64) -> String {
    const ONES: [&str; 20] = [
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
    ];
    const TENS: [&str; 10] = [
        "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
    ];
    let join = |head: String, rest: u64| {
        if rest == 0 {
            head
        } else {
            format!("{head} {}", en_number(rest))
        }
    };
    match n {
        0..=19 => ONES[n as usize].into(),
        20..=99 => {
            let tens = TENS[(n / 10) as usize];
            if n.is_multiple_of(10) {
                tens.into()
            } else {
                format!("{tens}-{}", ONES[(n % 10) as usize])
            }
        }
        100..=999 => join(format!("{} hundred", ONES[(n / 100) as usize]), n % 100),
        1_000..=999_999 => join(format!("{} thousand", en_number(n / 1_000)), n % 1_000),
        1_000_000..=999_999_999 => join(
            format!("{} million", en_number(n / 1_000_000)),
            n % 1_000_000,
        ),
        _ => digits(n, Lang::En),
    }
}

fn nl_number(n: u64) -> String {
    const ONES: [&str; 20] = [
        "nul",
        "één",
        "twee",
        "drie",
        "vier",
        "vijf",
        "zes",
        "zeven",
        "acht",
        "negen",
        "tien",
        "elf",
        "twaalf",
        "dertien",
        "veertien",
        "vijftien",
        "zestien",
        "zeventien",
        "achttien",
        "negentien",
    ];
    const TENS: [&str; 10] = [
        "", "", "twintig", "dertig", "veertig", "vijftig", "zestig", "zeventig", "tachtig",
        "negentig",
    ];
    // Inside a compound "één" loses its accents: eenentwintig, eenhonderd.
    let unit = |u: u64| if u == 1 { "een" } else { ONES[u as usize] };
    match n {
        0..=19 => ONES[n as usize].into(),
        20..=99 => {
            let (tens, u) = (TENS[(n / 10) as usize], n % 10);
            if u == 0 {
                tens.into()
            } else {
                let u = unit(u);
                let link = if u.ends_with('e') { "ën" } else { "en" };
                format!("{u}{link}{tens}")
            }
        }
        100..=999 => {
            let head = if n / 100 == 1 {
                "honderd".to_string()
            } else {
                format!("{}honderd", unit(n / 100))
            };
            if n.is_multiple_of(100) {
                head
            } else {
                format!("{head}{}", nl_number(n % 100))
            }
        }
        1_000..=999_999 => {
            let k = n / 1_000;
            let head = if k == 1 {
                "duizend".to_string()
            } else {
                format!("{}duizend", nl_number(k).replace("één", "een"))
            };
            if n.is_multiple_of(1_000) {
                head
            } else {
                format!("{head} {}", nl_number(n % 1_000))
            }
        }
        1_000_000..=999_999_999 => {
            let head = format!("{} miljoen", nl_number(n / 1_000_000));
            if n.is_multiple_of(1_000_000) {
                head
            } else {
                format!("{head} {}", nl_number(n % 1_000_000))
            }
        }
        _ => digits(n, Lang::Nl),
    }
}

/// Very long numbers (ids, hashes) are read digit by digit.
fn digits(n: u64, lang: Lang) -> String {
    n.to_string()
        .chars()
        .map(|c| number(c.to_digit(10).unwrap_or(0) as u64, lang))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn number(n: u64, lang: Lang) -> String {
    match lang {
        Lang::Nl => nl_number(n),
        Lang::En => en_number(n),
    }
}

fn number_str(s: &str, lang: Lang) -> String {
    // Leading zeros ("007", "0.05") and overlong numbers are read digit by digit.
    if s.len() > 1 && s.starts_with('0') || s.len() > 9 {
        return s
            .chars()
            .map(|c| number(c.to_digit(10).unwrap_or(0) as u64, lang))
            .collect::<Vec<_>>()
            .join(" ");
    }
    number(s.parse().unwrap_or(0), lang)
}

fn ordinal(n: u64, lang: Lang) -> String {
    match lang {
        Lang::En => {
            let word = en_number(n);
            let (head, last) = match word.rfind([' ', '-']) {
                Some(i) => (&word[..=i], &word[i + 1..]),
                None => ("", word.as_str()),
            };
            let last = match last {
                "one" => "first".to_string(),
                "two" => "second".into(),
                "three" => "third".into(),
                "five" => "fifth".into(),
                "eight" => "eighth".into(),
                "nine" => "ninth".into(),
                "twelve" => "twelfth".into(),
                w if w.ends_with('y') => format!("{}ieth", &w[..w.len() - 1]),
                w => format!("{w}th"),
            };
            format!("{head}{last}")
        }
        Lang::Nl => match n {
            1 => "eerste".into(),
            3 => "derde".into(),
            8 => "achtste".into(),
            n if n < 20 => format!("{}de", nl_number(n)),
            n => format!("{}ste", nl_number(n)),
        },
    }
}

/// Spaced capitals make Supertonic say the letter names, in the chunk's language.
fn spell(s: &str) -> String {
    s.chars()
        .map(|c| c.to_uppercase().to_string())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Acronyms said as words, with the spelling each language's reading needs.
fn word_acronym(acronym: &str, lang: Lang) -> Option<&'static str> {
    let (en, nl) = match acronym {
        "JSON" => ("jason", "djeesson"),
        "YAML" => ("yammel", "jemmel"),
        "TOML" => ("tommel", "tommel"),
        "NASA" => ("NASA", "NASA"),
        "WAV" => ("wave", "wav"),
        "RAM" => ("ram", "ram"),
        "ROM" => ("rom", "rom"),
        "ASCII" => ("askie", "askie"),
        "GIF" => ("gif", "gif"),
        "JPEG" => ("jaypeg", "jeepeg"),
        "LAN" => ("lan", "lan"),
        "WASM" => ("wasm", "wasm"),
        "GUI" => ("gooey", "goewie"),
        "ONNX" => ("onix", "onniks"),
        "GGUF" => ("G G U F", "G G U F"),
        "OK" => ("okay", "oké"),
        "FM" => ("F M", "F M"),
        "README" => ("read me", "riedmie"),
        _ => return None,
    };
    Some(if lang == Lang::Nl { nl } else { en })
}

fn extension(ext: &str, lang: Lang) -> String {
    let nl = lang == Lang::Nl;
    match ext.to_ascii_lowercase().as_str() {
        "json" => word_acronym("JSON", lang).unwrap_or("json").into(),
        "jsonl" => format!("{} L", word_acronym("JSON", lang).unwrap_or("json")),
        "toml" => "tommel".into(),
        "yaml" | "yml" => word_acronym("YAML", lang).unwrap_or("yaml").into(),
        "md" => "markdown".into(),
        "txt" => {
            if nl {
                "tekst".into()
            } else {
                "text".into()
            }
        }
        "lock" => "lock".into(),
        "log" => "log".into(),
        "wav" => word_acronym("WAV", lang).unwrap_or("wav").into(),
        "go" => "go".into(),
        "desktop" => "desktop".into(),
        "service" => "service".into(),
        "conf" => "conf".into(),
        "env" => "env".into(),
        "zip" => "zip".into(),
        "onnx" => word_acronym("ONNX", lang).unwrap_or("onnx").into(),
        other => spell(other),
    }
}

/// Path components read aloud; a few common folder names get their full word.
fn path_words(path: &str, lang: Lang) -> String {
    path.split('/')
        .filter(|p| !p.is_empty() && *p != "." && *p != "~")
        .map(|p| match p {
            "src" => "source".to_string(),
            "docs" => "docs".into(),
            p => words_of_identifier(p, lang),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `delulu_speak-test` → "delulu speak test"; digits inside stay for later passes.
fn words_of_identifier(id: &str, _lang: Lang) -> String {
    id.replace(['_', '-', '.'], " ")
}

pub fn normalize(text: &str, lang: Lang) -> String {
    let nl = lang == Lang::Nl;
    let dot = if nl { "punt" } else { "point" };
    let file_dot = if nl { "punt" } else { "dot" };
    let mut t = text.to_string();

    // Markdown an agent may leave in: links, emphasis, code spans, headings, bullets.
    t = MD_LINK.replace_all(&t, "$1").into_owned();
    t = t
        .replace("**", "")
        .replace("__", " ")
        .replace("```", " ")
        .replace('`', "");
    t = t.trim_start_matches(['#', ' ']).to_string();
    for marker in ["- ", "* ", "• "] {
        if let Some(rest) = t.strip_prefix(marker) {
            t = rest.to_string();
        }
    }

    // Links: only the site's name is worth hearing.
    t = URL
        .replace_all(&t, |c: &Captures| {
            c[1].trim_end_matches('.')
                .replace('.', &format!(" {file_dot} "))
        })
        .into_owned();
    // CLI flags: say the name, not the dashes.
    t = FLAG
        .replace_all(&t, |c: &Captures| {
            format!("{}{}", &c[1], c[2].replace('-', " "))
        })
        .into_owned();

    // Versions: "v1.5.0" → "version one point five point zero"; also bare "2.3.1".
    let version_word = if nl { "versie" } else { "version" };
    let version = |v: &str| {
        v.split('.')
            .map(|p| number_str(p, lang))
            .collect::<Vec<_>>()
            .join(&format!(" {dot} "))
    };
    t = VERSION_V
        .replace_all(&t, |c: &Captures| {
            let start = c.get(0).map_or(0, |m| m.start());
            let before = t[..start].trim_end().to_lowercase();
            if before.ends_with(version_word)
                || before.ends_with("version")
                || before.ends_with("versie")
            {
                version(&c[1])
            } else {
                format!("{version_word} {}", version(&c[1]))
            }
        })
        .into_owned();
    t = VERSION_DOTS
        .replace_all(&t, |c: &Captures| version(&c[1]))
        .into_owned();

    // File names, with an optional path: "src/main.rs" → "source main dot R S".
    t = FILE
        .replace_all(&t, |c: &Captures| {
            let path = path_words(&c[1], lang);
            let name = words_of_identifier(&c[2], lang);
            let spoken = format!("{name} {file_dot} {}", extension(&c[3], lang));
            if path.is_empty() {
                spoken
            } else {
                format!("{path} {spoken}")
            }
        })
        .into_owned();

    // ISO dates: "2026-11-15" → "15 november 2026", before ranges can split them.
    t = ISO_DATE
        .replace_all(&t, |c: &Captures| {
            let month: usize = c[2].parse().unwrap_or(0);
            let day: u64 = c[3].parse().unwrap_or(0);
            match MONTHS.get(month.wrapping_sub(1)) {
                Some((en, nl_month)) if (1..=31).contains(&day) => {
                    let year = number_str(&c[1], lang);
                    if nl {
                        format!("{} {nl_month} {year}", number(day, lang))
                    } else {
                        format!("{en} {}, {year}", ordinal(day, lang))
                    }
                }
                _ => c[0].to_string(),
            }
        })
        .into_owned();

    // Issue and pull request numbers.
    let number_word = if nl { "nummer" } else { "number" };
    t = ISSUE
        .replace_all(&t, |c: &Captures| {
            format!("{number_word} {}", number_str(&c[1], lang))
        })
        .into_owned();

    if !nl {
        t = THOUSANDS_EN
            .replace_all(&t, |c: &Captures| c[1].replace(',', ""))
            .into_owned();
        t = ORDINAL_EN
            .replace_all(&t, |c: &Captures| ordinal(c[1].parse().unwrap_or(0), lang))
            .into_owned();
    } else {
        t = ORDINAL_NL
            .replace_all(&t, |c: &Captures| ordinal(c[1].parse().unwrap_or(0), lang))
            .into_owned();
    }

    let decimal = |s: &str| -> String {
        match s.split_once(['.', ',']) {
            Some((int, frac)) => {
                let sep = if nl {
                    if s.contains(',') {
                        "komma"
                    } else {
                        "punt"
                    }
                } else {
                    "point"
                };
                format!(
                    "{} {sep} {}",
                    number_str(int, lang),
                    frac.chars()
                        .map(|d| number(d.to_digit(10).unwrap_or(0) as u64, lang))
                        .collect::<Vec<_>>()
                        .join(" ")
                )
            }
            None => number_str(s, lang),
        }
    };
    t = PERCENT
        .replace_all(&t, |c: &Captures| {
            format!(
                "{} {}",
                decimal(&c[1]),
                if nl { "procent" } else { "percent" }
            )
        })
        .into_owned();
    t = UNIT
        .replace_all(&t, |c: &Captures| {
            let unit = match (&c[2], nl) {
                ("GB" | "GiB", _) => "gigabyte",
                ("MB" | "MiB", _) => "megabyte",
                ("KB", _) => "kilobyte",
                ("TB", _) => "terabyte",
                ("ms", true) => "milliseconden",
                ("ms", false) => "milliseconds",
                ("kHz", _) => "kilohertz",
                ("Hz", _) => "hertz",
                ("fps", true) => "beelden per seconde",
                ("fps", false) => "frames per second",
                ("px", _) => "pixels",
                _ => "",
            };
            format!("{} {unit}", decimal(&c[1]))
        })
        .into_owned();
    t = TIMES
        .replace_all(&t, |c: &Captures| {
            format!(
                "{} {}",
                number_str(&c[1], lang),
                if nl { "keer" } else { "times" }
            )
        })
        .into_owned();
    t = CLOCK
        .replace_all(&t, |c: &Captures| {
            let (h, m) = (number_str(&c[1], lang), c[2].parse::<u64>().unwrap_or(0));
            match (nl, m) {
                (true, 0) => format!("{h} uur"),
                (true, m) => format!("{h} uur {}", number(m, lang)),
                (false, 0) => format!("{h} o'clock"),
                (false, m) if m < 10 => format!("{h} oh {}", number(m, lang)),
                (false, m) => format!("{h} {}", number(m, lang)),
            }
        })
        .into_owned();
    t = RANGE
        .replace_all(&t, |c: &Captures| {
            format!(
                "{} {} {}",
                number_str(&c[1], lang),
                if nl { "tot" } else { "to" },
                number_str(&c[2], lang)
            )
        })
        .into_owned();
    // Dutch writes decimals with a comma, so a Dutch "3.12" is a version: "drie punt
    // twaalf". English reads decimals digit by digit: "two point seven five".
    t = DECIMAL_DOT
        .replace_all(
            &t,
            |c: &Captures| if nl { version(&c[0]) } else { decimal(&c[0]) },
        )
        .into_owned();
    if nl {
        t = DECIMAL_COMMA
            .replace_all(&t, |c: &Captures| decimal(&c[0]))
            .into_owned();
    }
    t = INTEGER
        .replace_all(&t, |c: &Captures| number_str(&c[0], lang))
        .into_owned();

    // Identifiers: "getVoiceStatus()" → "get Voice Status".
    t = CALL_PARENS.replace_all(&t, "").into_owned();
    t = CAMEL.replace_all(&t, "$1 $2").into_owned();
    // Acronyms: letters, except the ones said as words. A plural "s" stays lowercase.
    t = ACRONYM
        .replace_all(&t, |c: &Captures| match word_acronym(&c[1], lang) {
            Some(word) => format!("{word}{}", &c[2]),
            // Plural acronyms take an apostrophe, as Dutch writes them: "PR's".
            None if &c[2] == "s" => format!("{}'s", spell(&c[1])),
            None => spell(&c[1]),
        })
        .into_owned();

    // Abbreviations (after the sentence splitter, which knows them).
    for (abbr, en, nl_word) in [
        ("e.g.", "for example", "bijvoorbeeld"),
        ("i.e.", "that is", "dat wil zeggen"),
        ("etc.", "et cetera", "enzovoort"),
        ("vs.", "versus", "versus"),
        ("bijv.", "for example", "bijvoorbeeld"),
        ("o.a.", "among others", "onder andere"),
        ("d.w.z.", "that is", "dat wil zeggen"),
        ("enz.", "and so on", "enzovoort"),
        ("nr.", "number", "nummer"),
        ("ca.", "about", "circa"),
        ("m.b.t.", "regarding", "met betrekking tot"),
        ("i.p.v.", "instead of", "in plaats van"),
        ("t.o.v.", "compared to", "ten opzichte van"),
        ("z.s.m.", "as soon as possible", "zo snel mogelijk"),
        ("evt.", "possibly", "eventueel"),
        ("incl.", "including", "inclusief"),
        ("excl.", "excluding", "exclusief"),
        ("m.a.w.", "in other words", "met andere woorden"),
        ("approx.", "approximately", "ongeveer"),
    ] {
        let spoken = if nl { nl_word } else { en };
        t = replace_word(&t, abbr, spoken);
    }

    // Symbols between words.
    t = t
        .replace(" & ", if nl { " en " } else { " and " })
        .replace(" + ", " plus ")
        .replace(" = ", if nl { " is " } else { " equals " })
        .replace(" -> ", " ")
        .replace(" => ", " ")
        .replace("::", " ")
        .replace(" ~", if nl { " ongeveer " } else { " about " });
    SPACES.replace_all(t.trim(), " ").into_owned()
}

/// Replaces `word` where it is not part of a longer word, ignoring case.
fn replace_word(text: &str, word: &str, with: &str) -> String {
    let lower = text.to_lowercase();
    if lower.len() != text.len() {
        // Case folding changed byte offsets (rare letters); fall back to exact case.
        return text.replace(word, with);
    }
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (i, _) in lower.match_indices(word) {
        let before = text[..i].chars().next_back();
        let after = text[i + word.len()..].chars().next();
        let bounded =
            !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric);
        if bounded && i >= last {
            out.push_str(&text[last..i]);
            out.push_str(with);
            last = i + word.len();
        }
    }
    out.push_str(&text[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use Lang::{En, Nl};

    #[test]
    fn dutch_and_english_numbers() {
        assert_eq!(nl_number(1), "één");
        assert_eq!(nl_number(21), "eenentwintig");
        assert_eq!(nl_number(23), "drieëntwintig");
        assert_eq!(nl_number(101), "honderdéén");
        assert_eq!(nl_number(519), "vijfhonderdnegentien");
        assert_eq!(nl_number(2026), "tweeduizend zesentwintig");
        assert_eq!(en_number(519), "five hundred nineteen");
        assert_eq!(en_number(42), "forty-two");
        assert_eq!(
            normalize("Commit 1234567890123 landed.", En),
            "Commit one two three four five six seven eight nine zero one two three landed."
        );
    }

    #[test]
    fn version_strings() {
        assert_eq!(
            normalize("Versie v1.5.0 staat klaar.", Nl),
            "Versie één punt vijf punt nul staat klaar."
        );
        assert_eq!(
            normalize("Release v1.5.0 is out.", En),
            "Release version one point five point zero is out."
        );
        assert_eq!(
            normalize("Version 2.3.1 fixes 17 bugs.", En),
            "Version two point three point one fixes seventeen bugs."
        );
        assert_eq!(
            normalize("Python 3.12 werkt.", Nl),
            "Python drie punt twaalf werkt."
        );
        assert_eq!(
            normalize("It is 2.75 times faster.", En),
            "It is two point seven five times faster."
        );
    }

    #[test]
    fn file_names_and_paths() {
        assert_eq!(
            normalize("I changed src/main.rs today.", En),
            "I changed source main dot R S today."
        );
        assert_eq!(
            normalize("De API geeft een 404 als config.json ontbreekt.", Nl),
            "De A P I geeft een vierhonderdvier als config punt djeesson ontbreekt."
        );
        assert_eq!(
            normalize("Edit settings.toml and README.md.", En),
            "Edit settings dot tommel and read me dot markdown."
        );
        assert_eq!(
            normalize("See crates/voice-cli/src/main.rs.", En),
            "See crates voice cli source main dot R S."
        );
    }

    #[test]
    fn digits_units_and_times() {
        assert_eq!(
            normalize("De build duurde 2 minuten en 45 seconden, 30% sneller.", Nl),
            "De build duurde twee minuten en vijfenveertig seconden, dertig procent sneller."
        );
        assert_eq!(
            normalize("It needs 8 GB at 14:30.", En),
            "It needs eight gigabyte at fourteen thirty."
        );
        assert_eq!(
            normalize("Om 9:00 begint het.", Nl),
            "Om negen uur begint het."
        );
        assert_eq!(
            normalize("It took 1,250 ms, 3x faster.", En),
            "It took one thousand two hundred fifty milliseconds, three times faster."
        );
        assert_eq!(
            normalize("Het is 2,5 keer zo snel.", Nl),
            "Het is twee komma vijf keer zo snel."
        );
        assert_eq!(
            normalize("Pages 3-5 and the 2nd test.", En),
            "Pages three to five and the second test."
        );
        assert_eq!(
            normalize("De 1e en 21ste keer.", Nl),
            "De eerste en eenentwintigste keer."
        );
        assert_eq!(
            normalize("Op 2026-11-15 klaar.", Nl),
            "Op vijftien november tweeduizend zesentwintig klaar."
        );
        assert_eq!(
            normalize("Due 2026-03-01.", En),
            "Due March first, two thousand twenty-six."
        );
    }

    #[test]
    fn issue_numbers_flags_and_acronyms() {
        assert_eq!(
            normalize("Kijk even naar PR #519, daar zit de fix voor de GPU crash in.", Nl),
            "Kijk even naar P R nummer vijfhonderdnegentien, daar zit de fix voor de G P U crash in."
        );
        assert_eq!(
            normalize(
                "PR #42 adds a CLI flag, --output, that writes the WAV file.",
                En
            ),
            "P R number forty-two adds a C L I flag, output, that writes the wave file."
        );
        assert_eq!(
            normalize("Two PRs need review.", En),
            "Two P R's need review."
        );
    }

    #[test]
    fn abbreviations() {
        assert_eq!(
            normalize("Dit geldt bijv. voor de app, o.a. de CLI.", Nl),
            "Dit geldt bijvoorbeeld voor de app, onder andere de C L I."
        );
        assert_eq!(
            normalize("Small fixes, e.g. typos, etc.", En),
            "Small fixes, for example typos, et cetera"
        );
    }

    #[test]
    fn markdown_links_and_code() {
        assert_eq!(
            normalize(
                "**Done**: see [the PR](https://github.com/x/y/pull/1) and `getVoiceStatus()`.",
                En
            ),
            "Done: see the P R and get Voice Status."
        );
        assert_eq!(
            normalize("Docs at https://www.example.org/a?b=c now.", En),
            "Docs at example dot org now."
        );
        assert_eq!(normalize("- Bullet item here", En), "Bullet item here");
    }
}
