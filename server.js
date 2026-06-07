const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 1200 }); // cache 20 minuti

app.use(cors());
app.use(express.json());

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const PORT = process.env.PORT || 3001;

// ── APIFY CALL ────────────────────────────────────────────────────────────
async function callApify(origin, destination, date, adults) {
  if (!APIFY_TOKEN) throw new Error('Token Apify non configurato sul server.');

  const input = {
    origin,
    destination,
    departDate: date,
    adults: parseInt(adults),
    currency: 'EUR',
    proxyConfiguration: { useApifyProxy: true }
  };

  const url = `https://api.apify.com/v2/acts/makework36~flight-price-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=120`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apify error ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return [];
  return data;
}

// ── FIELD EXTRACTORS ──────────────────────────────────────────────────────
function getPrice(f) {
  return f.price || f.bestPrice || f.totalPrice || f.fare || 0;
}
function getAirline(f) {
  return f.airline || f.carrier || f.marketingCarrier || f.airlineName || 'Compagnia';
}
function getOrigin(f) {
  return f.origin || f.from || f.originCode || '';
}
function getDest(f) {
  return f.destination || f.to || f.destinationCode || '';
}
function getDepTime(f) {
  const t = f.departureTime || f.departure || f.dep || f.departureDate || '';
  if (t.includes('T')) return t.split('T')[1].slice(0, 5);
  if (t.match(/\d{2}:\d{2}/)) return t.slice(0, 5);
  return null;
}
function getArrTime(f) {
  const t = f.arrivalTime || f.arrival || f.arr || f.arrivalDate || '';
  if (t.includes('T')) return t.split('T')[1].slice(0, 5);
  if (t.match(/\d{2}:\d{2}/)) return t.slice(0, 5);
  return null;
}
function getDuration(f) {
  const m = f.duration || f.durationMinutes || f.flightDuration || 0;
  if (!m) return null;
  return { minutes: m, label: `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` };
}
function getStops(f) {
  const s = f.stops || f.numberOfStops || 0;
  return { count: s, label: s === 0 ? 'diretto' : `${s} scalo` };
}
function getUrl(f) {
  return f.deepLink || f.bookingUrl || f.url || f.link || null;
}
function getSegments(f) {
  return f.segments || f.legs || [];
}

// ── PRICE RATING ──────────────────────────────────────────────────────────
function priceRating(price, avg) {
  if (!avg || avg === 0) return null;
  const ratio = price / avg;
  if (ratio < 0.75) return { level: 'green', label: 'Ottimo prezzo' };
  if (ratio < 1.1) return { level: 'yellow', label: 'Nella media' };
  return { level: 'red', label: 'Sovrapprezzato' };
}

