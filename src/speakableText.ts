/**
 * Turn coding-agent output into words worth hearing: drop code blocks and
 * markdown syntax, and say paths, identifiers and operators as words. It runs
 * before markup parsing, so voice tags such as `[laugh]` and `<whisper>` pass
 * through unchanged.
 */

/** Spoken once for each run of consecutive fenced code blocks. */
export const CODE_OMITTED = "Code omitted.";

/** File extensions spoken as words; other known ones are spelled out. */
const EXTENSION_WORDS: Record<string, string> = {
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  html: "HTML",
  css: "CSS",
  txt: "text",
  lock: "lock",
  log: "log",
  env: "env",
  conf: "conf",
  config: "config",
  java: "Java",
  swift: "Swift",
  kt: "K T",
  go: "Go",
  vue: "Vue",
  svelte: "Svelte",
};
const SPELLED_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "md",
  "mdx",
  "rs",
  "sh",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "rb",
  "php",
  "sql",
  "csv",
  "xml",
  "svg",
  "png",
  "jpg",
  "gif",
  "pdf",
  "wav",
  "mp3",
  "ini",
  "cfg",
  "pem",
  "zip",
  "gz",
  "dll",
  "so",
]);
/** Directory abbreviations a person would expand. */
const DIRECTORY_WORDS: Record<string, string> = {
  src: "source",
  tmp: "temp",
  pkg: "package",
  cfg: "config",
};

// Private-use markers that cannot occur in agent text.
const HOLD = "";
const HOLD_PATTERN = /(\d+)/g;

function extensionWords(extension: string): string | null {
  const lower = extension.toLowerCase();
  if (EXTENSION_WORDS[lower]) return EXTENSION_WORDS[lower];
  if (SPELLED_EXTENSIONS.has(lower))
    return lower.toUpperCase().split("").join(" ");
  return null;
}

/** Acronyms kept in capitals inside SCREAMING_CASE, where every word is. */
const ACRONYMS = new Set([
  "API",
  "CLI",
  "CPU",
  "CSS",
  "CUDA",
  "GPU",
  "HTML",
  "HTTP",
  "JSON",
  "LLM",
  "MCP",
  "SDK",
  "SQL",
  "TTS",
  "URL",
  "XML",
]);

/** camelCase, PascalCase, snake_case and SCREAMING_CASE as separate words. */
function splitIdentifier(identifier: string, kebab = false): string {
  const screaming = !/[a-z]/.test(identifier);
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(kebab ? /[_\s-]+/ : /[_\s]+/)
    .filter(Boolean)
    .map((part) =>
      // Capital runs inside camelCase are acronyms: XMLHttpRequest.
      (
        screaming
          ? part.length <= 2 || ACRONYMS.has(part)
          : /^[A-Z0-9]{2,4}$/.test(part)
      )
        ? part
        : part.toLowerCase(),
    )
    .join(" ");
}

function isIdentifier(token: string): boolean {
  return (
    /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*[A-Za-z0-9]$/.test(token) ||
    /^[a-z]+[A-Z][A-Za-z0-9]*$/.test(token) ||
    /^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$/.test(token)
  );
}

/** One path segment or file name: "useWorkspace.ts" → "use workspace dot T S". */
function speakFileName(name: string): string {
  const parts = name.split(".");
  const extension =
    parts.length > 1 ? extensionWords(parts[parts.length - 1]) : null;
  const stem = extension ? parts.slice(0, -1) : parts;
  const spoken = stem
    .filter(Boolean)
    .map((part) => DIRECTORY_WORDS[part] ?? splitIdentifier(part, true));
  if (extension) spoken.push(extension);
  // A leading dot is a hidden file: ".env" → "dot env".
  return (name.startsWith(".") ? "dot " : "") + spoken.join(" dot ");
}

function isFileName(token: string): boolean {
  const match = /^\.?[\w-]+(?:\.[\w-]+)*\.([A-Za-z0-9]{1,6})$/.exec(token);
  return !!match && extensionWords(match[1]) !== null;
}

