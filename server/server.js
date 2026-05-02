const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const DEFAULT_CLIENT_KEY = 'codex-default-client';

app.use(cors({
  origin: true,
  credentials: false,
  allowedHeaders: ['Content-Type', 'X-Codex-Client'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: true, limit: '6mb' }));
app.use(express.static(CLIENT_DIR));

const codexStoreSchema = new mongoose.Schema({
  clientKey: { type: String, required: true, unique: true, index: true },
  books: { type: [mongoose.Schema.Types.Mixed], default: [] },
  prefs: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

codexStoreSchema.pre('save', function updateTimestamp(next) {
  this.updatedAt = new Date();
  next();
});

const CodexStore = mongoose.model('CodexStore', codexStoreSchema);
const memoryStores = new Map();
let mongoReady = false;

function sanitizeClientKey(value) {
  const raw = String(value || DEFAULT_CLIENT_KEY).trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9_:\-.]/g, '').slice(0, 140);
  return cleaned || DEFAULT_CLIENT_KEY;
}

function clientKeyFromRequest(req) {
  return sanitizeClientKey(req.get('X-Codex-Client'));
}

function defaultStore(clientKey) {
  return { clientKey, books: [], prefs: null, createdAt: new Date(), updatedAt: new Date() };
}

async function getStore(clientKey) {
  if (!mongoReady) {
    if (!memoryStores.has(clientKey)) memoryStores.set(clientKey, defaultStore(clientKey));
    return memoryStores.get(clientKey);
  }

  const store = await CodexStore.findOneAndUpdate(
    { clientKey },
    { $setOnInsert: defaultStore(clientKey) },
    { new: true, upsert: true, lean: false }
  );
  return store;
}

function responseMeta() {
  return { mongoReady, mode: mongoReady ? 'mongodb' : 'memory' };
}


const OPEN_LIBRARY_SEARCH_FIELDS = [
  'title',
  'author_name',
  'first_publish_year',
  'isbn',
  'cover_i',
  'number_of_pages_median',
  'subject',
  'key',
  'language',
  'publisher',
  'edition_count'
];

function clampNumber(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function cleanPlainText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength);
}

async function fetchJson(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'CODEX/1.0 metadata proxy'
      },
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; }
    catch { data = { raw: text }; }
    if (!response.ok) {
      const error = new Error(`${label} lookup failed (${response.status})`);
      error.status = response.status >= 400 && response.status < 500 ? response.status : 502;
      error.details = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/api/metadata/openlibrary/search', async (req, res, next) => {
  try {
    const params = new URLSearchParams();
    const q = cleanPlainText(req.query.q);
    const title = cleanPlainText(req.query.title);
    const author = cleanPlainText(req.query.author);

    if (q) params.set('q', q);
    if (title) params.set('title', title);
    if (author) params.set('author', author);
    params.set('limit', String(clampNumber(req.query.limit, 12, 1, 25)));
    params.set('fields', OPEN_LIBRARY_SEARCH_FIELDS.join(','));

    const data = await fetchJson(`https://openlibrary.org/search.json?${params.toString()}`, 'Open Library search');
    res.json(data);
  } catch (err) { next(err); }
});

app.get('/api/metadata/openlibrary/books', async (req, res, next) => {
  try {
    const rawBibkeys = cleanPlainText(req.query.bibkeys, 300);
    const bibkeys = rawBibkeys
      .split(',')
      .map(key => key.trim())
      .filter(key => /^ISBN:[0-9Xx-]+$/.test(key))
      .slice(0, 10)
      .join(',');

    if (!bibkeys) return res.status(400).json({ error: 'Valid ISBN bibkeys are required' });

    const params = new URLSearchParams({
      bibkeys,
      format: 'json',
      jscmd: 'data'
    });
    const data = await fetchJson(`https://openlibrary.org/api/books?${params.toString()}`, 'Open Library ISBN');
    res.json(data);
  } catch (err) { next(err); }
});

app.get('/api/metadata/openlibrary/work/:workId', async (req, res, next) => {
  try {
    const workId = cleanPlainText(req.params.workId, 40).replace(/[^a-zA-Z0-9]/g, '');
    if (!/^OL\d+M$/i.test(workId)) return res.status(400).json({ error: 'Valid Open Library work id is required' });
    const data = await fetchJson(`https://openlibrary.org/works/${encodeURIComponent(workId)}.json`, 'Open Library work');
    res.json(data);
  } catch (err) { next(err); }
});

