import express from 'express';
import archiver from 'archiver';
import ExcelJS from 'exceljs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function loadEnvFile() {
  const candidates = [resolve(process.cwd(), '.env'), resolve(dirname(fileURLToPath(import.meta.url)), '.env')];

  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const equalsIndex = trimmed.indexOf('=');
        if (equalsIndex <= 0) continue;
        const key = trimmed.slice(0, equalsIndex).trim();
        if (!key || process.env[key] !== undefined) continue;
        let value = trimmed.slice(equalsIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
      }
      break;
    } catch {
      // Ignore missing or unreadable .env files.
    }
  }
}

await loadEnvFile();

const app = express();
const port = process.env.PORT || 8787;
const RATE_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 12);
const LOOKUP_RATE_LIMIT_MAX = Number(process.env.LOOKUP_RATE_LIMIT_MAX || 180);
const LOC_SRU_BASE_URL = process.env.LOC_SRU_BASE_URL || 'https://lx2.loc.gov:210/LCDB';
const BNB_BASE_URL = process.env.BNB_BASE_URL || 'https://bnb.data.bl.uk';
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 9000);
const HTTP_RETRY_MAX = Number(process.env.HTTP_RETRY_MAX || 2);
const GOOGLE_CACHE_TTL_MS = Number(process.env.GOOGLE_CACHE_TTL_MS || 3600000);
const GOOGLE_MISS_CACHE_TTL_MS = Number(process.env.GOOGLE_MISS_CACHE_TTL_MS || 600000);
const GOOGLE_RATE_LIMIT_COOLDOWN_MS = Number(process.env.GOOGLE_RATE_LIMIT_COOLDOWN_MS || 120000);
const HTTP_USER_AGENT =
  process.env.HTTP_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(SCRIPT_DIR, 'public');
const LOG_DIR = resolve(SCRIPT_DIR, 'logs');
const AUDIT_LOG_FILE = resolve(LOG_DIR, 'export-audit.log');
const rateLimitStore = new Map();
const lookupRateLimitStore = new Map();
const googleLookupCache = new Map();
let googleRateLimitUntil = 0;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/', (_req, res) => {
  res.sendFile(resolve(PUBLIC_DIR, 'index.html'));
});

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(clientIp) {
  const now = Date.now();
  const state = rateLimitStore.get(clientIp) || { count: 0, windowStart: now };

  if (now - state.windowStart >= RATE_WINDOW_MS) {
    state.count = 0;
    state.windowStart = now;
  }

  state.count += 1;
  rateLimitStore.set(clientIp, state);

  return {
    blocked: state.count > RATE_LIMIT_MAX,
    remaining: Math.max(RATE_LIMIT_MAX - state.count, 0),
    resetMs: Math.max(RATE_WINDOW_MS - (now - state.windowStart), 0),
  };
}

function checkLookupRateLimit(clientIp) {
  const now = Date.now();
  const state = lookupRateLimitStore.get(clientIp) || { count: 0, windowStart: now };

  if (now - state.windowStart >= RATE_WINDOW_MS) {
    state.count = 0;
    state.windowStart = now;
  }

  state.count += 1;
  lookupRateLimitStore.set(clientIp, state);

  return {
    blocked: state.count > LOOKUP_RATE_LIMIT_MAX,
    remaining: Math.max(LOOKUP_RATE_LIMIT_MAX - state.count, 0),
    resetMs: Math.max(RATE_WINDOW_MS - (now - state.windowStart), 0),
  };
}

async function writeAuditLog(entry) {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(AUDIT_LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.error('Audit-Log Fehler:', error.message);
  }
}

function isAuthorized(_req) {
  return true;
}

