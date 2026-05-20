import archiver from 'archiver';
import ExcelJS from 'exceljs';
import { PassThrough } from 'node:stream';

const EXPORT_PASSCODE = process.env.EXPORT_PASSCODE || 'phorms';
const RATE_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 12);
const LOOKUP_RATE_LIMIT_MAX = Number(process.env.LOOKUP_RATE_LIMIT_MAX || 180);

const exportRateLimitStore = new Map();
const lookupRateLimitStore = new Map();

function normalizePrefer(prefer) {
  const value = String(prefer || 'auto').trim().toLowerCase();
  if (value === 'google' || value === 'dnb' || value === 'openlibrary' || value === 'auto') {
    return value;
  }
  return 'auto';
}

function normalizeExportFormat(value) {
  const v = String(value || 'zip').trim().toLowerCase();
  if (v === 'marc21') return 'marc21';
  return 'zip';
}

function sanitizeIsbn(raw) {
  return String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
}

function normalizeScannerInput(raw) {
  return String(raw || '')
    .replace(/\uFEFF/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\](C1|E0)/gi, ' ')
    .replace(/ISBN(?:-1[03])?:?/gi, ' ')
    .trim();
}

function extractIsbn(raw) {
  const normalized = normalizeScannerInput(raw);
  if (!normalized) return '';

  const candidates = normalized.match(/(?:97[89][0-9Xx\-\s]{10,24}|[0-9Xx][0-9Xx\-\s]{8,20})/g) ?? [];
  for (const candidate of candidates) {
    const isbn = sanitizeIsbn(candidate);
    if (isbn.length === 10 || isbn.length === 13) return isbn;
  }

  const fallback = sanitizeIsbn(normalized);
  return fallback.length === 10 || fallback.length === 13 ? fallback : '';
}

function isValidIsbn10(isbn) {
  if (!/^\d{9}[\dX]$/.test(isbn)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const char = isbn[i];
    const value = char === 'X' ? 10 : Number(char);
    sum += value * (10 - i);
  }
  return sum % 11 === 0;
}