app.get('/api/metadata/google/books', async (req, res, next) => {
  try {
    const q = cleanPlainText(req.query.q);
    if (!q) return res.json({ items: [] });

    const params = new URLSearchParams({
      q,
      maxResults: String(clampNumber(req.query.maxResults, 12, 1, 25)),
      printType: cleanPlainText(req.query.printType, 20) || 'books',
      langRestrict: cleanPlainText(req.query.langRestrict, 5) || 'en'
    });
    const data = await fetchJson(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`, 'Google Books');
    res.json(data);
  } catch (err) { next(err); }
});

async function saveStore(store, patch) {
  const updatedAt = new Date();
  if (!mongoReady) {
    Object.assign(store, patch, { updatedAt });
    memoryStores.set(store.clientKey, store);
    return store;
  }

  const update = { $set: { ...patch, updatedAt }, $setOnInsert: { createdAt: store.createdAt || new Date() } };
  const saved = await CodexStore.findOneAndUpdate(
    { clientKey: store.clientKey },
    update,
    { new: true, upsert: true, lean: false }
  );
  const savedObject = saved && typeof saved.toObject === 'function' ? saved.toObject() : saved;
  if (savedObject) Object.assign(store, savedObject);
  return saved;
}

async function connectMongo() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URL || '';
  if (!uri) {
    console.warn('MONGODB_URI is not configured. CODEX is using temporary in-memory storage for this process.');
    return;
  }

  try {
    await mongoose.connect(uri);
    mongoReady = true;
    console.log('Connected to MongoDB');
  } catch (err) {
    mongoReady = false;
    console.error('MongoDB connection error. Falling back to temporary in-memory storage:', err.message);
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'codex-backend', ...responseMeta() });
});

app.get('/api/data', async (req, res, next) => {
  try {
    const store = await getStore(clientKeyFromRequest(req));
    res.json({ books: store.books || [], prefs: store.prefs || null, updatedAt: store.updatedAt, ...responseMeta() });
  } catch (err) { next(err); }
});

app.put('/api/data', async (req, res, next) => {
  try {
    const books = Array.isArray(req.body.books) ? req.body.books : [];
    const prefs = req.body.prefs && typeof req.body.prefs === 'object' ? req.body.prefs : null;
    const store = await getStore(clientKeyFromRequest(req));
    await saveStore(store, { books, prefs });
    res.json({ ok: true, books: store.books || [], prefs: store.prefs || null, updatedAt: store.updatedAt, ...responseMeta() });
  } catch (err) { next(err); }
});

app.get('/api/books', async (req, res, next) => {
  try {
    const store = await getStore(clientKeyFromRequest(req));
    res.json({ books: store.books || [], ...responseMeta() });
  } catch (err) { next(err); }
});

app.put('/api/books', async (req, res, next) => {
  try {
    if (!Array.isArray(req.body.books)) return res.status(400).json({ error: 'books must be an array' });
    const store = await getStore(clientKeyFromRequest(req));
    await saveStore(store, { books: req.body.books });
    res.json({ ok: true, books: store.books || [], updatedAt: store.updatedAt, ...responseMeta() });
  } catch (err) { next(err); }
});

app.post('/api/books', async (req, res, next) => {
  try {
    const book = req.body.book;
    if (!book || typeof book !== 'object') return res.status(400).json({ error: 'book object is required' });
    const store = await getStore(clientKeyFromRequest(req));
    const books = [book, ...(store.books || [])];
    await saveStore(store, { books });
    res.status(201).json({ ok: true, book, books: store.books || [], updatedAt: store.updatedAt, ...responseMeta() });
  } catch (err) { next(err); }
});

app.put('/api/books/:id', async (req, res, next) => {
  try {
    const store = await getStore(clientKeyFromRequest(req));
    const books = (store.books || []).slice();
    const index = books.findIndex(book => String(book.id) === String(req.params.id));
    if (index < 0) return res.status(404).json({ error: 'Book not found' });
    books[index] = { ...books[index], ...(req.body.book || req.body) };
    await saveStore(store, { books });
    res.json({ ok: true, book: books[index], books: store.books || [], updatedAt: store.updatedAt, ...responseMeta() });
  } catch (err) { next(err); }
});

app.delete('/api/books/:id', async (req, res, next) => {
  try {
    const store = await getStore(clientKeyFromRequest(req));
    const books = (store.books || []).filter(book => String(book.id) !== String(req.params.id));
    await saveStore(store, { books });
    res.json({ ok: true, books: store.books || [], updatedAt: store.updatedAt, ...responseMeta() });
  } catch (err) { next(err); }
});

app.get('/api/prefs', async (req, res, next) => {
  try {
    const store = await getStore(clientKeyFromRequest(req));
    res.json({ prefs: store.prefs || null, ...responseMeta() });
  } catch (err) { next(err); }
});

app.put('/api/prefs', async (req, res, next) => {
  try {
    if (req.body.prefs && typeof req.body.prefs !== 'object') return res.status(400).json({ error: 'prefs must be an object' });
    const store = await getStore(clientKeyFromRequest(req));
    await saveStore(store, { prefs: req.body.prefs || null });
    res.json({ ok: true, prefs: store.prefs || null, updatedAt: store.updatedAt, ...responseMeta() });
  } catch (err) { next(err); }
});

app.get(['/code.html', '/'], (_req, res) => {
  res.sendFile(path.join(CLIENT_DIR, 'index.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found' });
  res.sendFile(path.join(CLIENT_DIR, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

connectMongo().finally(() => {
  app.listen(PORT, () => {
    console.log(`CODEX server listening on port ${PORT}`);
  });
});
