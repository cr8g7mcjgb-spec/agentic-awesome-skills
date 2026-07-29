/**
 * The document formats Korean institutions actually publish in.
 *
 * HWPX, DOCX, XLSX and PPTX are the same thing underneath: a zip of XML. Once
 * a file can be unzipped - which the runtime does on its own - reading each is
 * a matter of knowing which parts hold the words and which tag they sit in.
 * There was never a reason to support one and refuse the other three.
 *
 * The zip is opened by the caller and handed here as a map of entries, so this
 * module holds only the per-format knowledge:
 *
 *   HWPX  Contents/section*.xml     <hp:t>   paragraphs end at </hp:p>
 *   DOCX  word/document.xml         <w:t>    paragraphs end at </w:p>
 *   PPTX  ppt/slides/slideN.xml     <a:t>    paragraphs end at </a:p>
 *   XLSX  xl/worksheets/sheetN.xml  cells reference xl/sharedStrings.xml
 *   ODT   content.xml               <text:p>
 */

/** Undo the five XML entities, which is all these formats use. */
export function unxml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/**
 * Pull the text out of one XML part.
 *
 * The text tag and the paragraph tag are matched in a single pass so the line
 * breaks land between the runs they separate. Matching them separately puts
 * every break at the end and the document arrives as one long line.
 */
function textFrom(xml, textTag, breakTag) {
  const re = new RegExp(`<${textTag}\\b[^>]*>([\\s\\S]*?)</${textTag}>|</${breakTag}>`, "g");
  const out = [];
  for (const m of xml.matchAll(re)) out.push(m[1] === undefined ? "\n" : unxml(m[1]));
  return out.join("");
}

const FAMILIES = [
  {
    kind: "HWPX",
    match: /^Contents\/section\d*\.xml$/i,
    read: (xml) => textFrom(xml, "hp:t", "hp:p"),
  },
  {
    kind: "DOCX",
    // Headers and footers carry the document number and the issuing office,
    // which is often the only place a notice says who issued it.
    match: /^word\/(?:document|header\d*|footer\d*)\.xml$/i,
    read: (xml) => textFrom(xml, "w:t", "w:p"),
  },
  {
    kind: "PPTX",
    match: /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/i,
    read: (xml) => textFrom(xml, "a:t", "a:p"),
  },
  {
    kind: "ODT",
    match: /^content\.xml$/i,
    read: (xml) => textFrom(xml, "text:p", "text:p"),
  },
];

/**
 * A spreadsheet, read as rows.
 *
 * Cell values are mostly not in the sheet: a string cell holds an index into a
 * shared table, so the table has to be read first or every text cell comes
 * back as a number. Rows are joined with tabs, which keeps a table looking
 * like a table.
 */
function readSheets(entries, decode) {
  const shared = [];
  const sharedPart = Object.keys(entries).find((n) => /^xl\/sharedStrings\.xml$/i.test(n));
  if (sharedPart) {
    const xml = decode(entries[sharedPart]);
    for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      shared.push(
        [...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unxml(t[1])).join("")
      );
    }
  }

  const sheets = Object.keys(entries)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const out = [];
  for (const name of sheets) {
    const xml = decode(entries[name]);
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const type = (/\bt="([^"]+)"/.exec(c[1]) || [])[1];
        if (type === "inlineStr") {
          cells.push([...c[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unxml(t[1])).join(""));
          continue;
        }
        const v = (/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(c[2]) || [])[1];
        if (v === undefined) {
          cells.push("");
          continue;
        }
        cells.push(type === "s" ? shared[Number(v)] ?? "" : unxml(v));
      }
      if (cells.some((v) => v !== "")) out.push(cells.join("\t"));
    }
    out.push("");
  }
  return out.join("\n");
}

/**
 * Read whatever kind of zipped document this is.
 *
 * The entry names say which format it is, which beats trusting the extension:
 * a link that ends in .hwp routinely serves a .docx, and one with no extension
 * at all serves anything.
 */
export function readZipDocument(entries, decode) {
  const names = Object.keys(entries);

  if (names.some((n) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(n))) {
    const text = readSheets(entries, decode).trim();
    return { text, how: "xlsx", parts: names.filter((n) => /worksheets\/sheet/i.test(n)).length };
  }

  for (const family of FAMILIES) {
    const parts = names.filter((n) => family.match.test(n)).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true })
    );
    if (!parts.length) continue;

    const pieces = [];
    for (const name of parts) {
      pieces.push(family.read(decode(entries[name])));
      pieces.push("\n");
    }
    const text = pieces
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { text, how: family.kind.toLowerCase(), parts: parts.length };
  }

  return null;
}

/**
 * Google's own export addresses for a public document.
 *
 * A Docs or Sheets link opens an application, not a file, and fetching it
 * returns the shell of a web app. Google publishes a plain export for anything
 * shared publicly, and it needs no key - so the link is rewritten rather than
 * refused.
 */
export function googleExport(url) {
  const m = /^https?:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{20,})/.exec(url);
  if (!m) return null;
  const [, kind, id] = m;
  const gid = (/[?#&]gid=(\d+)/.exec(url) || [])[1];

  if (kind === "spreadsheets") {
    return {
      url: `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}`,
      how: "google-sheets",
    };
  }
  return {
    url: `https://docs.google.com/${kind}/d/${id}/export?format=txt`,
    how: kind === "document" ? "google-docs" : "google-slides",
  };
}