async function readAuditEntries() {
  try {
    const content = await readFile(AUDIT_LOG_FILE, 'utf8');
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildAuditStats(entries) {
  const perDay = {};
  const eventCounts = {};
  const topIsbns = {};

  for (const e of entries) {
    const day = String(e.ts || '').slice(0, 10) || 'unknown';
    perDay[day] = perDay[day] || { export_ok: 0, export_error: 0, auth_failed: 0, rate_limited: 0 };

    const event = String(e.event || 'unknown');
    eventCounts[event] = (eventCounts[event] || 0) + 1;
    if (perDay[day][event] !== undefined) {
      perDay[day][event] += 1;
    }

    if (event === 'export_ok' && Array.isArray(e.isbns)) {
      for (const isbn of e.isbns) {
        topIsbns[isbn] = (topIsbns[isbn] || 0) + 1;
      }
    }
  }

  const topIsbnList = Object.entries(topIsbns)
    .map(([isbn, count]) => ({ isbn, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return {
    totalEntries: entries.length,
    eventCounts,
    perDay,
    topIsbns: topIsbnList,
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, state] of rateLimitStore.entries()) {
    if (now - state.windowStart > RATE_WINDOW_MS * 3) {
      rateLimitStore.delete(ip);
    }
  }

  for (const [ip, state] of lookupRateLimitStore.entries()) {
    if (now - state.windowStart > RATE_WINDOW_MS * 3) {
      lookupRateLimitStore.delete(ip);
    }
  }
}, RATE_WINDOW_MS).unref();

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
  if (!normalized) {
    return '';
  }

  const candidates = normalized.match(/(?:97[89][0-9Xx\-\s]{10,24}|[0-9Xx][0-9Xx\-\s]{8,20})/g) ?? [];
  for (const candidate of candidates) {
    const isbn = sanitizeIsbn(candidate);
    if (isbn.length === 10 || isbn.length === 13) {
      return isbn;
    }
  }

  const fallback = sanitizeIsbn(normalized);
  return fallback.length === 10 || fallback.length === 13 ? fallback : '';
}

function isValidIsbn10(isbn) {
  if (!/^\d{9}[\dX]$/.test(isbn)) {
    return false;
  }

  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const char = isbn[i];
    const value = char === 'X' ? 10 : Number(char);
    sum += value * (10 - i);
  }
  return sum % 11 === 0;
}

function isValidIsbn13(isbn) {
  if (!/^\d{13}$/.test(isbn)) {
    return false;
  }

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

function normalizeAuthorName(value) {
  const raw = String(value || '').trim().replace(/\s+/g, ' ');
  if (!raw || raw.includes(',')) return raw;

  if (/\b(verlag|press|publishing|publisher|inc\.?|ltd\.?|llc|gmbh|ag|university|society|department|studio|media|books?)\b/i.test(raw)) {
    return raw;
  }

  const parts = raw.split(' ');
  if (parts.length < 2) return raw;

  const particles = new Set(['von', 'van', 'de', 'del', 'der', 'den', 'da', 'di', 'du', 'la', 'le']);
  const surname = [parts.pop()];
  if (parts.length && particles.has(parts[parts.length - 1].toLowerCase())) {
    surname.unshift(parts.pop());
  }

  const given = parts.join(' ').trim();
  if (!given) return raw;
  return `${surname.join(' ')}, ${given}`;
}

function normalizePersonList(values) {
  const list = Array.isArray(values) ? values : [values];
  return dedupe(
    list
      .map((value) => normalizeAuthorName(value))
      .filter(Boolean),
  );
}

function formatMarcExtent(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/\b(seiten|s\.|pages|p\.)\b/i.test(text)) return text;
  return /^\d+$/.test(text) ? `${text} Seiten` : text;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatMultipartTitle(title, seriesTitle, seriesVolume) {
  const baseTitle = String(title || '').trim();
  const series = String(seriesTitle || '').trim();
  const volume = String(seriesVolume || '').trim();
  if (!baseTitle || !series || !volume) return baseTitle;

  let partTitle = '';
  const seriesPattern = new RegExp(`^${escapeRegExp(series)}\\s*(?:Band\\s*)?${escapeRegExp(volume)}\\s*[-:,.]\\s*(.+)$`, 'i');
  const seriesMatch = baseTitle.match(seriesPattern);
  if (seriesMatch?.[1]) {
    partTitle = seriesMatch[1];
  } else if (baseTitle.includes(' - ')) {
    const split = baseTitle.split(' - ');
    partTitle = split.slice(1).join(' - ');
  }

  partTitle = String(partTitle || '').split(' : ')[0].trim();
  if (!partTitle) partTitle = baseTitle;

  return `#${volume}, ${partTitle} - ${series}`;
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
    kor: 'Koreanisch'
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

function pickOpenLibraryLanguage(bookDoc, doc) {
  const fromBook = (bookDoc?.languages || [])
    .map((entry) => String(entry?.key || '').split('/').pop())
    .filter(Boolean);
  const fromSearch = Array.isArray(doc?.language) ? doc.language : [];
  const normalized = dedupe([...fromBook, ...fromSearch].map((code) => normalizeLanguageCode(code)).filter((code) => code && code !== 'und'));
  if (!normalized.length) return '';
  if (normalized.includes('eng')) return 'eng';
  return normalized[0];
}

function pickOpenLibrarySeriesTitle(workDoc, seriesDoc) {
  const candidates = [
    String(seriesDoc?.name || '').trim(),
    String(seriesDoc?.title || '').trim(),
    String(workDoc?.series?.[0]?.series?.name || '').trim(),
  ].filter(Boolean);
  return candidates[0] || '';
}

function pickOpenLibrarySeriesVolume(workDoc) {
  const candidates = [
    String(workDoc?.series?.[0]?.position || '').trim(),
    String(workDoc?.series_number || '').trim(),
  ].filter(Boolean);
  return candidates[0] || '';
}

function pickOpenLibraryPublishPlace(bookDoc) {
  const candidates = (bookDoc?.publish_places || [])
    .map((entry) => String(entry?.name || '').trim())
    .filter(Boolean);
  const blocked = new Set(['usa', 'us', 'uk', 'united states', 'united kingdom', 'england', 'great britain']);
  return candidates.find((value) => !blocked.has(value.toLowerCase())) || '';
}

function pickBySourceOrder(sourceValues, order) {
  for (const source of order) {
    const value = sourceValues[source];
    if (typeof value === 'number') return String(value);
    if (String(value || '').trim()) return String(value).trim();
  }
  return '';
}

function pickSourceByOrder(sourceValues, order) {
  for (const source of order) {
    const value = sourceValues[source];
    if (typeof value === 'number') return source;
    if (String(value || '').trim()) return source;
  }
  return '';
}

function buildSourceOrder(prefer) {
  if (prefer === 'google') return ['google', 'dnb', 'bnb', 'loc', 'openlibrary'];
  if (prefer === 'dnb') return ['dnb', 'bnb', 'loc', 'openlibrary', 'google'];
  if (prefer === 'openlibrary') return ['openlibrary', 'dnb', 'bnb', 'loc', 'google'];
  if (prefer === 'loc') return ['loc', 'dnb', 'bnb', 'openlibrary', 'google'];
  if (prefer === 'bnb') return ['bnb', 'dnb', 'loc', 'openlibrary', 'google'];
  return ['dnb', 'bnb', 'loc', 'openlibrary', 'google'];
}

function normalizePrefer(prefer) {
  const value = String(prefer || 'auto').trim().toLowerCase();
  if (value === 'google' || value === 'dnb' || value === 'openlibrary' || value === 'loc' || value === 'bnb' || value === 'auto') {
    return value;
  }
  return 'auto';
}

function pickContributorsBySourceOrder(sourceValues, order) {
  for (const source of order) {
    const values = Array.isArray(sourceValues[source]) ? sourceValues[source] : [];
    if (values.length) return values;
  }
  return [];
}

function normalizeExportFormat(value) {
  const v = String(value || 'zip').trim().toLowerCase();
  if (v === 'marc21') {
    return 'marc21';
  }
  return 'zip';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headers) {
  const value = headers?.['retry-after'] || headers?.['Retry-After'];
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const dateValue = new Date(String(value)).getTime();
  if (Number.isFinite(dateValue)) return Math.max(dateValue - Date.now(), 0);
  return 0;
}

function cleanupGoogleCache() {
  const now = Date.now();
  for (const [key, entry] of googleLookupCache.entries()) {
    if (entry.expiresAt <= now) googleLookupCache.delete(key);
  }
  if (googleLookupCache.size > 500) {
    const firstKey = googleLookupCache.keys().next().value;
    if (firstKey) googleLookupCache.delete(firstKey);
  }
}

function requestWithNodeHttp(url, options = {}) {
  const {
    timeoutMs = HTTP_TIMEOUT_MS,
    accept = 'application/json, text/plain;q=0.9, */*;q=0.8',
  } = options;

  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'http:' ? http : https;
    const req = client.request(
      target,
      {
        method: 'GET',
        family: 4,
        headers: {
          Accept: accept,
          'User-Agent': HTTP_USER_AGENT,
          'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
          Referer: `${target.protocol}//${target.host}/`,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: Number(res.statusCode || 0),
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request_timeout')));
    req.end();
  });
}

async function fetchViaNodeHttp(url, options = {}, redirects = 0) {
  const response = await requestWithNodeHttp(url, options);
  const redirectCodes = new Set([301, 302, 303, 307, 308]);
  const location = String(response.headers?.location || '').trim();

  if (redirectCodes.has(response.status) && location && redirects < 4) {
    const nextUrl = new URL(location, url).toString();
    return fetchViaNodeHttp(nextUrl, options, redirects + 1);
  }

  return response;
}

async function fetchWithRetry(url, options = {}) {
  const {
    parse = 'json',
    accept = 'application/json, text/plain;q=0.9, */*;q=0.8',
    retries = HTTP_RETRY_MAX,
    timeoutMs = HTTP_TIMEOUT_MS,
  } = options;

  let lastError = null;
  const emptyData = parse === 'text' ? '' : null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: accept,
          'User-Agent': HTTP_USER_AGENT,
          'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
          Referer: `${new URL(url).protocol}//${new URL(url).host}/`,
        },
      });

      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await wait(250 * (attempt + 1));
        continue;
      }

      if (!res.ok) {
        const fallbackRes = await fetchViaNodeHttp(url, { timeoutMs, accept });
        if (fallbackRes.status >= 200 && fallbackRes.status < 300) {
          const fallbackData = parse === 'text' ? fallbackRes.body : JSON.parse(fallbackRes.body || 'null');
          return { ok: true, status: fallbackRes.status, data: fallbackData, headers: fallbackRes.headers || {} };
        }
        return {
          ok: false,
          status: fallbackRes.status || res.status,
          data: emptyData,
          headers: fallbackRes.headers || Object.fromEntries(res.headers.entries()),
        };
      }

      const data = parse === 'text' ? await res.text() : await res.json();
      return { ok: true, status: res.status, data, headers: Object.fromEntries(res.headers.entries()) };
    } catch (error) {
      lastError = error;
      try {
        const fallbackRes = await fetchViaNodeHttp(url, { timeoutMs, accept });
        if (fallbackRes.status >= 200 && fallbackRes.status < 300) {
          const fallbackData = parse === 'text' ? fallbackRes.body : JSON.parse(fallbackRes.body || 'null');
          return { ok: true, status: fallbackRes.status, data: fallbackData, headers: fallbackRes.headers || {} };
        }
      } catch (fallbackError) {
        lastError = fallbackError;
      }
      if (attempt < retries) {
        await wait(250 * (attempt + 1));
        continue;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false, status: 0, data: emptyData, error: lastError, headers: {} };
}

