/**
 * A PDF text extractor that can read Korean, in about six hundred lines and
 * with no dependencies.
 *
 * The naive approach - inflate the content streams and pull whatever sits
 * inside `(...) Tj` - reads English fine and returns noise for Korean. Korean
 * documents almost always embed a subset font and store text as glyph ids:
 * `<0037 00A2 0041>` means "the 55th, 162nd and 65th shape in this font", not
 * any particular characters. That is why a first pass managed 1 Korean PDF in
 * 4 and the rest had to be handed to an outside service.
 *
 * The translation table is already in the file. Every such font carries a
 * `/ToUnicode` CMap saying which character each glyph id stands for; it exists
 * so that copy-and-paste works in a PDF viewer. Reading it turns the same
 * bytes into text, locally, with nothing to install and nobody to ask.
 *
 * What that takes:
 *   - objects, including the ones packed inside compressed object streams
 *   - each page's /Resources /Font, to know which font a name like /F1 means
 *   - each font's /ToUnicode CMap, parsed into code → text
 *   - a scanner over the content stream that tracks the current font, so the
 *     right table is applied to each string
 */

const HANGUL = /[가-힣]/g;

/* ------------------------------------------------------------- inflating */

async function inflateWith(bytes, format) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * DecompressionStream rejects a stream with anything after it, and nearly
 * every PDF puts a newline between the data and its `endstream` keyword, so
 * the padding has to come off first or every compressed stream is lost.
 */
export async function inflate(bytes) {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d || bytes[end - 1] === 0x20)) {
    end--;
  }
  const trimmed = bytes.subarray(0, end);
  try {
    return await inflateWith(trimmed, "deflate");
  } catch (e) {
    try {
      return await inflateWith(trimmed, "deflate-raw"); // headerless producers
    } catch {
      throw e;
    }
  }
}

/* --------------------------------------------------------------- objects */

/**
 * Bytes to a string, one byte to one character.
 *
 * Not TextDecoder("latin1"): that label is an alias for windows-1252, which
 * remaps 0x80-0x9F to other characters. Reading a PDF that way and taking the
 * low byte back out corrupts every one of them - which is most of the leading
 * bytes of Hangul in UTF-8, so Korean came back as mojibake.
 */
function toLatin1(bytes) {
  const CHUNK = 0x8000;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

const LATIN = { decode: toLatin1 };

/**
 * Index every `N G obj … endobj` in the file.
 *
 * The cross-reference table would be the tidy way in, but it is the first
 * thing to go stale in a file that has been edited, appended to, or produced
 * by something careless. Scanning finds the objects either way.
 */
function scanObjects(latin, buf) {
  const objects = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(latin)) !== null) {
    const num = Number(m[1]);
    const bodyAt = m.index + m[0].length;
    const endAt = latin.indexOf("endobj", bodyAt);
    const body = latin.slice(bodyAt, endAt < 0 ? Math.min(bodyAt + 200_000, latin.length) : endAt);

    // "endstream" also ends in "stream", so the keyword has to be anchored or
    // every stream is found twice and the second match reads the wrong object.
    const sm = /(^|[^a-zA-Z])stream\r?\n/.exec(body);
    let dict = body;
    let stream = null;
    if (sm) {
      dict = body.slice(0, sm.index + sm[1].length);
      const dataFrom = bodyAt + sm.index + sm[0].length;
      const declared = Number((dict.match(/\/Length\s+(\d+)/) || [])[1] || 0);
      let dataTo;
      if (declared > 0 && /^\s{0,4}endstream/.test(latin.slice(dataFrom + declared, dataFrom + declared + 14))) {
        dataTo = dataFrom + declared;
      } else {
        dataTo = latin.indexOf("endstream", dataFrom);
      }
      if (dataTo > dataFrom) stream = { from: dataFrom, to: dataTo, dict };
    }
    objects.set(num, { dict, stream, raw: buf });
    if (endAt >= 0) re.lastIndex = endAt;
  }
  return objects;
}

async function streamBytes(obj) {
  if (!obj?.stream) return null;
  const slice = obj.raw.subarray(obj.stream.from, obj.stream.to);
  if (!/\/FlateDecode/.test(obj.stream.dict)) return slice;
  try {
    return await inflate(slice);
  } catch {
    return null;
  }
}

/**
 * Objects inside object streams.
 *
 * PDF 1.5 onwards packs most non-stream objects - page dictionaries, font
 * dictionaries - into a compressed `/ObjStm`, where a plain scan cannot see
 * them. Without this step a modern file appears to have no fonts at all.
 */
