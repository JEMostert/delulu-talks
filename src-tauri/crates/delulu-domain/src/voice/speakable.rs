//! Turn coding-agent output into words worth hearing: drop code blocks and
//! markdown syntax, and say paths, identifiers and operators as words. It runs
//! before markup parsing, so voice tags such as `[laugh]` and `<whisper>` pass
//! through unchanged.

use regex::{Captures, Regex};

use crate::js;

/// Spoken once for each run of consecutive fenced code blocks.
pub const CODE_OMITTED: &str = "Code omitted.";

/// File extensions spoken as words; other known ones are spelled out.
fn extension_word(lower: &str) -> Option<&'static str> {
    Some(match lower {
        "json" => "JSON",
        "yaml" | "yml" => "YAML",
        "toml" => "TOML",
        "html" => "HTML",
        "css" => "CSS",
        "txt" => "text",
        "lock" => "lock",
        "log" => "log",
        "env" => "env",
        "conf" => "conf",
        "config" => "config",
        "java" => "Java",
        "swift" => "Swift",
        "kt" => "K T",
        "go" => "Go",
        "vue" => "Vue",
        "svelte" => "Svelte",
        _ => return None,
    })
}

const SPELLED_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "md", "mdx", "rs", "sh", "c", "h", "cpp", "hpp", "cs", "rb", "php", "sql",
    "csv", "xml", "svg", "png", "jpg", "gif", "pdf", "wav", "mp3", "ini", "cfg", "pem", "zip", "gz", "dll", "so",
];

/// Directory abbreviations a person would expand.
fn directory_word(part: &str) -> Option<&'static str> {
    Some(match part {
        "src" => "source",
        "tmp" => "temp",
        "pkg" => "package",
        "cfg" => "config",
        _ => return None,
    })
}

// Private-use markers that cannot occur in agent text.
const HOLD: char = '\u{E000}';
const CODE_MARK: char = '\u{E001}';

fn extension_words(extension: &str) -> Option<String> {
    let lower = extension.to_lowercase();
    if let Some(word) = extension_word(&lower) {
        return Some(word.to_owned());
    }
    SPELLED_EXTENSIONS.contains(&lower.as_str()).then(|| {
        lower.to_uppercase().chars().map(String::from).collect::<Vec<_>>().join(" ")
    })
}

/// Acronyms kept in capitals inside SCREAMING_CASE, where every word is.
const ACRONYMS: &[&str] =
    &["API", "CLI", "CPU", "CSS", "CUDA", "GPU", "HTML", "HTTP", "JSON", "LLM", "MCP", "SDK", "SQL", "TTS", "URL", "XML"];

