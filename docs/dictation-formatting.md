# Dictation formatting

The default `preserve` mode uses the existing custom word personalization exactly. Optional `spoken` mode recognizes explicit commands in English (`en`) and Dutch (`nl`). Other languages retain the existing personalization behavior.

English commands are `insert comma`, `insert period`, `insert question mark`, `insert exclamation mark`, `insert colon`, `insert semicolon`, `insert new line`, and `insert new paragraph`.

Dutch commands are `voeg komma in`, `voeg punt in`, `voeg vraagteken in`, `voeg uitroepteken in`, `voeg dubbele punt in`, `voeg puntkomma in`, `voeg nieuwe regel in`, and `voeg nieuwe alinea in`.

Matching is case insensitive and respects Unicode word boundaries. Only spaces adjacent to inserted punctuation or line breaks are normalized. Formatting does not infer punctuation from pauses, capitalize words, or rewrite content. Custom correction rules apply once to ordinary text. Custom shortcut triggers expand to their saved blocks; saved blocks are copied without formatting or correction.

Balanced straight or curly quoted spans and balanced inline or fenced backtick spans remain literal, including command phrases inside them. Apostrophes within words remain ordinary prose. This is literal delimiter protection, not a Markdown or programming language parser. Raw recognition text remains separate from the formatted delivery text.

These examples are illustrative inputs and expected formatting, not recorded dictation or native inference evidence:

| Language | Before                                    | After                                               |
| -------- | ----------------------------------------- | --------------------------------------------------- |
| English  | `hello insert comma world insert period`  | `hello, world.`                                     |
| Dutch    | `hallo voeg komma in wereld voeg punt in` | `hallo, wereld.`                                    |
| English  | `first insert new line second`            | `first` followed by one line break, then `second`   |
| Dutch    | `eerste voeg nieuwe alinea in tweede`     | `eerste` followed by two line breaks, then `tweede` |
| English  | `say “insert comma” insert period`        | `say “insert comma”.`                               |

Real dictation examples and hardware validation remain queued. Checks have not been run for this implementation under the current issues-only instruction.