async function expandObjectStreams(objects) {
  for (const [, obj] of [...objects]) {
    if (!/\/Type\s*\/ObjStm/.test(obj.dict)) continue;
    const bytes = await streamBytes(obj);
    if (!bytes) continue;

    const text = LATIN.decode(bytes);
    const count = Number((obj.dict.match(/\/N\s+(\d+)/) || [])[1] || 0);
    const first = Number((obj.dict.match(/\/First\s+(\d+)/) || [])[1] || 0);
    if (!count || !first) continue;

    const header = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < count; i++) {
      const num = header[i * 2];
      const at = header[i * 2 + 1];
      if (!Number.isFinite(num) || !Number.isFinite(at)) continue;
      const nextAt = i + 1 < count ? header[i * 2 + 3] : text.length - first;
      const body = text.slice(first + at, first + (Number.isFinite(nextAt) ? nextAt : text.length));
      // Only fill gaps: a real object found by scanning wins over a packed one.
      if (!objects.has(num)) objects.set(num, { dict: body, stream: null, raw: obj.raw });
    }
  }
}

const refIn = (dict, key) => {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return m ? Number(m[1]) : null;
};

/** Read a dictionary value that may be written inline or held behind a reference. */
function dictValue(objects, dict, key) {
  const ref = refIn(dict, key);
  if (ref !== null) return objects.get(ref)?.dict ?? null;

  const at = dict.indexOf(`/${key}`);
  if (at < 0) return null;
  const open = dict.indexOf("<<", at);
  if (open < 0 || open - at > 40) return null;

  let depth = 0;
  for (let i = open; i < dict.length - 1; i++) {
    if (dict[i] === "<" && dict[i + 1] === "<") { depth++; i++; }
    else if (dict[i] === ">" && dict[i + 1] === ">") {
      depth--;
      i++;
      if (depth === 0) return dict.slice(open, i + 1);
    }
  }
  return null;
}

/* ------------------------------------------------------------ ToUnicode */

const hexToText = (hex) => {
  let out = "";
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const code = parseInt(hex.slice(i, i + 4), 16);
    if (Number.isFinite(code)) out += String.fromCharCode(code);
  }
  return out;
};

/**
 * Parse a ToUnicode CMap into code → text.
 *
 * The format is small: `beginbfchar` lists one-to-one pairs, `beginbfrange`
 * lists spans that either count upwards from a starting character or spell out
 * every destination in an array.
 */
export function parseCMap(text) {
  const map = new Map();

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(p[1], 16), hexToText(p[2]));
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1];
    for (const r of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const from = parseInt(r[1], 16);
      const to = parseInt(r[2], 16);
      const base = parseInt(r[3], 16);
      if (to - from > 65_535) continue;
      for (let c = from; c <= to; c++) map.set(c, String.fromCharCode(base + (c - from)));
    }
    for (const r of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const from = parseInt(r[1], 16);
      let c = from;
      for (const d of r[3].matchAll(/<([0-9A-Fa-f]+)>/g)) map.set(c++, hexToText(d[1]));
    }
  }

  // How many bytes make one code. Identity-H and its relatives use two, and
  // reading a two-byte font one byte at a time produces confident nonsense.
  let codeBytes = 1;
  const space = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (space) {
    const first = /<([0-9A-Fa-f]+)>/.exec(space[1]);
    if (first && first[1].length >= 4) codeBytes = 2;
  } else if ([...map.keys()].some((k) => k > 255)) {
    codeBytes = 2;
  }
  return { map, codeBytes };
}

async function fontTable(objects, fontObjNum) {
  const font = objects.get(fontObjNum);
  if (!font) return null;

  const toUni = refIn(font.dict, "ToUnicode");
  if (toUni !== null) {
    const bytes = await streamBytes(objects.get(toUni));
    if (bytes) return parseCMap(LATIN.decode(bytes));
  }

  // A composite font with no table of its own: two-byte codes we cannot name.
  // Say so with an empty map rather than pretending each byte is a character.
  if (/\/Type0\b/.test(font.dict) || /\/Identity-[HV]/.test(font.dict)) {
    return { map: new Map(), codeBytes: 2 };
  }
  return null;
}

/* ------------------------------------------------- content stream scanner */

/**
 * Walk a content stream, keeping track of which font is selected.
 *
 * A regex over the whole stream cannot do this: the same bytes mean different
 * characters depending on the `Tf` that came before them, so the operators
 * have to be read in order.
 */
