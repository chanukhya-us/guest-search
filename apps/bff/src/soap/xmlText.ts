/**
 * Work-around for xmlbuilder2 ampersand handling (found by property P1, task 4.4).
 *
 * xmlbuilder2 4.x escapes `&` in text and attribute values only when it does NOT start
 * something that looks like a reference (`/&(?![A-Za-z]+;|#\d+;)/`). A value such as
 * `&amp;`, `&lt;` or `&#0;` is therefore written verbatim and read back as `&`, `<` or a
 * malformed document: user text could inject entity and character references.
 *
 * Replacing every `&` with `&amp;` before handing the value to `.txt()` / `.att()` makes
 * every ampersand look like a reference, so xmlbuilder2 leaves them all alone and the
 * serialized value decodes to exactly the input. xmlbuilder2 still escapes `<`, `>` and `"`.
 * If a future xmlbuilder2 escapes `&` unconditionally, P1 fails on double escaping.
 */
export const xmlValue = (value: string): string => value.replace(/&/g, '&amp;');
