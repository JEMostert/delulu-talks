//! Opt-in rewrite context, per-request instructions and protected code
//! blocks (`src/rewriteContext.ts`, `src/rewriteInstructions.ts`).

use delulu_core::DomainError;
use serde_json::Value;

use crate::js;
use crate::plain_error;
use crate::types::MagicRewriteContext;

use super::TextPart;

/// Validate opt-in context without truncating or altering selected source text.
pub fn normalize_rewrite_context(value: Option<&Value>) -> Result<Option<MagicRewriteContext>, DomainError> {
    let source = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(source)) => source,
        Some(_) => return Err(plain_error("Rewrite context must be an object")),
    };
    const LIMITS: [(&str, usize); 3] = [("language", 80), ("fileType", 80), ("selection", 4000)];
    if source.keys().any(|key| !LIMITS.iter().any(|(name, _)| name == key)) {
        return Err(plain_error("Rewrite context contains an unknown field"));
    }
    let mut result = MagicRewriteContext::default();
    for (key, limit) in LIMITS {
        let Some(field) = source.get(key) else { continue };
        let Some(field) = field.as_str() else {
            return Err(plain_error(format!("Rewrite context {key} must be a string")));
        };
        if js::utf16_len(field) > limit {
            return Err(plain_error(format!("Rewrite context {key} exceeds {limit} characters")));
        }
        let normalized = if key == "selection" { field } else { js::trim(field) };
        if !normalized.is_empty() {
            let slot = match key {
                "language" => &mut result.language,
                "fileType" => &mut result.file_type,
                _ => &mut result.selection,
            };
            *slot = Some(normalized.to_owned());
        }
    }
    Ok((result != MagicRewriteContext::default()).then_some(result))
}

/// Same UTF-16 length unit as HTML maxLength and the worker protocol.
pub const MAX_REWRITE_INSTRUCTIONS: usize = 4_000;

/// Instructions belong to one request; never normalize them into settings.
pub fn validate_rewrite_instructions(value: Option<&Value>) -> Result<String, DomainError> {
    match value {
        None => Ok(String::new()),
        Some(Value::String(text)) if js::utf16_len(text) > MAX_REWRITE_INSTRUCTIONS => {
            Err(plain_error("Rewrite instructions are limited to 4,000 characters."))
        }
        Some(Value::String(text)) => Ok(text.clone()),
        Some(_) => Err(plain_error("Rewrite instructions must be text.")),
    }
}

fn blank(line: &str) -> bool {
    line.bytes().all(|byte| byte == b' ' || byte == b'\t')
}

/// Partition text without changing any character or line ending. Fenced blocks and
/// contiguous four-space/tab-indented code are protected, including unterminated
/// fences and trailing blank lines after indented code. No source is interpreted.
pub fn split_technical_blocks(text: &str) -> Vec<TextPart> {
    let bytes = text.as_bytes();
    let mut blocks = Vec::new();
    let mut fence: Option<(u8, usize)> = None;
    let mut indented = false;
    let mut offset = 0;
    let mut block_start = 0;
    let mut block_protected: Option<bool> = None;

    while offset < bytes.len() {
        let line_start = offset;
        while offset < bytes.len() && bytes[offset] != b'\r' && bytes[offset] != b'\n' {
            offset += 1;
        }
        let line = &text[line_start..offset];
        if bytes.get(offset) == Some(&b'\r') {
            offset += 1;
            if bytes.get(offset) == Some(&b'\n') {
                offset += 1;
            }
        } else if bytes.get(offset) == Some(&b'\n') {
            offset += 1;
        }

        let line_bytes = line.as_bytes();
        let is_protected;
        if let Some((character, length)) = fence {
            is_protected = true;
            // Count a closing fence directly; no regex grows with the opening run.
            let mut cursor = 0;
            while cursor < 3 && line_bytes.get(cursor) == Some(&b' ') {
                cursor += 1;
            }
            let run_start = cursor;
            while line_bytes.get(cursor) == Some(&character) {
                cursor += 1;
            }
            if cursor - run_start >= length && blank(&line[cursor..]) {
                fence = None;
            }
        } else {
            let indent = line_bytes.iter().take(4).take_while(|&&byte| byte == b' ').count();
            let run = line_bytes.get(indent).copied().filter(|&c| indent <= 3 && (c == b'`' || c == b'~'));
            let run_length = run.map_or(0, |c| line_bytes[indent..].iter().take_while(|&&byte| byte == c).count());
            if let (Some(character), true) = (run, run_length >= 3) {
                fence = Some((character, run_length));
                indented = false;
                is_protected = true;
            } else if line.starts_with("    ") || line.starts_with('\t') {
                indented = true;
                is_protected = true;
            } else if indented && blank(line) {
                is_protected = true;
            } else {
                indented = false;
                is_protected = false;
            }
        }

        match block_protected {
            None => block_protected = Some(is_protected),
            Some(current) if current != is_protected => {
                blocks.push(TextPart::new(&text[block_start..line_start], current));
                block_start = line_start;
                block_protected = Some(is_protected);
            }
            _ => {}
        }
    }
    if let Some(current) = block_protected {
        blocks.push(TextPart::new(&text[block_start..], current));
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn context_is_validated_without_altering_the_selection() {
        let context = normalize_rewrite_context(Some(&json!({"language": " rust ", "selection": "  x  "}))).unwrap().unwrap();
        assert_eq!(context.language.as_deref(), Some("rust"));
        assert_eq!(context.selection.as_deref(), Some("  x  "));
        assert_eq!(normalize_rewrite_context(Some(&json!({"fileType": "  "}))).unwrap(), None);
        assert!(normalize_rewrite_context(Some(&json!({"other": "x"}))).is_err());
        assert!(normalize_rewrite_context(Some(&json!([]))).is_err());
        assert!(validate_rewrite_instructions(Some(&json!("x".repeat(4001)))).is_err());
    }

    #[test]
    fn code_blocks_are_protected_byte_for_byte() {
        let text = "Intro\r\n```js\r\nlet a;\r\n```\r\nMiddle\n    code\n\nafter\n~~~~\nopen";
        let blocks = split_technical_blocks(text);
        assert_eq!(blocks.iter().map(|b| b.text.as_str()).collect::<String>(), text);
        let shape: Vec<_> = blocks.iter().map(|b| (b.text.as_str(), b.protected)).collect();
        assert_eq!(
            shape,
            [
                ("Intro\r\n", false),
                ("```js\r\nlet a;\r\n```\r\n", true),
                ("Middle\n", false),
                ("    code\n\n", true),
                ("after\n", false),
                ("~~~~\nopen", true),
            ]
        );
    }
}
