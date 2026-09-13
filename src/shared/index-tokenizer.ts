/**
 * Tokenize text the same way the D1 FTS5 index does (`unicode61` tokenizer with
 * `remove_diacritics 2`): uppercase, diacritics stripped, split on anything that
 * isn't a letter or digit.
 */
export function tokenizeIndexText(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}