regexes! {
    LOWERCASE = r"[a-z]", "";
    CAMEL_BOUNDARY = r"([a-z0-9])([A-Z])", "g";
    ACRONYM_BOUNDARY = r"([A-Z]+)([A-Z][a-z])", "g";
    KEBAB_SEPARATORS = r"[_\s-]+", "";
    SNAKE_SEPARATORS = r"[_\s]+", "";
    CAMEL_ACRONYM = r"^[A-Z0-9]{2,4}$", "";
    SNAKE_IDENTIFIER = r"^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*[A-Za-z0-9]$", "";
    CAMEL_IDENTIFIER = r"^[a-z]+[A-Z][A-Za-z0-9]*$", "";
    PASCAL_IDENTIFIER = r"^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$", "";
    FILE_NAME = r"^\.?[\w-]+(?:\.[\w-]+)*\.([A-Za-z0-9]{1,6})$", "";
    PATH_SHAPE = r"^(?:~|\.{1,2})?\/?(?:[\w@.-]+\/)+[\w@.-]*$", "";
    PATH_SLASH = r"\w\/|\/\w", "";
    PATH_ROOT = r"^[~./]", "";
    TOKEN = r#"^([("'“‘*]*)(.*?)([)"'”’.,;:!?*]*)$"#, "";
    VERSION_LONG = r"^v?\d+(?:\.\d+){2,}$", "";
    VERSION_PREFIXED = r"^v\d+(?:\.\d+)+$", "";
    LINE_SUFFIX = r":\d+(?::\d+)?$", "";
    LINE_SUFFIX_STRIP = r":[\d:]+$", "";
    FIRST_LINE = r":(\d+)", "";
    HIDDEN_FILE = r"^\.[A-Za-z][\w.-]*$", "";
    CODE_WORD = r"^[A-Za-z][\w-]*$", "";
    NON_SPACE = r"\S+", "g";
    ARROW = r"\s*(?:->|→|=>)\s*", "g";
    NOT_EQUAL = r"\s*!==?\s*", "g";
    EQUAL = r"\s*===?\s*", "g";
    AND = r"\s*&&\s*", "g";
    OR = r"\s*\|\|\s*", "g";
    AT_MOST = r"\s+<=\s+", "g";
    AT_LEAST = r"\s+>=\s+", "g";
    SENTENCE_END = r"[.!?:;…]$", "";
    TABLE_SEPARATOR = r"^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$", "";
    TABLE_ROW = r"^\s*\|.*\|\s*$", "";
    HEADING = r"^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$", "";
    QUOTE_MARKERS = r"^\s*(?:>\s?)+", "";
    LIST_ITEM = r"^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$", "";
    CRLF = r"\r\n?", "g";
    CODE_RUN = "\u{e001}(?:\\s*\u{e001})*", "g";
    IMAGE = r"!\[[^\]\n]*\]\([^)\n]*\)", "g";
    LINK = r#"\[([^\]\n]+)\]\([^)\s]+(?:\s+"[^"\n]*")?\)"#, "g";
    AUTOLINK = r"<((?:https?:\/\/|www\.)[^>\s]+)>", "g";
    // `(?<!\w)` before the angle-bracket alternative is checked in `hold_tags`.
    VOICE_TAG = r"\\?\[[A-Za-z][A-Za-z0-9 _.-]{0,30}\]|<\/?[A-Za-z][A-Za-z_-]{1,23}\s*>", "g";
    STRONG = r"\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~", "g";
    // `(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])`: look-ahead consumed outside `m`.
    EMPHASIS_STAR = r"(?P<m>\*(?P<g>[^*\s][^*\n]*?)\*)(?:[^\w*]|$)", "g";
    // `(?<!\w)_(?!\s)([^_\n]+?)_(?!\w)`.
    EMPHASIS_UNDERSCORE = r"(?P<m>_(?P<g>[^_\s][^_\n]*?)_)(?:\W|$)", "g";
    URL = r#"\b(?:https?:\/\/|www\.)[^\s)>\]"']+"#, "g";
    URL_TRAILING = r"[.,;:!?]*$", "";
    INLINE_CODE = r"`+([^`\n]+?)`+", "g";
    CODE_BRACKETS = r"[()[\]{}<>;,]+", "g";
    // `(\w):(?=\w)`.
    CODE_COLON = r"(?P<m>(\w):)\w", "g";
    PICTOGRAPHS = r"[\p{Extended_Pictographic}\u{fe0f}\u{200d}]", "gu";
    HELD = "\u{e000}(\\d+)\u{e000}", "g";
    SPACES = r"[^\S\n]+", "g";
    SPACE_BEFORE_PUNCTUATION = r" +([.,;:!?])", "g";
    BLANK_LINES = r" *\n+ *", "g";
}

