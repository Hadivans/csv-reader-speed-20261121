// Fast drop-in for make.fun's csv-reader 1.0.0.
//
// run(input) returns exactly what csv-reader 1.0.0's readCsv returns for the
// same input: {columns, rows, errors}. The reading policy is the reference's
// own (see the kit's baselines/csv-reader/vendor/csv-reader/index.js):
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next non-doubled quote, "" inside
//     is one quote, CRLF/lone CR inside reads as LF; what follows the closing
//     quote up to the next comma or line break is appended as-is (quote_junk
//     when the field ends); a quote that never closes is a literal character
//     and the text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded (short_row, with fields: its count)
//     or cut (long_row, with extra: the cut fields) to the first record's
//     width; each error is {code, line, row} in the order met, line the
//     1-based line its record starts on (counting every LF, CRLF and lone CR
//     inside quotes), row its record's index in rows, null for the header.
//
// Speed: whole fields and lines are sliced instead of built one character at
// a time. A clean record (no quote, no stray CR) is split with String.split.
// Every other field is taken with indexOf jumps. Two extra savings over a
// naive port: the record's line end is computed once and handed down (an
// unquoted field never re-scans for the next newline), and the per-field
// stray-CR scan is skipped when the record's first line holds no CR at all
// (a quoted field that spans lines re-arms it, since later lines are unchecked).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The quote scanner, shared: its lastIndex is set before every use. */
const QRE = /["\r\n]/g;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;
  // The next newline at or after pos, or n when there is none. An unquoted
  // field ends at the next comma before this, or at this newline.
  let curLineEnd = n;
  // True when the part of the current record already scanned may hold a stray
  // CR (so an unquoted field must scan for one); false when the record's first
  // line holds none.
  let recordHasCR = false;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field starting at pos, with `value` already in it
  // (the quoted content, when this is the junk after a closing quote).
  // A quote inside it is a literal character; a CR not followed by LF is
  // dropped (stray_cr). Returns the field and how it ended.
  function readUnquoted(value) {
    const cIdx = text.indexOf(',', pos);
    let end, ended;
    if (cIdx !== -1 && cIdx < curLineEnd) { end = cIdx; ended = COMMA; }
    else { end = curLineEnd; ended = curLineEnd < n ? LINE_BREAK : END; }
    // A CR right before the LF is the CRLF break, not part of the field.
    let valEnd = end;
    if (ended === LINE_BREAK && end > pos && text.charCodeAt(end - 1) === 13) valEnd = end - 1;
    const seg = text.slice(pos, valEnd);
    if (!recordHasCR || seg.indexOf('\r') === -1) {
      value += seg;
      pos = ended === END ? end : end + 1;
      if (ended === LINE_BREAK) line += 1;
      return { value, ended };
    }
    // Stray CRs in this stretch: drop each one (error), keep the rest.
    let p = pos;
    let start = pos;
    while (p < valEnd) {
      if (text.charCodeAt(p) === 13) {
        pushError('stray_cr');
        value += text.slice(start, p);
        p += 1;
        start = p;
      } else {
        p += 1;
      }
    }
    value += text.slice(start, valEnd);
    pos = ended === END ? end : end + 1;
    if (ended === LINE_BREAK) line += 1;
    return { value, ended };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const parts = [];
    let segStart = pos + 1;
    let p = pos + 1;
    let closed = false;
    QRE.lastIndex = p;
    let m;
    while ((m = QRE.exec(text)) !== null) {
      const i = m.index;
      const ch = m[0];
      if (ch === '"') {
        if (i + 1 < n && text.charCodeAt(i + 1) === 34) {
          // A doubled quote is one quote in the value.
          parts.push(text.slice(segStart, i), '"');
          QRE.lastIndex = i + 2;
          segStart = i + 2;
          continue;
        }
        parts.push(text.slice(segStart, i));
        p = i + 1;
        closed = true;
        break;
      }
      // CRLF and a lone CR inside quotes are each one LF.
      parts.push(text.slice(segStart, i), '\n');
      line += 1;
      const skip = ch === '\r' && i + 1 < n && text.charCodeAt(i + 1) === 10 ? 2 : 1;
      QRE.lastIndex = i + skip;
      segStart = i + skip;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted. The re-read may cross lines the
      // scan already passed, so its line end and CR state are recomputed.
      pos = open + 1;
      line = openLine;
      curLineEnd = text.indexOf('\n', pos);
      if (curLineEnd === -1) curLineEnd = n;
      recordHasCR = true;
      pushError('unterminated_quote');
      return readUnquoted('"');
    }
    // The quoted field crossed lines, so the rest of the record sits on a
    // line the record's first-line scan never checked.
    if (line !== openLine) recordHasCR = true;
    const value = parts.length === 1 ? parts[0] : parts.join('');
    pos = p;
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      curLineEnd = text.indexOf('\n', pos);
      if (curLineEnd === -1) curLineEnd = n;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    curLineEnd = text.indexOf('\n', pos);
    if (curLineEnd === -1) curLineEnd = n;
    const junk = readUnquoted(value);
    if (junk.value.length > value.length) pushError('quote_junk');
    return junk;
  }

  // Adds one parsed record (fields) to columns/rows, with its short/long error.
  function addRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a record with no quote and no stray CR splits on commas.
    const le = text.indexOf('\n', pos);
    const lineEnd = le === -1 ? n : le;
    let segEnd = lineEnd;
    if (le !== -1 && le > pos && text.charCodeAt(le - 1) === 13) segEnd = le - 1;
    const seg = text.slice(pos, segEnd);
    const segHasQuote = seg.indexOf('"') !== -1;
    const segHasCR = seg.indexOf('\r') !== -1;
    if (!segHasQuote && !segHasCR) {
      const fields = seg.split(',');
      pos = le === -1 ? n : le + 1;
      if (le !== -1) line += 1;
      // A line that held only stray CRs is left with no characters: no record.
      if (fields.length === 1 && fields[0] === '') continue;
      addRecord(fields);
      continue;
    }

    // Careful path: at least one quote or stray CR in this record.
    curLineEnd = lineEnd;
    recordHasCR = segHasCR;

    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    addRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