/** "and/or" is prose; a path has a root, two slashes or a file name. */
function isPath(token: string): boolean {
  if (!/^(?:~|\.{1,2})?\/?(?:[\w@.-]+\/)+[\w@.-]*$/.test(token)) return false;
  if (!/\w\/|\/\w/.test(token)) return false;
  return (
    /^[~./]/.test(token) ||
    (token.match(/\//g) ?? []).length >= 2 ||
    isFileName(token.slice(token.lastIndexOf("/") + 1))
  );
}

function speakPath(path: string): string {
  const segments = path
    .replace(/^\.\//, "")
    .replace(/^~\//, "home/")
    .split("/")
    .filter((segment) => segment && segment !== ".");
  return segments
    .map((segment) => (segment === ".." ? "up" : speakFileName(segment)))
    .join(" slash ");
}

function speakHost(url: string): string {
  let host: string;
  try {
    host = new URL(url.startsWith("www.") ? `https://${url}` : url).hostname;
  } catch {
    return url;
  }
  return host
    .replace(/^www\./, "")
    .split(".")
    .join(" dot ");
}

/** Say one whitespace-separated token; punctuation around it is kept. */
function speakToken(token: string, code = false): string {
  if (token.includes(HOLD)) return token;
  const match = /^([("'“‘*]*)(.*?)([)"'”’.,;:!?*]*)$/.exec(token);
  if (!match || !match[2]) return token;
  const [, before, core, after] = match;
  let spoken = core;
  if (/^v?\d+(?:\.\d+){2,}$/.test(core) || /^v\d+(?:\.\d+)+$/.test(core))
    spoken = `${core.startsWith("v") ? "version " : ""}${core.replace(/^v/, "").split(".").join(" dot ")}`;
  else if (/^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}$/.test(core))
    spoken = core.slice(0, 7).split("").join(" ");
  else if (isPath(core)) spoken = speakPath(core);
  else if (/:\d+(?::\d+)?$/.test(core) && isPath(core.replace(/:[\d:]+$/, "")))
    spoken = `${speakPath(core.replace(/:[\d:]+$/, ""))} line ${/:(\d+)/.exec(core)![1]}`;
  else if (isFileName(core) || /^\.[A-Za-z][\w.-]*$/.test(core))
    spoken = speakFileName(core);
  else if (isIdentifier(core) || (code && /^[A-Za-z][\w-]*$/.test(core)))
    spoken = splitIdentifier(core, code);
  return before + spoken + after;
}

function speakWords(text: string, code = false): string {
  return text.replace(/\S+/g, (token) => speakToken(token, code));
}

const OPERATORS: [RegExp, string][] = [
  [/\s*(?:->|→|=>)\s*/g, " to "],
  [/\s*!==?\s*/g, " is not "],
  [/\s*===?\s*/g, " equals "],
  [/\s*&&\s*/g, " and "],
  [/\s*\|\|\s*/g, " or "],
  [/\s+<=\s+/g, " at most "],
  [/\s+>=\s+/g, " at least "],
];

function speakOperators(text: string): string {
  return OPERATORS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  );
}

/** End a heading or list item with a period so speech pauses after it. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return !trimmed || /[.!?:;…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function speakLine(line: string): string {
  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) return "";
  // Table separator rows carry no words; other rows become comma lists.
  if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line))
    return "";
  if (/^\s*\|.*\|\s*$/.test(line))
    return sentence(
      line
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(", "),
    );
  const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) return sentence(heading[1]);
  const quoted = line.replace(/^\s*(?:>\s?)+/, "");
  const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(quoted);
  return item ? sentence(item[1]) : quoted;
}

export function speakableText(input: string): string {
  const held: string[] = [];
  const hold = (value: string) => `${HOLD}${held.push(value) - 1}${HOLD}`;
  let text = input.replace(/\r\n?/g, "\n");
  // Fenced code blocks, including an unclosed final block.
  text = text.replace(
    /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm,
    "",
  );
  text = text.replace(/(?:\s*)*/g, `\n${CODE_OMITTED}\n`);
  // Images first, then links keep their label; autolinks lose their brackets.
  text = text.replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "");
  text = text.replace(/\[([^\]\n]+)\]\([^)\s]+(?:\s+"[^"\n]*")?\)/g, "$1");
  text = text.replace(/<((?:https?:\/\/|www\.)[^>\s]+)>/g, "$1");
  text = text.split("\n").map(speakLine).join("\n");
  // Voice tags pass through untouched.
  text = text.replace(
    /\\?\[[A-Za-z][A-Za-z0-9 _.-]{0,30}\]|(?<!\w)<\/?[A-Za-z][A-Za-z_-]{1,23}\s*>/g,
    hold,
  );
  text = text
    .replace(/\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~/g, "$1$2$3")
    .replace(/(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, "$1")
    .replace(/(?<!\w)_(?!\s)([^_\n]+?)_(?!\w)/g, "$1");
  text = text.replace(/\b(?:https?:\/\/|www\.)[^\s)>\]"']+/g, (url) => {
    const trailing = /[.,;:!?]*$/.exec(url)![0];
    return (
      hold(speakHost(url.slice(0, url.length - trailing.length))) + trailing
    );
  });
  // Inline code: brackets and separators carry no words when spoken.
  text = text.replace(/`+([^`\n]+?)`+/g, (_match, code: string) =>
    hold(
      speakWords(
        speakOperators(code.trim())
          .replace(/[()[\]{}<>;,]+/g, " ")
          .replace(/(\w):(?=\w)/g, "$1 "),
        true,
      ),
    ),
  );
  text = speakWords(speakOperators(text));
  text = text
    .replace(/[\p{Extended_Pictographic}️‍]/gu, "")
    .replace(HOLD_PATTERN, (_match, index: string) => held[Number(index)]);
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ +([.,;:!?])/g, "$1")
    .replace(/ *\n+ */g, "\n")
    .trim();
}