fn is_word_char(ch: Option<char>) -> bool {
    ch.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// camelCase, PascalCase, snake_case and SCREAMING_CASE as separate words.
fn split_identifier(identifier: &str, kebab: bool) -> String {
    let screaming = !LOWERCASE.is_match(identifier);
    let spaced = CAMEL_BOUNDARY.replace_all(identifier, "${1} ${2}");
    let spaced = ACRONYM_BOUNDARY.replace_all(&spaced, "${1} ${2}");
    let separators: &Regex = if kebab { &KEBAB_SEPARATORS } else { &SNAKE_SEPARATORS };
    separators
        .split(&spaced)
        .filter(|part| !part.is_empty())
        .map(|part| {
            // Capital runs inside camelCase are acronyms: XMLHttpRequest.
            let keep = if screaming {
                js::utf16_len(part) <= 2 || ACRONYMS.contains(&part)
            } else {
                CAMEL_ACRONYM.is_match(part)
            };
            if keep { part.to_owned() } else { part.to_lowercase() }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_identifier(token: &str) -> bool {
    SNAKE_IDENTIFIER.is_match(token) || CAMEL_IDENTIFIER.is_match(token) || PASCAL_IDENTIFIER.is_match(token)
}

/// One path segment or file name: "useWorkspace.ts" → "use workspace dot T S".
fn speak_file_name(name: &str) -> String {
    let parts: Vec<&str> = name.split('.').collect();
    let extension = if parts.len() > 1 { extension_words(parts[parts.len() - 1]) } else { None };
    let stem = if extension.is_some() { &parts[..parts.len() - 1] } else { &parts[..] };
    let mut spoken: Vec<String> = stem
        .iter()
        .filter(|part| !part.is_empty())
        .map(|part| directory_word(part).map_or_else(|| split_identifier(part, true), str::to_owned))
        .collect();
    spoken.extend(extension);
    // A leading dot is a hidden file: ".env" → "dot env".
    format!("{}{}", if name.starts_with('.') { "dot " } else { "" }, spoken.join(" dot "))
}

fn is_file_name(token: &str) -> bool {
    FILE_NAME.captures(token).is_some_and(|found| extension_words(&found[1]).is_some())
}

/// "and/or" is prose; a path has a root, two slashes or a file name.
fn is_path(token: &str) -> bool {
    if !PATH_SHAPE.is_match(token) || !PATH_SLASH.is_match(token) {
        return false;
    }
    PATH_ROOT.is_match(token)
        || token.matches('/').count() >= 2
        || is_file_name(&token[token.rfind('/').map_or(0, |at| at + 1)..])
}

fn speak_path(path: &str) -> String {
    let path = path.strip_prefix("./").unwrap_or(path);
    let path = match path.strip_prefix("~/") {
        Some(rest) => format!("home/{rest}"),
        None => path.to_owned(),
    };
    path.split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .map(|segment| if segment == ".." { "up".to_owned() } else { speak_file_name(segment) })
        .collect::<Vec<_>>()
        .join(" slash ")
}

fn speak_host(url: &str) -> String {
    let absolute = if url.starts_with("www.") { format!("https://{url}") } else { url.to_owned() };
    let Some(host) = url::Url::parse(&absolute).ok().and_then(|parsed| parsed.host_str().map(str::to_owned)) else {
        return url.to_owned();
    };
    host.strip_prefix("www.").unwrap_or(&host).split('.').collect::<Vec<_>>().join(" dot ")
}

/// An abbreviated commit hash: 7–40 lowercase hex digits with a digit and a letter.
fn is_commit(core: &str) -> bool {
    (7..=40).contains(&core.len())
        && core.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && core.bytes().any(|b| b.is_ascii_digit())
        && core.bytes().any(|b| b.is_ascii_lowercase())
}

/// Say one whitespace-separated token; punctuation around it is kept.
fn speak_token(token: &str, code: bool) -> String {
    if token.contains(HOLD) {
        return token.to_owned();
    }
    let Some(found) = TOKEN.captures(token) else { return token.to_owned() };
    let (before, core, after) = (&found[1], &found[2], &found[3]);
    if core.is_empty() {
        return token.to_owned();
    }
    let spoken = if VERSION_LONG.is_match(core) || VERSION_PREFIXED.is_match(core) {
        let prefix = if core.starts_with('v') { "version " } else { "" };
        let digits = core.strip_prefix('v').unwrap_or(core);
        format!("{prefix}{}", digits.split('.').collect::<Vec<_>>().join(" dot "))
    } else if is_commit(core) {
        core[..7].chars().map(String::from).collect::<Vec<_>>().join(" ")
    } else if is_path(core) {
        speak_path(core)
    } else if LINE_SUFFIX.is_match(core) && is_path(&LINE_SUFFIX_STRIP.replace(core, "")) {
        let line = FIRST_LINE.captures(core).map_or_else(String::new, |found| found[1].to_owned());
        format!("{} line {line}", speak_path(&LINE_SUFFIX_STRIP.replace(core, "")))
    } else if is_file_name(core) || HIDDEN_FILE.is_match(core) {
        speak_file_name(core)
    } else if is_identifier(core) || (code && CODE_WORD.is_match(core)) {
        split_identifier(core, code)
    } else {
        core.to_owned()
    };
    format!("{before}{spoken}{after}")
}

fn speak_words(text: &str, code: bool) -> String {
    NON_SPACE.replace_all(text, |found: &Captures| speak_token(&found[0], code)).into_owned()
}

fn speak_operators(text: &str) -> String {
    let operators: [(&Regex, &str); 7] = [
        (&ARROW, " to "),
        (&NOT_EQUAL, " is not "),
        (&EQUAL, " equals "),
        (&AND, " and "),
        (&OR, " or "),
        (&AT_MOST, " at most "),
        (&AT_LEAST, " at least "),
    ];
    operators
        .iter()
        .fold(text.to_owned(), |result, (pattern, replacement)| pattern.replace_all(&result, *replacement).into_owned())
}

/// End a heading or list item with a period so speech pauses after it.
fn sentence(text: &str) -> String {
    let trimmed = js::trim(text);
    if trimmed.is_empty() || SENTENCE_END.is_match(trimmed) {
        trimmed.to_owned()
    } else {
        format!("{trimmed}.")
    }
}

/// `^\s*([-*_])(?:\s*\1){2,}\s*$`: three or more of one rule character.
fn is_rule(line: &str) -> bool {
    let mut marks = line.chars().filter(|c| !js::is_whitespace(*c));
    let Some(first) = marks.next() else { return false };
    matches!(first, '-' | '*' | '_') && {
        let rest: Vec<char> = marks.collect();
        rest.len() >= 2 && rest.iter().all(|c| *c == first)
    }
}

fn speak_line(line: &str) -> String {
    if is_rule(line) {
        return String::new();
    }
    // Table separator rows carry no words; other rows become comma lists.
    if TABLE_SEPARATOR.is_match(line) {
        return String::new();
    }
    if TABLE_ROW.is_match(line) {
        let cells: Vec<&str> = line.split('|').map(js::trim).filter(|cell| !cell.is_empty()).collect();
        return sentence(&cells.join(", "));
    }
    if let Some(heading) = HEADING.captures(line) {
        return sentence(&heading[1]);
    }
    let quoted = QUOTE_MARKERS.replace(line, "");
    match LIST_ITEM.captures(&quoted) {
        Some(item) => sentence(&item[1]),
        None => quoted.into_owned(),
    }
}

fn is_line_terminator(ch: Option<char>) -> bool {
    matches!(ch, Some('\n' | '\r' | '\u{2028}' | '\u{2029}'))
}

/// `^[ \t]*` then the fence run (three or more backticks or tildes), when a
/// line break follows somewhere after it. Returns the fence and the offset
/// after the first line break.
fn opening_fence(text: &str, start: usize) -> Option<(&str, usize)> {
    let rest = &text[start..];
    let indent = rest.len() - rest.trim_start_matches([' ', '\t']).len();
    let fence_char = rest[indent..].chars().next().filter(|c| *c == '`' || *c == '~')?;
    let run = rest[indent..].len() - rest[indent..].trim_start_matches(fence_char).len();
    if run < 3 {
        return None;
    }
    let fence = &rest[indent..indent + run];
    let newline = rest[indent + run..].find('\n')? + start + indent + run;
    Some((fence, newline + 1))
}

/// `^[ \t]*FENCE[ \t]*$` at a line start; returns the end of the match.
fn closing_fence(text: &str, start: usize, fence: &str) -> Option<usize> {
    let rest = &text[start..];
    let after_indent = rest.trim_start_matches([' ', '\t']);
    let after_fence = after_indent.strip_prefix(fence)?;
    let after_space = after_fence.trim_start_matches([' ', '\t']);
    let end = text.len() - after_space.len();
    (after_space.is_empty() || is_line_terminator(after_space.chars().next())).then_some(end)
}

fn line_start(text: &str, at: usize) -> bool {
    at == 0 || is_line_terminator(js::char_before(text, at))
}

/// Fenced code blocks, including an unclosed final block, become one marker each:
/// `/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm`.
fn mark_code_blocks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut position = 0;
    while position < text.len() {
        let opened = if line_start(text, position) { opening_fence(text, position) } else { None };
        let Some((fence, body)) = opened else {
            position = js::next_boundary(text, position);
            continue;
        };
        let mut end = text.len();
        let mut cursor = body;
        while cursor < text.len() {
            if line_start(text, cursor) {
                if let Some(close) = closing_fence(text, cursor, fence) {
                    end = close;
                    break;
                }
            }
            cursor = js::next_boundary(text, cursor);
        }
        out.push_str(&text[copied..position]);
        out.push(CODE_MARK);
        copied = end;
        position = end;
        if position == text.len() {
            break;
        }
    }
    out.push_str(&text[copied..]);
    out
}

pub fn speakable_text(input: &str) -> String {
    let mut held: Vec<String> = Vec::new();
    let mut hold = |value: String| {
        held.push(value);
        format!("{HOLD}{}{HOLD}", held.len() - 1)
    };
    let text = CRLF.replace_all(input, "\n");
    let text = mark_code_blocks(&text);
    let text = CODE_RUN.replace_all(&text, format!("\n{CODE_OMITTED}\n").as_str()).into_owned();
    // Images first, then links keep their label; autolinks lose their brackets.
    let text = IMAGE.replace_all(&text, "");
    let text = LINK.replace_all(&text, "${1}");
    let text = AUTOLINK.replace_all(&text, "${1}");
    let text = text.split('\n').map(speak_line).collect::<Vec<_>>().join("\n");
    // Voice tags pass through untouched.
    let text = js::replace(
        &VOICE_TAG,
        &text,
        |found| !found[0].starts_with('<') || !is_word_char(js::char_before(&text, found.get(0).unwrap().start())),
        |found| hold(found[0].to_owned()),
    );
    let text = STRONG.replace_all(&text, "${1}${2}${3}");
    let text = js::replace(
        &EMPHASIS_STAR,
        &text,
        |found| {
            let before = js::char_before(&text, js::logical(found).start());
            !is_word_char(before) && before != Some('*')
        },
        |found| found["g"].to_owned(),
    );
    let text = js::replace(
        &EMPHASIS_UNDERSCORE,
        &text,
        |found| !is_word_char(js::char_before(&text, js::logical(found).start())),
        |found| found["g"].to_owned(),
    );
    let text = URL
        .replace_all(&text, |found: &Captures| {
            let url = &found[0];
            let trailing = URL_TRAILING.find(url).map_or("", |m| m.as_str());
            hold(speak_host(&url[..url.len() - trailing.len()])) + trailing
        })
        .into_owned();
    // Inline code: brackets and separators carry no words when spoken.
    let text = INLINE_CODE
        .replace_all(&text, |found: &Captures| {
            let code = speak_operators(js::trim(&found[1]));
            let code = CODE_BRACKETS.replace_all(&code, " ");
            let code = js::replace(&CODE_COLON, &code, js::always, |colon| format!("{} ", &colon[2]));
            hold(speak_words(&code, true))
        })
        .into_owned();
    let text = speak_words(&speak_operators(&text), false);
    let text = PICTOGRAPHS.replace_all(&text, "");
    let text = HELD.replace_all(&text, |found: &Captures| {
        found[1].parse::<usize>().ok().and_then(|index| held.get(index).cloned()).unwrap_or_else(|| "undefined".into())
    });
    let text = SPACES.replace_all(&text, " ");
    let text = SPACE_BEFORE_PUNCTUATION.replace_all(&text, "${1}");
    let text = BLANK_LINES.replace_all(&text, "\n");
    js::trim(&text).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(input: &str, expected: &str) {
        assert_eq!(speakable_text(input), expected, "input: {input:?}");
    }

    #[test]
    fn a_realistic_agent_reply_becomes_speakable_words() {
        check(
            "Fixed `useWorkspace` in src/hooks/useWorkspace.ts — all 212 tests pass ✅",
            "Fixed use workspace in source slash hooks slash use workspace dot T S — all 212 tests pass",
        );
    }

    #[test]
    fn ordinary_prose_is_unchanged() {
        let prose = "Done. The build is green, and I merged the fix. Want me to tag a release?";
        check(prose, prose);
        check("Use it and/or skip it, yes/no.", "Use it and/or skip it, yes/no.");
    }

    #[test]
    fn voice_tags_pass_through_untouched() {
        let text = "[sigh] the build still fails. <whisper>Between us</whisper> [pause] it's [clear throat] fine [laugh].";
        check(text, text);
        check("Escaped \\[laugh] stays", "Escaped \\[laugh] stays");
    }

    #[test]
    fn fenced_code_blocks_are_omitted_once_per_run() {
        check(
            "Here is the fix:\n```ts\nconst a = 1;\n```\n\n```bash\nbun test\n```\nAll green.",
            &format!("Here is the fix:\n{CODE_OMITTED}\nAll green."),
        );
        check("Start:\n~~~\nunclosed code\nmore", &format!("Start:\n{CODE_OMITTED}"));
    }

    #[test]
    fn markdown_structure_keeps_only_the_words() {
        check(
            "## Summary\n- **Fixed** the _cache_ path\n- [x] Added tests\n1. Merged\n> Quoted note\n---\n![diagram](a.png)",
            "Summary.\nFixed the cache path.\nAdded tests.\nMerged.\nQuoted note",
        );
    }

    #[test]
    fn links_keep_their_label_and_bare_urls_become_host_names() {
        check(
            "See [the release notes](https://github.com/x/y/releases) or https://www.github.com/JEMostert/delulu-talks/pull/12.",
            "See the release notes or github dot com.",
        );
        check("Docs: <https://docs.example.org/a>", "Docs: docs dot example dot org");
    }

    #[test]
    fn tables_become_comma_lists() {
        check(
            "| Test | Result |\n| --- | :---: |\n| unit | pass |\n| e2e | fail |",
            "Test, Result.\nunit, pass.\ne2e, fail.",
        );
    }

    #[test]
    fn identifiers_split_into_words() {
        check(
            "Renamed parseVoiceMarkup and MAX_RETRIES in VoiceService; set HF_TOKEN.",
            "Renamed parse voice markup and max retries in voice service; set HF token.",
        );
        check("Read `XMLHttpRequest` and `voice-bridge`.", "Read XML http request and voice bridge.");
    }

    #[test]
    fn file_names_spell_short_extensions_and_name_known_formats() {
        check(
            "Edited package.json, voiceMarkup.test.ts, README.md and ./scripts/build.sh",
            "Edited package dot JSON, voice markup dot test dot T S, readme dot M D and scripts slash build dot S H",
        );
        check("Check .env and ../config.yaml", "Check dot env and up slash config dot YAML");
    }

    #[test]
    fn versions_commits_and_operators_are_said_aloud() {
        check("Released v0.16.0 from df63b50.", "Released version 0 dot 16 dot 0 from d f 6 3 b 5 0.");
        check("It takes 3.5 seconds and 2.0.1 total", "It takes 3.5 seconds and 2 dot 0 dot 1 total");
        check("`a !== b && c == d || e -> f`", "a is not b and c equals d or e to f");
    }

    #[test]
    fn emoji_are_dropped_and_whitespace_is_tidy() {
        check("  Shipped 🚀   it!  \n\n\n Next ✅ ", "Shipped it!\nNext");
    }

    #[test]
    fn abbreviations_and_ordinary_punctuation_stay() {
        let text = "E.g. this, i.e. that... Mr. Smith said 3/4 passed at 75%.";
        check(text, text);
    }

    #[test]
    fn inline_code_drops_brackets_and_separators() {
        check("Run `bun run test:unit` then `useState<number>(0)`.", "Run bun run test unit then use state number 0.");
    }

    #[test]
    fn paths_with_a_line_number_say_the_line() {
        check("See electron/services/main.ts:1169.", "See electron slash services slash main dot T S line 1169.");
    }

    #[test]
    fn generic_types_and_comparisons_in_prose_stay_readable() {
        check("Returns Array<string> when x >= 3.", "Returns Array<string> when x at least 3.");
    }

    #[test]
    fn tags_at_the_start_of_a_list_item_survive() {
        check("- [laugh] that worked", "[laugh] that worked.");
    }
}