function scanContent(text, onShow, onBreak, onFont) {
  let i = 0;
  let operands = [];

  const isDelim = (c) => c === "(" || c === "<" || c === "[" || c === "/" || c === ")" || c === ">" || c === "]";

  while (i < text.length) {
    const c = text[i];

    if (c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0") { i++; continue; }

    if (c === "%") { while (i < text.length && text[i] !== "\n") i++; continue; }

    if (c === "(") {
      let depth = 1;
      let out = "";
      i++;
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === "\\") { out += ch + (text[i + 1] ?? ""); i += 2; continue; }
        if (ch === "(") depth++;
        if (ch === ")") { depth--; if (!depth) { i++; break; } }
        out += ch;
        i++;
      }
      operands.push({ kind: "str", value: out });
      continue;
    }

    if (c === "<" && text[i + 1] !== "<") {
      const close = text.indexOf(">", i);
      if (close < 0) break;
      operands.push({ kind: "hex", value: text.slice(i + 1, close) });
      i = close + 1;
      continue;
    }

    if (c === "<" && text[i + 1] === "<") { // an inline dictionary; skip it
      let depth = 0;
      while (i < text.length - 1) {
        if (text[i] === "<" && text[i + 1] === "<") { depth++; i += 2; continue; }
        if (text[i] === ">" && text[i + 1] === ">") { depth--; i += 2; if (!depth) break; continue; }
        i++;
      }
      continue;
    }

    if (c === "[") { operands.push({ kind: "arrayStart" }); i++; continue; }
    if (c === "]") { operands.push({ kind: "arrayEnd" }); i++; continue; }

    if (c === "/") {
      let j = i + 1;
      while (j < text.length && !/[\s/<>[\]()]/.test(text[j])) j++;
      operands.push({ kind: "name", value: text.slice(i + 1, j) });
      i = j;
      continue;
    }

    if (/[-+.\d]/.test(c)) {
      let j = i;
      while (j < text.length && /[-+.\d]/.test(text[j])) j++;
      operands.push({ kind: "num", value: text.slice(i, j) });
      i = j;
      continue;
    }

    // An operator: letters, and the two punctuation ones for showing text.
    let j = i;
    while (j < text.length && !/[\s/<>[\]()%]/.test(text[j])) j++;
    const op = text.slice(i, j === i ? i + 1 : j);
    i = j === i ? i + 1 : j;

    switch (op) {
      case "Tf": {
        const name = [...operands].reverse().find((o) => o.kind === "name");
        if (name) onFont(name.value);
        break;
      }
      case "Tj":
      case "'":
      case '"': {
        const s = [...operands].reverse().find((o) => o.kind === "str" || o.kind === "hex");
        if (s) onShow(s);
        if (op !== "Tj") onBreak();
        break;
      }
      case "TJ": {
        for (const o of operands) if (o.kind === "str" || o.kind === "hex") onShow(o);
        break;
      }
      case "T*":
      case "Td":
      case "TD":
      case "ET":
        onBreak();
        break;
      default:
        break;
    }
    if (!isDelim(op[0])) operands = [];
  }
}

/* ----------------------------------------------------------- byte decoding */

function literalToBytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") { out.push(s.charCodeAt(i) & 0xff); continue; }
    const n = s[i + 1];
    const simple = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
    if (simple[n] !== undefined) { out.push(simple[n]); i++; continue; }
    if (n >= "0" && n <= "7") {
      let oct = "";
      let k = i + 1;
      while (k < s.length && oct.length < 3 && s[k] >= "0" && s[k] <= "7") oct += s[k++];
      out.push(parseInt(oct, 8) & 0xff);
      i = k - 1;
      continue;
    }
    if (n === "\n") { i++; continue; } // a line continuation, not a character
    i++;
  }
  return Uint8Array.from(out);
}

