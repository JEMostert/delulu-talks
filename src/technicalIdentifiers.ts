/** Explicit identifier styles; ordinary prose is never interpreted as an identifier. */
export type IdentifierStyle = 'camel' | 'pascal' | 'snake' | 'kebab' | 'literal';

const spokenDigits: Record<string, string> = {
  zero: '0', nul: '0', one: '1', een: '1', één: '1',
  two: '2', twee: '2', three: '3', drie: '3', four: '4', vier: '4',
  five: '5', vijf: '5', six: '6', zes: '6', seven: '7', zeven: '7',
  eight: '8', acht: '8', nine: '9', negen: '9',
};

const letter = /^\p{L}\p{M}*$/u;
const word = /^(?:\p{L}\p{M}*|\p{N})+$/u;
const identifier = /^[\p{L}_][\p{L}\p{M}\p{N}_]*$/u;
const kebabIdentifier = /^\p{L}[\p{L}\p{M}\p{N}]*(?:-[\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*$/u;

/**
 * Build an identifier from an explicitly requested body, or return null without guessing.
 * Words use NFC Unicode letters/marks/numbers separated by spaces or tabs. Acronyms are
 * normalized like other words: "HTTP client" becomes "httpClient" or "HttpClient".
 * Literal spelling accepts individual letters/digits, EN/NL digit names, underscore /
 * laag streepje, and capital X / hoofdletter X. Whole words are deliberately refused.
 */
export function parseTechnicalIdentifier(body: string, style: IdentifierStyle): string | null {
  if (body.length > 1024 || /[\r\n]/u.test(body)) return null;
  const normalized = body.normalize('NFC').replace(/^[ \t]+|[ \t]+$/g, '');
  if (!normalized) return null;
  const tokens = normalized.split(/[ \t]+/u);
  let result: string;

  if (style === 'literal') {
    const characters: string[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const lower = token.toLowerCase();
      if (lower === 'capital' || lower === 'hoofdletter') {
        const next = tokens[index + 1];
        if (!next || !letter.test(next)) return null;
        characters.push(next.toUpperCase());
        index += 1;
      } else if (lower === 'underscore' || token === '_') {
        characters.push('_');
      } else if (lower === 'laag' && tokens[index + 1]?.toLowerCase() === 'streepje') {
        characters.push('_');
        index += 1;
      } else if (Object.prototype.hasOwnProperty.call(spokenDigits, lower)) {
        characters.push(spokenDigits[lower]);
      } else if (letter.test(token) || /^[0-9]$/u.test(token)) {
        characters.push(token);
      } else {
        return null;
      }
    }
    result = characters.join('');
  } else {
    if (!tokens.every((token) => word.test(token))) return null;
    const words = tokens.map((token) => token.toLowerCase());
    const capitalize = (token: string): string => {
      const characters = Array.from(token);
      return characters[0].toUpperCase() + characters.slice(1).join('');
    };
    switch (style) {
      case 'camel':
        result = words[0] + words.slice(1).map(capitalize).join('');
        break;
      case 'pascal':
        result = words.map(capitalize).join('');
        break;
      case 'snake':
        result = words.join('_');
        break;
      case 'kebab':
        result = words.join('-');
        break;
      default:
        return null;
    }
  }
  return (style === 'kebab' ? kebabIdentifier : identifier).test(result) ? result : null;
}

/** Render only complete, explicitly delimited single-line identifier commands. */
export function renderIdentifierCommands(text: string): string {
  const styles: Record<string, IdentifierStyle> = {
    'camel case': 'camel', 'pascal case': 'pascal',
    'snake case': 'snake', 'kebab case': 'kebab', 'literal spelling': 'literal',
  };
  const commands = /(^|[^\p{L}\p{M}\p{N}_])(camel[ \t]+case|pascal[ \t]+case|snake[ \t]+case|kebab[ \t]+case|literal[ \t]+spelling)[ \t]+([^\r\n]*?)[ \t]+(?:end[ \t]+identifier|einde[ \t]+naam)(?=$|[^\p{L}\p{M}\p{N}_])/giu;
  return text.replace(commands, (match: string, prefix: string, marker: string, body: string) => {
    const style = styles[marker.toLowerCase().replace(/[ \t]+/g, ' ')];
    const parsed = parseTechnicalIdentifier(body, style);
    return parsed === null ? match : prefix + parsed;
  });
}