async function fetchOpenLibrary(isbn) {
  const searchUrl = `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}`;
  const searchRes = await fetchWithRetry(searchUrl, { parse: 'json' });
  const payload = searchRes.ok ? searchRes.data : {};
  let doc = payload?.docs?.[0] ?? null;

  const booksUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`;
  const booksRes = await fetchWithRetry(booksUrl, { parse: 'json' });
  let bookDoc = booksRes.ok ? booksRes.data?.[`ISBN:${isbn}`] ?? null : null;

  const isbnUrl = `https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`;
  const isbnRes = await fetchWithRetry(isbnUrl, { parse: 'json' });
  const isbnDoc = isbnRes.ok ? isbnRes.data : null;

  if (!doc && isbnDoc) {
    doc = {
      title: String(isbnDoc.title || '').trim(),
      key: String(isbnDoc?.works?.[0]?.key || '').trim(),
      author_name: isbnDoc.by_statement ? [String(isbnDoc.by_statement).trim()] : [],
      language: (isbnDoc.languages || []).map((entry) => String(entry?.key || '').split('/').pop()).filter(Boolean),
    };
  }

  if (!bookDoc && isbnDoc) {
    bookDoc = {
      title: String(isbnDoc.title || '').trim(),
      authors: isbnDoc.by_statement ? [{ name: String(isbnDoc.by_statement).trim() }] : [],
      publishers: (isbnDoc.publishers || []).map((entry) => (typeof entry === 'string' ? { name: entry } : entry)),
      publish_date: String(isbnDoc.publish_date || '').trim(),
      number_of_pages: isbnDoc.number_of_pages || '',
      pagination: String(isbnDoc.pagination || '').trim(),
      publish_places: (isbnDoc.publish_places || []).map((entry) => (typeof entry === 'string' ? { name: entry } : entry)),
      languages: isbnDoc.languages || [],
      notes:
        typeof isbnDoc.description === 'string'
          ? isbnDoc.description
          : String(isbnDoc.description?.value || '').trim(),
    };
  }

  let workDoc = null;
  let seriesDoc = null;
  try {
    const workKey = String(doc?.key || isbnDoc?.works?.[0]?.key || '').trim();
    if (workKey) {
      const workRes = await fetchWithRetry(`https://openlibrary.org${workKey}.json`, { parse: 'json' });
      if (workRes.ok) {
        workDoc = workRes.data;
        const seriesKey = String(workDoc?.series?.[0]?.series?.key || '').trim();
        if (seriesKey) {
          const seriesRes = await fetchWithRetry(`https://openlibrary.org${seriesKey}.json`, { parse: 'json' });
          if (seriesRes.ok) {
            seriesDoc = seriesRes.data;
          }
        }
      }
    }
  } catch {
    workDoc = null;
    seriesDoc = null;
  }

  return { doc, bookDoc, workDoc, seriesDoc, searchUrl: doc ? searchUrl : isbnUrl };
}