function isValidIsbn13(isbn) {
  if (!/^\d{13}$/.test(isbn)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const digit = Number(isbn[i]);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  const expected = (10 - (sum % 10)) % 10;
  return Number(isbn[12]) === expected;
}

function isValidIsbn(isbn) {
  if (isbn.length === 10) return isValidIsbn10(isbn);
  if (isbn.length === 13) return isValidIsbn13(isbn);
  return false;
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function csvEscape(value) {
  const v = String(value ?? '');
  return `"${v.replaceAll('"', '""')}"`;
}

function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function mapLanguageName(code) {
  const key = String(code || '').toLowerCase();
  const map = {
    deu: 'Deutsch',
    ger: 'Deutsch',
    eng: 'Englisch',
    fra: 'Franzoesisch',
    fre: 'Franzoesisch',
    spa: 'Spanisch',
    ita: 'Italienisch',
    nld: 'Niederlaendisch',
    por: 'Portugiesisch',
    pol: 'Polnisch',
    rus: 'Russisch',
    jpn: 'Japanisch',
    zho: 'Chinesisch',
    chi: 'Chinesisch',
    kor: 'Koreanisch',
  };
  return map[key] || code || 'und';
}

function normalizeLanguageCode(code) {
  const key = String(code || '').toLowerCase();
  const map = { de: 'deu', en: 'eng', fr: 'fra', es: 'spa', it: 'ita', nl: 'nld', pt: 'por', zh: 'zho', ja: 'jpn' };
  if (key.length === 2) return map[key] || 'und';
  if (key.length >= 3) return key.slice(0, 3);
  return 'und';
}

function pickBySourceOrder(sourceValues, order) {
  for (const source of order) {
    const value = sourceValues[source];
    if (typeof value === 'number') return String(value);
    if (String(value || '').trim()) return String(value).trim();
  }
  return '';
}

function buildSourceOrder(prefer) {
  if (prefer === 'google') return ['google', 'openlibrary', 'dnb'];
  if (prefer === 'dnb') return ['dnb', 'openlibrary', 'google'];
  if (prefer === 'openlibrary') return ['openlibrary', 'dnb', 'google'];
  return ['openlibrary', 'dnb', 'google'];
}

async function fetchOpenLibrary(isbn) {
  const searchUrl = `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}`;
  const res = await fetch(searchUrl);
  const payload = res.ok ? await res.json() : {};
  const doc = payload?.docs?.[0] ?? null;

  const booksUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`;
  let bookDoc = null;
  try {
    const bres = await fetch(booksUrl);
    if (bres.ok) {
      const b = await bres.json();
      bookDoc = b?.[`ISBN:${isbn}`] ?? null;
    }
  } catch {
    bookDoc = null;
  }

  return { doc, bookDoc, searchUrl };
}

async function fetchGoogle(isbn) {
  const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
  const googleUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}${apiKey ? `&key=${encodeURIComponent(apiKey)}` : ''}`;
  try {
    const res = await fetch(googleUrl);
    if (!res.ok) return { googleDoc: null, googleId: '', googleUrl };
    const data = await res.json();
    const item = data?.items?.[0];
    return { googleDoc: item?.volumeInfo ?? null, googleId: item?.id ?? '', googleUrl };
  } catch {
    return { googleDoc: null, googleId: '', googleUrl };
  }
}

async function fetchDnb(isbn) {
  const dnbUrl = `https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&query=${encodeURIComponent(`isbn=${isbn}`)}&recordSchema=MARC21-xml&maximumRecords=1`;
  try {
    const res = await fetch(dnbUrl);
    if (!res.ok) return { dnbXml: '', dnbUrl };
    const xml = await res.text();
    return { dnbXml: xml, dnbUrl };
  } catch {
    return { dnbXml: '', dnbUrl };
  }
}

async function enrichByIsbn(isbn, prefer) {
  const [ol, gg, dnb] = await Promise.all([fetchOpenLibrary(isbn), fetchGoogle(isbn), fetchDnb(isbn)]);
  const order = buildSourceOrder(prefer);

  const title = pickBySourceOrder(
    {
      openlibrary: ol.bookDoc?.title || ol.doc?.title || '',
      google: gg.googleDoc?.title || '',
      dnb: '',
    },
    order,
  );

  const publisher = pickBySourceOrder(
    {
      openlibrary: ol.bookDoc?.publishers?.[0]?.name || ol.doc?.publisher?.[0] || '',
      google: gg.googleDoc?.publisher || '',
      dnb: '',
    },
    order,
  );

  const publishDate = pickBySourceOrder(
    {
      openlibrary: ol.bookDoc?.publish_date || '',
      google: gg.googleDoc?.publishedDate || '',
      dnb: '',
    },
    order,
  );

  const pageCount = pickBySourceOrder(
    {
      openlibrary: ol.bookDoc?.number_of_pages || ol.doc?.number_of_pages_median || '',
      google: gg.googleDoc?.pageCount || '',
      dnb: '',
    },
    order,
  );

  const languageRaw = pickBySourceOrder(
    {
      openlibrary: ol.bookDoc?.languages?.[0]?.key?.split('/').pop() || ol.doc?.language?.[0] || '',
      google: gg.googleDoc?.language || '',
      dnb: '',
    },
    order,
  );

  const languageCode = normalizeLanguageCode(languageRaw);
  const languageNorm = mapLanguageName(languageCode);

  const coverUrl = pickBySourceOrder(
    {
      openlibrary: ol.bookDoc?.cover?.large || ol.bookDoc?.cover?.medium || ol.bookDoc?.cover?.small || `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`,
      google: gg.googleDoc?.imageLinks?.thumbnail || gg.googleDoc?.imageLinks?.smallThumbnail || '',
      dnb: '',
    },
    order,
  );

  const summary = pickBySourceOrder(
    {
      openlibrary: typeof ol.bookDoc?.notes === 'string' ? ol.bookDoc.notes : '',
      google: gg.googleDoc?.description || '',
      dnb: '',
    },
    order,
  );

  const identifiers = [];
  if (isbn.length === 13 && /^97[89]/.test(isbn)) {
    const core = isbn.slice(3, 12);
    let sum = 0;
    for (let i = 0; i < core.length; i += 1) sum += Number(core[i]) * (10 - i);
    const rem = 11 - (sum % 11);
    const check = rem === 10 ? 'X' : rem === 11 ? '0' : String(rem);
    identifiers.push(`ISBN10:${core}${check}`);
  }
  if (gg.googleId) identifiers.push(`GOOGLE:${gg.googleId}`);
  if (ol.doc?.key) identifiers.push(`OL_WORK:${ol.doc.key}`);

  return {
    isbn,
    title,
    publisher,
    publishPlace: '',
    publishDate,
    pageCount,
    languageCode,
    languageNorm,
    targetAudience: String(gg.googleDoc?.maturityRating || '').toUpperCase() === 'NOT_MATURE' ? 'Kinder/Jugend' : '',
    shortDescription: summary.slice(0, 280),
    summary,
    coverUrl,
    identifiers: dedupe(identifiers).join('; '),
    sourceUrl: ol.searchUrl,
  };
}

function tagDataField(tag, ind1, ind2, subfields) {
  const body = subfields
    .filter((s) => s?.value)
    .map((s) => `      <subfield code="${s.code}">${xmlEscape(s.value)}</subfield>`)
    .join('\n');
  return body ? `    <datafield tag="${tag}" ind1="${ind1}" ind2="${ind2}">\n${body}\n    </datafield>` : '';
}

function buildMarcRecord(row) {
  const datafields = [
    tagDataField('020', ' ', ' ', [{ code: 'a', value: row.isbn }]),
    tagDataField('245', '1', '0', [{ code: 'a', value: row.title }]),
    tagDataField('264', ' ', '1', [
      { code: 'a', value: row.publishPlace },
      { code: 'b', value: row.publisher },
      { code: 'c', value: row.publishDate },
    ]),
    tagDataField('300', ' ', ' ', [{ code: 'a', value: row.pageCount ? `${row.pageCount} Seiten` : '' }]),
    tagDataField('041', '0', ' ', [{ code: 'a', value: row.languageCode }]),
    tagDataField('546', ' ', ' ', [{ code: 'a', value: `Sprache: ${row.languageNorm}` }]),
    tagDataField('521', ' ', ' ', [{ code: 'a', value: row.targetAudience }]),
    tagDataField('520', ' ', ' ', [{ code: 'a', value: row.shortDescription }]),
    tagDataField('035', ' ', ' ', [{ code: 'a', value: row.identifiers }]),
    tagDataField('856', '4', '0', [{ code: 'u', value: row.sourceUrl }]),
    tagDataField('856', '4', '2', [{ code: 'u', value: row.coverUrl }, { code: 'y', value: 'Cover' }]),
  ].filter(Boolean);

  return `  <record>\n    <leader>00000nam a2200000 i 4500</leader>\n    <controlfield tag="001">${xmlEscape(row.isbn)}</controlfield>\n    <controlfield tag="003">WEB</controlfield>\n${datafields.join('\n')}\n  </record>`;
}

async function rowsToXlsxBuffer(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ISBN-Liste');
  ws.columns = [
    { header: 'isbn', key: 'isbn', width: 18 },
    { header: 'titel', key: 'title', width: 40 },
    { header: 'verlag', key: 'publisher', width: 24 },
    { header: 'erscheinungsort', key: 'publishPlace', width: 24 },
    { header: 'erscheinungsdatum', key: 'publishDate', width: 20 },
    { header: 'seitenanzahl', key: 'pageCount', width: 14 },
    { header: 'sprache_code', key: 'languageCode', width: 12 },
    { header: 'sprache_normiert', key: 'languageNorm', width: 18 },
    { header: 'zielgruppe', key: 'targetAudience', width: 18 },
    { header: 'identifikatoren', key: 'identifiers', width: 40 },
    { header: 'kurzbeschreibung', key: 'shortDescription', width: 60 },
    { header: 'zusammenfassung', key: 'summary', width: 80 },
    { header: 'cover_url', key: 'coverUrl', width: 55 },
  ];
  for (const row of rows) ws.addRow(row);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

function checkAuth(req, body) {
  if (!EXPORT_PASSCODE) return true;
  const provided = String(req.headers['x-export-passcode'] || req.query?.passcode || body?.passcode || '').trim();
  return provided === EXPORT_PASSCODE;
}

function checkRateLimit(store, clientIp, max) {
  const now = Date.now();
  const state = store.get(clientIp) || { count: 0, windowStart: now };

  if (now - state.windowStart >= RATE_WINDOW_MS) {
    state.count = 0;
    state.windowStart = now;
  }

  state.count += 1;
  store.set(clientIp, state);

  return {
    blocked: state.count > max,
    remaining: Math.max(max - state.count, 0),
    resetMs: Math.max(RATE_WINDOW_MS - (now - state.windowStart), 0),
  };
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

async function createZipBuffer(files) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const output = new PassThrough();
  const chunks = [];

  const completed = new Promise((resolve, reject) => {
    output.on('data', (chunk) => chunks.push(chunk));
    output.on('end', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });

  archive.pipe(output);
  for (const file of files) {
    archive.append(file.content, { name: file.name });
  }
  await archive.finalize();
  await completed;
  return Buffer.concat(chunks);
}

export async function handleLookup(req, res) {
  const body = parseBody(req);
  const clientIp = getClientIp(req);
  const rate = checkRateLimit(lookupRateLimitStore, clientIp, LOOKUP_RATE_LIMIT_MAX);

  res.setHeader('X-RateLimit-Limit', String(LOOKUP_RATE_LIMIT_MAX));
  res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
  res.setHeader('X-RateLimit-Reset-Ms', String(rate.resetMs));

  if (rate.blocked) {
    return res.status(429).json({ error: 'Zu viele Anfragen. Bitte kurz warten.' });
  }

  if (!checkAuth(req, body)) {
    return res.status(401).json({ error: 'Nicht autorisiert.' });
  }

  const prefer = normalizePrefer(body.prefer);
  const inputValues = Array.isArray(body.isbns) ? body.isbns : String(body.isbns || '').split(/\r?\n/);
  const isbns = dedupe(inputValues.map((line) => extractIsbn(line)).filter(Boolean)).slice(0, 100);

  if (isbns.length === 0) {
    return res.status(200).json({ results: [] });
  }

  const results = [];
  for (const isbn of isbns) {
    if (!isValidIsbn(isbn)) {
      results.push({ isbn, title: '', status: 'invalid' });
      continue;
    }

    const row = await enrichByIsbn(isbn, prefer);
    if (!row.title) {
      results.push({ isbn, title: '', status: 'not_found' });
      continue;
    }

    results.push({
      isbn,
      title: row.title,
      publisher: row.publisher,
      publishDate: row.publishDate,
      coverUrl: row.coverUrl,
      status: 'ok',
    });
  }

  return res.status(200).json({ results });
}

export async function handleExport(req, res) {
  const body = parseBody(req);
  const clientIp = getClientIp(req);
  const rate = checkRateLimit(exportRateLimitStore, clientIp, RATE_LIMIT_MAX);

  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
  res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
  res.setHeader('X-RateLimit-Reset-Ms', String(rate.resetMs));

  if (rate.blocked) {
    return res.status(429).json({ error: 'Zu viele Anfragen. Bitte kurz warten.' });
  }

  if (!checkAuth(req, body)) {
    return res.status(401).json({ error: 'Nicht autorisiert.' });
  }

  const rawInput = body.isbns ?? '';
  const prefer = normalizePrefer(body.prefer);
  const exportFormat = normalizeExportFormat(body.format);

  const isbns = dedupe(String(rawInput).split(/\r?\n/).map((line) => extractIsbn(line)).filter(Boolean));
  if (isbns.length === 0) {
    return res.status(400).json({ error: 'Keine gueltigen ISBNs gefunden.' });
  }

  const validIsbns = isbns.filter((i) => isValidIsbn(i));
  const invalidIsbns = isbns.filter((i) => !isValidIsbn(i));

  const rows = [];
  const misses = [];

  for (const isbn of validIsbns) {
    const row = await enrichByIsbn(isbn, prefer);
    if (!row.title) {
      misses.push({ isbn, reason: 'Nicht gefunden' });
      continue;
    }
    rows.push(row);
  }

  for (const isbn of invalidIsbns) {
    misses.push({ isbn, reason: 'Ungueltige ISBN-Pruefziffer' });
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<collection xmlns="http://www.loc.gov/MARC21/slim">\n${rows
    .map((r) => buildMarcRecord(r))
    .join('\n')}\n</collection>\n`;

  if (exportFormat === 'marc21') {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="isbn-records-${Date.now()}.marc21.xml"`);
    return res.status(200).send(xml);
  }

  const csvHeader = 'isbn,titel,verlag,erscheinungsort,erscheinungsdatum,seitenanzahl,sprache_code,sprache_normiert,zielgruppe,identifikatoren,kurzbeschreibung,zusammenfassung,cover_url';
  const csvRows = rows.map((r) => [
    r.isbn,
    r.title,
    r.publisher,
    r.publishPlace,
    r.publishDate,
    r.pageCount,
    r.languageCode,
    r.languageNorm,
    r.targetAudience,
    r.identifiers,
    r.shortDescription,
    r.summary,
    r.coverUrl,
  ].map(csvEscape).join(','));

  const csv = `${csvHeader}\n${csvRows.join('\n')}\n`;
  const missesCsv = `isbn,reason\n${misses.map((m) => `${csvEscape(m.isbn)},${csvEscape(m.reason)}`).join('\n')}\n`;
  const xlsx = await rowsToXlsxBuffer(rows);

  const zipBuffer = await createZipBuffer([
    { name: 'isbn-records.marc21.xml', content: xml },
    { name: 'isbn-records-list.csv', content: csv },
    { name: 'isbn-records-list.xlsx', content: xlsx },
    { name: 'isbn-misses.csv', content: missesCsv },
    {
      name: 'export-meta.json',
      content: JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          prefer,
          format: exportFormat,
          totalInput: isbns.length,
          exported: rows.length,
          misses: misses.length,
        },
        null,
        2,
      ),
    },
  ]);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="bib-export-${Date.now()}.zip"`);
  return res.status(200).send(zipBuffer);
}