// ── PROCESS ENGINE ────────────────────────────────────────────────────────
function processFlights(fwdRaw, revRaw, from, to) {

  // Normalize and validate forward flights
  const fwd = fwdRaw
    .map(f => ({
      raw: f,
      price: getPrice(f),
      airline: getAirline(f),
      origin: getOrigin(f) || from,
      destination: getDest(f) || to,
      depTime: getDepTime(f),
      arrTime: getArrTime(f),
      duration: getDuration(f),
      stops: getStops(f),
      url: getUrl(f),
      segments: getSegments(f)
    }))
    .filter(f => f.price > 0);

  // Normalize reverse flights
  const rev = revRaw
    .map(f => ({
      raw: f,
      price: getPrice(f),
      airline: getAirline(f),
      origin: getOrigin(f) || to,
      destination: getDest(f) || from,
      depTime: getDepTime(f),
      arrTime: getArrTime(f),
      duration: getDuration(f),
      stops: getStops(f),
      url: getUrl(f),
      segments: getSegments(f)
    }))
    .filter(f => f.price > 0);

  // Direct flights (forward, non-stop or with stops, same route)
  const direct = fwd
    .filter(f => f.origin === from || f.origin === '')
    .sort((a, b) => a.price - b.price);

  const prices = direct.map(f => f.price);
  const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
  const minDirect = prices.length ? Math.min(...prices) : 0;

  const results = [];

  // --- DIRECT results (top 4)
  direct.slice(0, 4).forEach(f => {
    results.push({
      type: 'direct',
      airline: f.airline,
      price: f.price,
      rating: priceRating(f.price, avg),
      depTime: f.depTime,
      arrTime: f.arrTime,
      duration: f.duration,
      stops: f.stops,
      url: f.url,
      from,
      to
    });
  });

  // --- BIDIRECTIONAL: only show if genuinely cheaper (>12% cheaper than cheapest direct)
  // and only on ONE-WAY searches (checked on frontend)
  const bidirThreshold = minDirect * 0.88;
  rev
    .filter(f => f.price > 0 && f.price < bidirThreshold)
    .sort((a, b) => a.price - b.price)
    .slice(0, 2)
    .forEach(f => {
      results.push({
        type: 'bidirectional',
        airline: f.airline,
        price: f.price,
        origPrice: minDirect,
        saving: minDirect - f.price,
        rating: priceRating(f.price, avg),
        depTime: f.depTime,
        arrTime: f.arrTime,
        duration: f.duration,
        stops: f.stops,
        url: f.url,
        from: to,   // reversed
        to: from,   // reversed
        explain: `Il biglietto ${to}→${from} acquistato come solo andata costa €${f.price}, contro €${minDirect} del diretto standard. Stessa tratta fisica, prezzo del mercato di destinazione.`
      });
    });

  // --- VIRTUAL INTERLINING: multi-stop with different airlines per segment
  fwd
    .filter(f => {
      const segs = f.segments;
      if (!segs || segs.length < 2) return false;
      // Check that segments have different carriers
      const carriers = segs.map(s => s.carrier || s.airline || '').filter(Boolean);
      const unique = new Set(carriers);
      return unique.size > 1;
    })
    .sort((a, b) => a.price - b.price)
    .slice(0, 3)
    .forEach(f => {
      const segs = f.segments;
      const hub = segs[0]?.destination || segs[0]?.arrival?.airport || '?';
      const al1 = segs[0]?.carrier || segs[0]?.airline || f.airline;
      const al2 = segs[1]?.carrier || segs[1]?.airline || f.airline;
      results.push({
        type: 'virtual',
        airline: f.airline,
        airlines: [al1, al2],
        hub,
        price: f.price,
        rating: priceRating(f.price, avg),
        depTime: f.depTime,
        arrTime: f.arrTime,
        duration: f.duration,
        stops: f.stops,
        url: f.url,
        from,
        to,
        segments: segs.map(s => ({
          airline: s.carrier || s.airline || '',
          from: s.origin || s.departure?.airport || '',
          to: s.destination || s.arrival?.airport || '',
          dep: s.departureTime || s.departure?.time || '',
          arr: s.arrivalTime || s.arrival?.time || ''
        }))
      });
    });

  // Sort all results by price, mark best
  results.sort((a, b) => a.price - b.price);
  if (results.length > 0) results[0].isBest = true;

  return {
    results,
    meta: {
      avgPrice: Math.round(avg),
      minDirectPrice: minDirect,
      minPrice: results[0]?.price || 0,
      totalResults: results.length,
      directCount: results.filter(r => r.type === 'direct').length,
      bidirCount: results.filter(r => r.type === 'bidirectional').length,
      virtualCount: results.filter(r => r.type === 'virtual').length
    }
  };
}

// ── ROUTES ────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'FairFly Backend', version: '1.0.0' });
});

// Main search endpoint
app.post('/api/search', async (req, res) => {
  const { from, to, date, adults = 1, tripType = 'oneway' } = req.body;

  if (!from || !to || !date) {
    return res.status(400).json({ error: 'Parametri mancanti: from, to, date obbligatori.' });
  }
  if (from === to) {
    return res.status(400).json({ error: 'Aeroporto di partenza e arrivo uguali.' });
  }

  const cacheKey = `${from}-${to}-${date}-${adults}`;

  // Return cached result if available
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] ${cacheKey}`);
    return res.json({ ...cached, cached: true });
  }

  console.log(`[SEARCH] ${from} → ${to} | ${date} | ${adults} adulti`);

  try {
    // Run forward and reverse search in parallel
    const [fwdRaw, revRaw] = await Promise.allSettled([
      callApify(from, to, date, adults),
      tripType === 'oneway' ? callApify(to, from, date, adults) : Promise.resolve([])
    ]);

    const fwd = fwdRaw.status === 'fulfilled' ? fwdRaw.value : [];
    const rev = revRaw.status === 'fulfilled' ? revRaw.value : [];

    if (fwd.length === 0) {
      return res.status(404).json({ error: 'Nessun volo trovato per questa rotta e data.' });
    }

    const processed = processFlights(fwd, rev, from, to);

    // Store in cache
    cache.set(cacheKey, processed);

    console.log(`[RESULT] ${processed.meta.totalResults} risultati | min €${processed.meta.minPrice}`);

    res.json({ ...processed, cached: false });

  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Cache stats (debug)
app.get('/api/cache-stats', (req, res) => {
  res.json(cache.getStats());
});

app.listen(PORT, () => {
  console.log(`FairFly backend in ascolto su porta ${PORT}`);
  if (!APIFY_TOKEN) console.warn('ATTENZIONE: APIFY_TOKEN non configurato.');
});