async function fetchGoogle(isbn) {
  const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
  const googleUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}${apiKey ? `&key=${encodeURIComponent(apiKey)}` : ''}`;
  const cacheKey = `${isbn}|${apiKey ? 'key' : 'nokey'}`;

  cleanupGoogleCache();
  const now = Date.now();
  const cached = googleLookupCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { ...cached.value, googleUrl };
  }

  if (now < googleRateLimitUntil) {
    return { googleDoc: null, googleId: '', googleUrl };
  }

  const maxAttempts = apiKey ? 2 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await fetchWithRetry(googleUrl, { parse: 'json', retries: 0 });
    if (res.ok) {
      const item = res.data?.items?.[0];
      const value = { googleDoc: item?.volumeInfo ?? null, googleId: item?.id ?? '' };
      const ttl = value.googleDoc ? GOOGLE_CACHE_TTL_MS : GOOGLE_MISS_CACHE_TTL_MS;
      googleLookupCache.set(cacheKey, { value, expiresAt: Date.now() + ttl });
      return { ...value, googleUrl };
    }

    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers);
      const cooldownMs = Math.max(Math.min(retryAfterMs || GOOGLE_RATE_LIMIT_COOLDOWN_MS, GOOGLE_RATE_LIMIT_COOLDOWN_MS), 3000);
      googleRateLimitUntil = Date.now() + cooldownMs;
      if (attempt < maxAttempts - 1) {
        await wait(Math.min(1500 * (attempt + 1), 5000));
        continue;
      }
    }

    break;
  }

  return { googleDoc: null, googleId: '', googleUrl };
}

async function fetchDnb(isbn) {
  const dnbUrl = `https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&query=${encodeURIComponent(`isbn=${isbn}`)}&recordSchema=MARC21-xml&maximumRecords=1`;
  const res = await fetchWithRetry(dnbUrl, { parse: 'text', accept: 'application/xml, text/xml;q=0.9, */*;q=0.8' });
  if (!res.ok) return { dnbXml: '', dnbUrl };
  return { dnbXml: res.data, dnbUrl };
}

async function fetchLoc(isbn) {
  const locUrl = `${LOC_SRU_BASE_URL}?version=1.1&operation=searchRetrieve&query=${encodeURIComponent(`bath.isbn=${isbn}`)}&recordSchema=marcxml&maximumRecords=1`;
  const res = await fetchWithRetry(locUrl, { parse: 'text', accept: 'application/xml, text/xml;q=0.9, */*;q=0.8' });
  if (!res.ok) return { locXml: '', locUrl };
  return { locXml: res.data, locUrl };
}

async function fetchBnb(isbn) {
  const bnbUrl = `${BNB_BASE_URL.replace(/\/+$/, '')}/doc/resource/isbn/${encodeURIComponent(isbn)}.json`;
  const res = await fetchWithRetry(bnbUrl, {
    parse: 'json',
    accept: 'application/ld+json, application/json;q=0.9, */*;q=0.8',
  });
  if (!res.ok) return { bnbJson: null, bnbUrl };
  return { bnbJson: res.data, bnbUrl };
}

function parseBnbJsonLd(payload) {
  const graph = Array.isArray(payload?.['@graph'])
    ? payload['@graph']
    : Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object'
        ? [payload]
        : [];

  const root = graph.find((n) => Object.keys(n || {}).some((k) => /title|isbn|publisher|creator|contributor/i.test(k))) || graph[0] || {};

  function toArray(v) {
    if (Array.isArray(v)) return v;
    return v == null ? [] : [v];
  }

  function literal(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number') return String(v);
    if (typeof v === 'object') {
      if (typeof v['@value'] === 'string') return v['@value'].trim();
      if (typeof v.value === 'string') return v.value.trim();
      if (typeof v['@id'] === 'string') return v['@id'].trim();
    }
    return '';
  }

  function firstByKeyRegex(node, regex) {
    for (const [k, v] of Object.entries(node || {})) {
      if (!regex.test(k)) continue;
      for (const item of toArray(v)) {
        const text = literal(item);
        if (text) return text;
      }
    }
    return '';
  }

  function resolveNodeNameById(id) {
    const target = graph.find((n) => n?.['@id'] === id);
    if (!target) return '';
    return firstByKeyRegex(target, /name|label|preferred/i);
  }

  function namesFromRel(regex) {
    const names = [];
    for (const [k, v] of Object.entries(root || {})) {
      if (!regex.test(k)) continue;
      for (const item of toArray(v)) {
        if (item && typeof item === 'object' && typeof item['@id'] === 'string') {
          const resolved = resolveNodeNameById(item['@id']);
          if (resolved) names.push(resolved);
        }
        const text = literal(item);
        if (text && !text.startsWith('http')) names.push(text);
      }
    }
    return normalizePersonList(names);
  }

  return {
    title: firstByKeyRegex(root, /title/i),
    authors: namesFromRel(/creator|author/i),
    contributors: [],
    publishPlace: firstByKeyRegex(root, /spatial|place/i),
    publisher: firstByKeyRegex(root, /publisher/i),
    publishDate: firstByKeyRegex(root, /date|issued|publication/i),
    pageCount: firstByKeyRegex(root, /extent|pagination|pages?/i),
    edition: firstByKeyRegex(root, /edition/i),
    seriesTitle: firstByKeyRegex(root, /series|ispartof/i),
    seriesVolume: firstByKeyRegex(root, /partnumber|volume|numbering/i),
    languageCode: firstByKeyRegex(root, /language/i),
    summary: firstByKeyRegex(root, /description|summary|abstract/i),
    dnbId: '',
  };
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .trim();
}

function stripMarcPunctuation(value) {
  return String(value || '').replace(/[\s\/:;,.]+$/g, '').trim();
}

function buildCoverPlaceholderDataUrl(isbn) {
  const label = String(isbn || '').trim() || 'ISBN';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="540" viewBox="0 0 360 540"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e2e8f0"/><stop offset="1" stop-color="#cbd5e1"/></linearGradient></defs><rect width="360" height="540" fill="url(#g)"/><rect x="30" y="30" width="300" height="480" rx="18" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/><text x="180" y="230" text-anchor="middle" font-family="Arial, sans-serif" font-size="26" fill="#334155">Kein Cover</text><text x="180" y="275" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" fill="#475569">${xmlEscape(label)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

async function urlLooksLikeImage(url) {
  if (!url) return false;
  try {
    const headRes = await fetch(url, { method: 'HEAD' });
    if (headRes.ok) {
      const contentType = String(headRes.headers.get('content-type') || '').toLowerCase();
      return contentType.startsWith('image/');
    }
  } catch {
    // Some providers do not support HEAD reliably.
  }

  try {
    const getRes = await fetch(url);
    if (!getRes.ok) return false;
    const contentType = String(getRes.headers.get('content-type') || '').toLowerCase();
    return contentType.startsWith('image/');
  } catch {
    return false;
  }
}

async function resolveCoverUrl(isbn, ol, gg) {
  const googleCover = gg.googleDoc?.imageLinks?.thumbnail || gg.googleDoc?.imageLinks?.smallThumbnail || '';
  if (googleCover) {
    return googleCover;
  }

  const openLibraryDirect = ol.bookDoc?.cover?.large || ol.bookDoc?.cover?.medium || ol.bookDoc?.cover?.small || '';
  if (openLibraryDirect) {
    return openLibraryDirect;
  }

  const openLibraryByIsbn = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
  if (await urlLooksLikeImage(openLibraryByIsbn)) {
    return openLibraryByIsbn;
  }

  return buildCoverPlaceholderDataUrl(isbn);
}

function parseDnbMarcXml(xmlText) {
  const xml = String(xmlText || '');
  if (!xml) {
    return {
      title: '',
      authors: [],
      publisher: '',
      publishDate: '',
      pageCount: '',
      edition: '',
      seriesTitle: '',
      seriesVolume: '',
      languageCode: '',
      summary: '',
      dnbId: '',
    };
  }

  const fields = [];
  const datafieldRegex = /<datafield\b[^>]*tag="(\d{3})"[^>]*>([\s\S]*?)<\/datafield>/g;
  for (const match of xml.matchAll(datafieldRegex)) {
    fields.push({ tag: match[1], body: match[2] });
  }

  function firstSubfield(tag, code) {
    for (const field of fields) {
      if (field.tag !== tag) continue;
      const subRegex = new RegExp(`<subfield\\b[^>]*code="${code}"[^>]*>([\\s\\S]*?)<\\/subfield>`, 'i');
      const subMatch = field.body.match(subRegex);
      if (subMatch?.[1]) {
        return decodeXmlEntities(subMatch[1]);
      }
    }
    return '';
  }

  function allSubfields(tag, code) {
    const values = [];
    for (const field of fields) {
      if (field.tag !== tag) continue;
      const subRegex = new RegExp(`<subfield\\b[^>]*code="${code}"[^>]*>([\\s\\S]*?)<\\/subfield>`, 'ig');
      for (const subMatch of field.body.matchAll(subRegex)) {
        if (subMatch?.[1]) {
          values.push(decodeXmlEntities(subMatch[1]));
        }
      }
    }
    return values;
  }

  function matchingFields(tags) {
    return fields.filter((field) => tags.includes(field.tag));
  }

  function parseContributors(tags) {
    return matchingFields(tags)
      .map((field) => {
        const name = decodeXmlEntities(field.body.match(/<subfield\b[^>]*code="a"[^>]*>([\s\S]*?)<\/subfield>/i)?.[1] || '');
        const relatorCode = decodeXmlEntities(field.body.match(/<subfield\b[^>]*code="4"[^>]*>([\s\S]*?)<\/subfield>/i)?.[1] || '').toLowerCase();
        const relatorText = decodeXmlEntities(field.body.match(/<subfield\b[^>]*code="e"[^>]*>([\s\S]*?)<\/subfield>/i)?.[1] || '').toLowerCase();
        return {
          tag: field.tag,
          name: stripMarcPunctuation(name),
          relatorCode,
          relatorText,
        };
      })
      .filter((entry) => entry.name);
  }

  const titleA = stripMarcPunctuation(firstSubfield('245', 'a'));
  const titleB = stripMarcPunctuation(firstSubfield('245', 'b'));
  const publishPlace264 = stripMarcPunctuation(firstSubfield('264', 'a'));
  const publishPlace260 = stripMarcPunctuation(firstSubfield('260', 'a'));
  const publisher264 = stripMarcPunctuation(firstSubfield('264', 'b'));
  const publisher260 = stripMarcPunctuation(firstSubfield('260', 'b'));
  const publishDate264 = stripMarcPunctuation(firstSubfield('264', 'c'));
  const publishDate260 = stripMarcPunctuation(firstSubfield('260', 'c'));
  const pages = stripMarcPunctuation(firstSubfield('300', 'a'));
  const edition = stripMarcPunctuation(firstSubfield('250', 'a'));
  const seriesTitle490 = stripMarcPunctuation(firstSubfield('490', 'a'));
  const seriesVolume490 = stripMarcPunctuation(firstSubfield('490', 'v'));
  const seriesTitle830 = stripMarcPunctuation(firstSubfield('830', 'a'));
  const seriesVolume830 = stripMarcPunctuation(firstSubfield('830', 'v'));
  const language041 = stripMarcPunctuation(firstSubfield('041', 'a')).toLowerCase();
  const summary520 = decodeXmlEntities(firstSubfield('520', 'a'));
  const dnbId = stripMarcPunctuation(firstSubfield('035', 'a'));
  const contributors = parseContributors(['100', '110', '700', '710']);
  const authors = normalizePersonList(
    contributors
      .filter((entry) => entry.relatorCode === 'aut' || /verfasser|author/.test(entry.relatorText))
      .map((entry) => entry.name),
  );

  const control008Match = xml.match(/<controlfield\b[^>]*tag="008"[^>]*>([\s\S]*?)<\/controlfield>/i);
  const control008 = decodeXmlEntities(control008Match?.[1] || '').replace(/\s+/g, '');
  const language008 = control008.length >= 38 ? control008.slice(35, 38).toLowerCase() : '';

  const title = [titleA, titleB].filter(Boolean).join(' : ');

  return {
    title,
    authors,
    contributors,
    publishPlace: publishPlace264 || publishPlace260,
    publisher: publisher264 || publisher260,
    publishDate: publishDate264 || publishDate260,
    pageCount: pages,
    edition,
    seriesTitle: seriesTitle490 || seriesTitle830,
    seriesVolume: seriesVolume490 || seriesVolume830,
    languageCode: language041 || language008,
    summary: summary520,
    dnbId,
  };
}

function tagDataField(tag, ind1, ind2, subfields) {
  const body = subfields
    .filter((s) => s?.value)
    .map((s) => `      <subfield code="${s.code}">${xmlEscape(s.value)}</subfield>`)
    .join('\n');
  return body ? `    <datafield tag="${tag}" ind1="${ind1}" ind2="${ind2}">\n${body}\n    </datafield>` : '';
}

async function enrichByIsbn(isbn, prefer) {
  const [ol, gg, dnb, loc, bnb] = await Promise.all([fetchOpenLibrary(isbn), fetchGoogle(isbn), fetchDnb(isbn), fetchLoc(isbn), fetchBnb(isbn)]);
  const dnbParsed = parseDnbMarcXml(dnb.dnbXml);
  const locParsed = parseDnbMarcXml(loc.locXml);
  const bnbParsed = parseBnbJsonLd(bnb.bnbJson);
  const order = buildSourceOrder(prefer);

  const openLibraryAuthors = normalizePersonList([
    ...(ol.bookDoc?.authors || []).map((author) => author?.name || ''),
    ...(ol.doc?.author_name || []),
  ]).join('; ');
  const googleAuthors = normalizePersonList(gg.googleDoc?.authors || []).join('; ');
  const dnbAuthors = normalizePersonList(dnbParsed.authors || []).join('; ');
  const locAuthors = normalizePersonList(locParsed.authors || []).join('; ');
  const bnbAuthors = normalizePersonList(bnbParsed.authors || []).join('; ');

  const titleBySource = {
    openlibrary: ol.bookDoc?.title || ol.doc?.title || '',
    google: gg.googleDoc?.title || '',
    dnb: dnbParsed.title || '',
    loc: locParsed.title || '',
    bnb: bnbParsed.title || ''
  };
  const title = pickBySourceOrder(titleBySource, order);

  const publisher = pickBySourceOrder(
    {
      openlibrary: ol.bookDoc?.publishers?.[0]?.name || ol.doc?.publisher?.[0] || '',
      google: gg.googleDoc?.publisher || '',
      dnb: dnbParsed.publisher || '',
      loc: locParsed.publisher || '',
      bnb: bnbParsed.publisher || ''
    },
    order,
  );

  const publishPlace = pickBySourceOrder(
    {
      openlibrary: pickOpenLibraryPublishPlace(ol.bookDoc),
      google: '',
      dnb: dnbParsed.publishPlace || '',
      loc: locParsed.publishPlace || '',
      bnb: bnbParsed.publishPlace || ''
    },
    order,
  );

  const author = pickBySourceOrder(
    {
      openlibrary: openLibraryAuthors,
      google: googleAuthors,
      dnb: dnbAuthors,
      loc: locAuthors,
      bnb: bnbAuthors,
    },
    order,
  );

  const publishDate = pickBySourceOrder(
    {
      openlibrary: ol.bookDoc?.publish_date || '',
      google: gg.googleDoc?.publishedDate || '',
      dnb: dnbParsed.publishDate || '',
      loc: locParsed.publishDate || '',
      bnb: bnbParsed.publishDate || ''
    },
    order,
  );

  const pageCount = pickBySourceOrder(
    {
      openlibrary: ol.bookDoc?.pagination || ol.bookDoc?.number_of_pages || ol.doc?.number_of_pages_median || '',
      google: gg.googleDoc?.pageCount || '',
      dnb: dnbParsed.pageCount || '',
      loc: locParsed.pageCount || '',
      bnb: bnbParsed.pageCount || ''
    },
    order,
  );

  const edition = pickBySourceOrder(
    {
      openlibrary: '',
      google: '',
      dnb: dnbParsed.edition || '',
      loc: locParsed.edition || '',
      bnb: bnbParsed.edition || ''
    },
    order,
  );

  const seriesTitle = pickBySourceOrder(
    {
      openlibrary: pickOpenLibrarySeriesTitle(ol.workDoc, ol.seriesDoc),
      google: '',
      dnb: dnbParsed.seriesTitle || '',
      loc: locParsed.seriesTitle || '',
      bnb: bnbParsed.seriesTitle || ''
    },
    order,
  );

  const seriesVolume = pickBySourceOrder(
    {
      openlibrary: pickOpenLibrarySeriesVolume(ol.workDoc),
      google: '',
      dnb: dnbParsed.seriesVolume || '',
      loc: locParsed.seriesVolume || '',
      bnb: bnbParsed.seriesVolume || ''
    },
    order,
  );

  const formattedTitle = formatMultipartTitle(title, seriesTitle, seriesVolume);

  const languageRaw = pickBySourceOrder(
    {
      openlibrary: pickOpenLibraryLanguage(ol.bookDoc, ol.doc),
      google: gg.googleDoc?.language || '',
      dnb: dnbParsed.languageCode || '',
      loc: locParsed.languageCode || '',
      bnb: bnbParsed.languageCode || ''
    },
    order,
  );

  const languageCode = normalizeLanguageCode(languageRaw);
  const languageNorm = mapLanguageName(languageCode);

  const coverUrl = await resolveCoverUrl(isbn, ol, gg);

  const summary = pickBySourceOrder(
    {
      openlibrary: typeof ol.bookDoc?.notes === 'string' ? ol.bookDoc.notes : '',
      google: gg.googleDoc?.description || '',
      dnb: dnbParsed.summary || '',
      loc: locParsed.summary || '',
      bnb: bnbParsed.summary || ''
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
  if (dnbParsed.dnbId) identifiers.push(`DNB:${dnbParsed.dnbId}`);
  if (locParsed.dnbId) identifiers.push(`LOC:${locParsed.dnbId}`);
  if (bnbParsed.dnbId) identifiers.push(`BNB:${bnbParsed.dnbId}`);

  const contributors = pickContributorsBySourceOrder(
    {
      dnb: dnbParsed.contributors || [],
      loc: locParsed.contributors || [],
      bnb: bnbParsed.contributors || [],
      openlibrary: [],
      google: [],
    },
    order,
  );

  const sourceUrls = {
    openlibrary: ol.searchUrl,
    google: gg.googleUrl,
    dnb: dnb.dnbUrl,
    loc: loc.locUrl,
    bnb: bnb.bnbJson ? bnb.bnbUrl : '',
  };
  const sourceUsed = pickSourceByOrder(titleBySource, order) || pickSourceByOrder(sourceUrls, order);

  return {
    isbn,
    title: formattedTitle,
    author,
    contributors,
    publisher,
    publishPlace,
    publishDate,
    pageCount,
    edition,
    seriesTitle,
    seriesVolume,
    languageCode,
    languageNorm,
    targetAudience: String(gg.googleDoc?.maturityRating || '').toUpperCase() === 'NOT_MATURE' ? 'Kinder/Jugend' : '',
    shortDescription: summary.slice(0, 280),
    summary,
    coverUrl,
    identifiers: dedupe(identifiers).join('; '),
    sourceUsed,
    sourceUrl: pickBySourceOrder(sourceUrls, order),
    raw: { ol, gg, dnb, dnbParsed, loc, locParsed, bnb, bnbParsed }
  };
}

function buildMarcRecord(row) {
  const authors = normalizePersonList(String(row.author || '').split(';'));
  const contributorRows = Array.isArray(row.contributors) ? row.contributors : [];

  const dnbContributorFields = contributorRows
    .map((entry) => {
      const name = String(entry?.name || '').trim();
      if (!name) return '';

      const relatorCode = String(entry?.relatorCode || '').trim().toLowerCase();
      const relatorText = String(entry?.relatorText || '').trim().toLowerCase();
      const isAuthor = relatorCode === 'aut' || /verfasser|author/.test(relatorText);
      const isPrimaryAuthor = authors[0] && name.toLowerCase() === authors[0].toLowerCase() && isAuthor;
      if (isPrimaryAuthor) return '';

      const tag = entry?.tag === '710' || entry?.tag === '110' ? '710' : '700';
      return tagDataField(tag, tag === '710' ? '2' : '1', ' ', [
        { code: 'a', value: name },
        { code: '4', value: relatorCode },
      ]);
    })
    .filter(Boolean);

  const datafields = [
    tagDataField('020', ' ', ' ', [{ code: 'a', value: row.isbn }]),
    tagDataField('100', '1', ' ', [{ code: 'a', value: authors[0] || '' }]),
    ...(dnbContributorFields.length
      ? dnbContributorFields
      : authors.slice(1).map((author) => tagDataField('700', '1', ' ', [{ code: 'a', value: author }, { code: '4', value: 'aut' }]))),
    tagDataField('245', '1', '0', [{ code: 'a', value: row.title }]),
    tagDataField('250', ' ', ' ', [{ code: 'a', value: row.edition }]),
    tagDataField('264', ' ', '1', [
      { code: 'a', value: row.publishPlace },
      { code: 'b', value: row.publisher },
      { code: 'c', value: row.publishDate },
    ]),
    tagDataField('300', ' ', ' ', [{ code: 'a', value: formatMarcExtent(row.pageCount) }]),
    tagDataField('490', '0', ' ', [{ code: 'a', value: row.seriesTitle }, { code: 'v', value: row.seriesVolume }]),
    tagDataField('041', '0', ' ', [{ code: 'a', value: row.languageCode }]),
    tagDataField('546', ' ', ' ', [{ code: 'a', value: `Sprache: ${row.languageNorm}` }]),
    tagDataField('521', ' ', ' ', [{ code: 'a', value: row.targetAudience }]),
    tagDataField('520', ' ', ' ', [{ code: 'a', value: row.shortDescription }]),
    tagDataField('035', ' ', ' ', [{ code: 'a', value: row.identifiers }]),
    tagDataField('856', '4', '0', [{ code: 'u', value: row.sourceUrl }]),
    tagDataField('856', '4', '2', [{ code: 'u', value: row.coverUrl }, { code: 'y', value: 'Cover' }]),
  ].filter(Boolean);

  return `  <record>\n    <leader>00000nam a2200000 i 4500</leader>\n    <controlfield tag="003">WEB</controlfield>\n${datafields.join('\n')}\n  </record>`;
}

async function rowsToXlsxBuffer(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ISBN-Liste');
  ws.columns = [
    { header: 'isbn', key: 'isbn', width: 18 },
    { header: 'titel', key: 'title', width: 40 },
    { header: 'verfasser', key: 'author', width: 32 },
    { header: 'auflage', key: 'edition', width: 18 },
    { header: 'gesamttitel', key: 'seriesTitle', width: 28 },
    { header: 'bandnummer', key: 'seriesVolume', width: 14 },
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

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'bib-schreibshop' });
});

app.get('/api/admin/stats', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Nicht autorisiert.' });
  }

  const entries = await readAuditEntries();
  return res.json(buildAuditStats(entries));
});

app.get('/api/admin/logs', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Nicht autorisiert.' });
  }

  try {
    const content = await readFile(AUDIT_LOG_FILE, 'utf8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="export-audit-${Date.now()}.log"`);
    return res.send(content);
  } catch {
    return res.status(404).json({ error: 'Noch kein Audit-Log vorhanden.' });
  }
});