const hexToBytes = (hex) => {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
  const padded = clean.length % 2 ? clean + "0" : clean;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const tryDecode = (bytes, label) => {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

/**
 * Bytes from a font with no ToUnicode table.
 *
 * These are ordinary single-byte encodings, but which one is not written down
 * anywhere reliable, so each is tried and judged by what comes out. EUC-KR is
 * worth trying before Latin-1: older Korean documents use it, and Latin-1
 * never fails, it just returns something unreadable.
 */
function decodePlain(bytes) {
  let ascii = true;
  for (const b of bytes) if (b > 0x7e || (b < 0x20 && b !== 9 && b !== 10 && b !== 13)) { ascii = false; break; }
  if (ascii) return LATIN.decode(bytes);

  const utf8 = tryDecode(bytes, "utf-8");
  if (utf8 && !/[�]/.test(utf8)) return utf8;

  const euc = tryDecode(bytes, "euc-kr");
  if (euc && HANGUL.test(euc)) return euc;

  return LATIN.decode(bytes);
}

function decodeWithTable(bytes, table) {
  const { map, codeBytes } = table;
  let out = "";
  for (let i = 0; i + codeBytes <= bytes.length; i += codeBytes) {
    const code = codeBytes === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
    const mapped = map.get(code);
    if (mapped !== undefined) out += mapped;
    else if (codeBytes === 1) out += decodePlain(bytes.subarray(i, i + 1));
    // A two-byte code with no entry has no characters behind it to guess at.
  }
  return out;
}

/* -------------------------------------------------------------- extract */

/**
 * Extract text from a PDF.
 *
 * Returns the text plus what it took to get there, so the caller can tell a
 * real reading from an empty one and a page of pictures from a parse failure.
 */
export async function extractPdfText(buf) {
  const latin = LATIN.decode(buf);
  const objects = scanObjects(latin, buf);
  await expandObjectStreams(objects);

  // Font tables are shared between pages; parse each at most once.
  const tables = new Map();
  const tableFor = async (num) => {
    if (!tables.has(num)) tables.set(num, await fontTable(objects, num));
    return tables.get(num);
  };

  const pages = [...objects.entries()].filter(([, o]) => /\/Type\s*\/Page\b/.test(o.dict));
  const pieces = [];
  let textOps = 0;
  let emptyShows = 0;
  let imageXObjects = 0;
  let mappedFonts = 0;

  for (const [, page] of pages) {
    const resources = dictValue(objects, page.dict, "Resources") || "";
    const fontDict = dictValue(objects, resources, "Font") || "";
    const fonts = new Map();
    for (const f of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      fonts.set(f[1], Number(f[2]));
    }

    const xobjects = dictValue(objects, resources, "XObject") || "";
    for (const x of xobjects.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      if (/\/Subtype\s*\/Image/.test(objects.get(Number(x[2]))?.dict || "")) imageXObjects++;
    }

    // /Contents is one stream or an array of them, joined in order.
    const contentRefs = [];
    const single = refIn(page.dict, "Contents");
    if (single !== null) contentRefs.push(single);
    else {
      const arr = /\/Contents\s*\[([^\]]*)\]/.exec(page.dict);
      if (arr) for (const r of arr[1].matchAll(/(\d+)\s+\d+\s+R/g)) contentRefs.push(Number(r[1]));
    }

    let content = "";
    for (const ref of contentRefs) {
      const bytes = await streamBytes(objects.get(ref));
      if (bytes) content += LATIN.decode(bytes) + "\n";
    }
    if (!content) continue;

    let table = null;
    const out = [];
    // Resolving a font table is async, so gather the work first, then apply it.
    const wanted = new Set();
    scanContent(content, () => {}, () => {}, (name) => wanted.add(name));
    for (const name of wanted) {
      const num = fonts.get(name);
      if (num !== undefined) {
        const t = await tableFor(num);
        if (t?.map.size) mappedFonts++;
      }
    }

    scanContent(
      content,
      (operand) => {
        textOps++;
        const bytes = operand.kind === "hex" ? hexToBytes(operand.value) : literalToBytes(operand.value);
        const piece = table ? decodeWithTable(bytes, table) : decodePlain(bytes);
        // Bytes went in and nothing came out: a font whose codes this file
        // never explains. Counting these is the difference between "this
        // document is in English" and "its Korean was silently dropped".
        if (bytes.length && !piece.trim()) emptyShows++;
        out.push(piece);
      },
      () => out.push("\n"),
      (name) => {
        const num = fonts.get(name);
        table = num === undefined ? null : tables.get(num) ?? null;
      }
    );

    pieces.push(out.join("").replace(/[ \t]{2,}/g, " "));
    pieces.push("\n\n");
  }

  const text = pieces.join("").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
  const hangul = (text.match(HANGUL) || []).length;
  const junk = (text.match(/[� --]/g) || []).length;

  return {
    text,
    hangul,
    junk,
    textOps,
    emptyShows,
    imageXObjects,
    pages: pages.length,
    mappedFonts,
  };
}