app.post('/api/lookup', async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const rate = checkLookupRateLimit(clientIp);
    res.setHeader('X-RateLimit-Limit', String(LOOKUP_RATE_LIMIT_MAX));
    res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
    res.setHeader('X-RateLimit-Reset-Ms', String(rate.resetMs));

    if (rate.blocked) {
      await writeAuditLog({
        ts: new Date().toISOString(),
        event: 'rate_limited',
        ip: clientIp,
      });
      return res.status(429).json({ error: 'Zu viele Anfragen. Bitte kurz warten.' });
    }

    if (!isAuthorized(req)) {
      await writeAuditLog({
        ts: new Date().toISOString(),
        event: 'auth_failed',
        ip: clientIp,
      });
      return res.status(401).json({ error: 'Nicht autorisiert.' });
    }

    const prefer = normalizePrefer(req.body?.prefer);
    const inputValues = Array.isArray(req.body?.isbns)
      ? req.body.isbns
      : String(req.body?.isbns || '').split(/\r?\n/);

    const isbns = dedupe(inputValues.map((line) => extractIsbn(line)).filter(Boolean)).slice(0, 100);
    if (isbns.length === 0) {
      return res.json({ results: [] });
    }

    const results = [];
    for (const isbn of isbns) {
      try {
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
          author: row.author,
          publisher: row.publisher,
          publishDate: row.publishDate,
          sourceUsed: row.sourceUsed,
          coverUrl: row.coverUrl,
          status: 'ok',
        });
      } catch (error) {
        results.push({
          isbn,
          title: '',
          status: 'error',
          error: error?.message || 'Lookup fehlgeschlagen',
        });
      }
    }

    await writeAuditLog({
      ts: new Date().toISOString(),
      event: 'lookup_ok',
      ip: clientIp,
      prefer,
      inputCount: isbns.length,
      foundCount: results.filter((r) => r.status === 'ok').length,
    });

    return res.json({ results });
  } catch (error) {
    await writeAuditLog({
      ts: new Date().toISOString(),
      event: 'lookup_error',
      message: error.message,
      ip: getClientIp(req),
    });
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/export', async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const rate = checkRateLimit(clientIp);
    res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
    res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
    res.setHeader('X-RateLimit-Reset-Ms', String(rate.resetMs));

    if (rate.blocked) {
      await writeAuditLog({
        ts: new Date().toISOString(),
        event: 'rate_limited',
        ip: clientIp,
      });
      return res.status(429).json({ error: 'Zu viele Anfragen. Bitte kurz warten.' });
    }

    if (!isAuthorized(req)) {
      await writeAuditLog({
        ts: new Date().toISOString(),
        event: 'auth_failed',
        ip: clientIp,
      });
      return res.status(401).json({ error: 'Nicht autorisiert.' });
    }

    const rawInput = req.body?.isbns ?? '';
    const prefer = normalizePrefer(req.body?.prefer);
    const exportFormat = normalizeExportFormat(req.body?.format);

    const isbns = dedupe(
      String(rawInput)
        .split(/\r?\n/)
        .map((line) => extractIsbn(line))
        .filter(Boolean),
    );

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

    const csvHeader = 'isbn,titel,verfasser,auflage,gesamttitel,bandnummer,verlag,erscheinungsort,erscheinungsdatum,seitenanzahl,sprache_code,sprache_normiert,zielgruppe,identifikatoren,kurzbeschreibung,zusammenfassung,cover_url';
    const csvRows = rows.map((r) =>
      [
        r.isbn,
        r.title,
        r.author,
        r.edition,
        r.seriesTitle,
        r.seriesVolume,
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
      ]
        .map(csvEscape)
        .join(','),
    );
    const csv = `${csvHeader}\n${csvRows.join('\n')}\n`;

    if (exportFormat === 'marc21') {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="isbn-records-${Date.now()}.marc21.xml"`);
      res.send(xml);
    } else {
      const missesCsv = `isbn,reason\n${misses.map((m) => `${csvEscape(m.isbn)},${csvEscape(m.reason)}`).join('\n')}\n`;
      const xlsx = await rowsToXlsxBuffer(rows);

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="bib-export-${Date.now()}.zip"`);

      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (err) => {
        throw err;
      });

      archive.pipe(res);
      archive.append(xml, { name: 'isbn-records.marc21.xml' });
      archive.append(csv, { name: 'isbn-records-list.csv' });
      archive.append(xlsx, { name: 'isbn-records-list.xlsx' });
      archive.append(missesCsv, { name: 'isbn-misses.csv' });
      archive.append(
        JSON.stringify(
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
        { name: 'export-meta.json' },
      );
      await archive.finalize();
    }

    await writeAuditLog({
      ts: new Date().toISOString(),
      event: 'export_ok',
      ip: clientIp,
      prefer,
      format: exportFormat,
      inputCount: isbns.length,
      validCount: validIsbns.length,
      exportedCount: rows.length,
      missCount: misses.length,
      isbns: validIsbns,
    });
  } catch (error) {
    await writeAuditLog({
      ts: new Date().toISOString(),
      event: 'export_error',
      message: error.message,
      ip: getClientIp(req),
    });
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`bib-schreibshop laeuft auf http://localhost:${port}`);
});
