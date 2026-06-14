const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 1200 });

const ALLOWED_ORIGINS = [
  'https://fairfly-frontend.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:5500'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS: origine non autorizzata'));
    }
  }
}));

app.use(express.json({ limit: '10kb' }));

const rateLimitMap = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW = 10 * 60 * 1000;

function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) { entry.count = 0; entry.start = now; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  if (entry.count > RATE_LIMIT) {
    return res.status(429).json({ error: 'Troppe ricerche in poco tempo. Attendi qualche minuto e riprova.' });
  }
  next();
}

const VALID_AIRPORTS = new Set([
  'MXP','BGY','LIN','FCO','CIA','VCE','NAP','BLQ','TRN','PSA','BRI','CTA',
  'BUD','WAW','PRG','VIE','BRU','AMS','BCN','MAD','LIS','ATH','OTP','SOF',
  'ZRH','GVA','LYS','MRS','NTE','DUB','EDI','BHX','STN','LGW','OSL','ARN',
  'CPH','HEL','RIX','TLL','VNO','KRK','KTW','SKG','HER','SPU','DBV','BEG',
  'LJU','TIA','SKP','KUT','TGD','WRO'
]);

function validateSearch(body) {
  const { from, to, date, adults } = body;
  if (!from || !to || !date) return 'Parametri mancanti: from, to, date obbligatori.';
  if (from === to) return 'Aeroporto di partenza e arrivo uguali.';
  if (!VALID_AIRPORTS.has(from)) return `Aeroporto di partenza non valido: ${from}`;
  if (!VALID_AIRPORTS.has(to)) return `Aeroporto di arrivo non valido: ${to}`;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) return 'Formato data non valido.';
  const searchDate = new Date(date);
  const today = new Date();
  today.setHours(0,0,0,0);
  if (searchDate < today) return 'La data di partenza non può essere nel passato.';
  const adultsNum = parseInt(adults);
  if (isNaN(adultsNum) || adultsNum < 1 || adultsNum > 9) return 'Numero passeggeri non valido (1-9).';
  return null;
}

function log(level, message, data = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...data }));
}

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const PORT = process.env.PORT || 3001;

async function callApifyOnce(origin, destination, date, adults) {
  if (!APIFY_TOKEN) throw new Error('Token Apify non configurato sul server.');
  const input = { origin, destination, departDate: date, adults: parseInt(adults), currency: 'EUR', proxyConfiguration: { useApifyProxy: true } };
  const url = `https://api.apify.com/v2/acts/makework36~flight-price-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=120`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 125000);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      const status = res.status;
      if (status === 429) throw new Error('RATE_LIMIT');
      if (status === 401) throw new Error('TOKEN_INVALID');
      throw new Error(`APIFY_${status}`);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('TIMEOUT');
    throw err;
  }
}

async function callApify(origin, destination, date, adults, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await callApifyOnce(origin, destination, date, adults);
    } catch (err) {
      const isRetryable = !['TOKEN_INVALID','TIMEOUT'].includes(err.message);
      if (attempt < retries && isRetryable) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw err;
    }
  }
}

function getPrice(f) {
  const price = f.price ?? f.bestPrice ?? f.totalPrice ?? f.fare ?? null;
  if (price === null) return 0;
  return typeof price === 'string' ? parseFloat(price.replace(/[^0-9.]/g, '')) : price;
}
function getAirline(f) { return f.airline || f.carrier || f.marketingCarrier || f.airlineName || 'Compagnia'; }
function getOrigin(f) { return f.origin || f.from || f.originCode || ''; }
function getDest(f) { return f.destination || f.to || f.destinationCode || ''; }
function getDepTime(f) { const t = f.departureTime || f.departure || f.dep || ''; if (t.includes('T')) return t.split('T')[1].slice(0,5); if (t.match(/\d{2}:\d{2}/)) return t.slice(0,5); return null; }
function getArrTime(f) { const t = f.arrivalTime || f.arrival || f.arr || ''; if (t.includes('T')) return t.split('T')[1].slice(0,5); if (t.match(/\d{2}:\d{2}/)) return t.slice(0,5); return null; }
function getDuration(f) { const m = f.duration || f.durationMinutes || 0; if (!m) return null; return { minutes: m, label: `${Math.floor(m/60)}h ${String(m%60).padStart(2,'0')}m` }; }
function getStops(f) { const s = f.stops || f.numberOfStops || 0; return { count: s, label: s === 0 ? 'diretto' : `${s} scalo` }; }
function getUrl(f) { return f.deepLink || f.bookingUrl || f.url || f.link || null; }
function getSegments(f) { return f.segments || f.legs || []; }

function priceRating(price, avg) {
  if (!avg || avg === 0) return null;
  const ratio = price / avg;
  if (ratio < 0.75) return { level: 'green', label: 'Ottimo prezzo' };
  if (ratio < 1.1) return { level: 'yellow', label: 'Nella media' };
  return { level: 'red', label: 'Sovrapprezzato' };
}

function humanError(err) {
  const msg = err.message || '';
  if (msg === 'TIMEOUT') return 'La ricerca ha impiegato troppo tempo. Riprova tra qualche secondo.';
  if (msg === 'TOKEN_INVALID') return 'Errore di configurazione del server. Contatta il supporto.';
  if (msg === 'RATE_LIMIT') return 'Il servizio è momentaneamente sovraccarico. Riprova tra un minuto.';
  if (msg.startsWith('APIFY_')) return 'Errore nel recupero dei voli. Riprova tra qualche secondo.';
  return 'Errore inaspettato. Riprova tra qualche secondo.';
}

function processFlights(fwdRaw, revRaw, from, to) {
  const normalize = (arr, df, dt) => arr.map(f => ({
    price: getPrice(f), airline: getAirline(f),
    origin: getOrigin(f) || df, destination: getDest(f) || dt,
    depTime: getDepTime(f), arrTime: getArrTime(f),
    duration: getDuration(f), stops: getStops(f),
    url: getUrl(f), segments: getSegments(f)
  })).filter(f => f.price > 0);

  const fwd = normalize(fwdRaw, from, to);
  const rev = normalize(revRaw, to, from);
  const direct = fwd.filter(f => f.origin === from || f.origin === '').sort((a,b) => a.price - b.price);
  const prices = direct.map(f => f.price);
  const avg = prices.length ? prices.reduce((a,b) => a+b, 0) / prices.length : 0;
  const minDirect = prices.length ? Math.min(...prices) : 0;
  const results = [];

  direct.slice(0,4).forEach(f => results.push({ type:'direct', airline:f.airline, price:f.price, rating:priceRating(f.price,avg), depTime:f.depTime, arrTime:f.arrTime, duration:f.duration, stops:f.stops, url:f.url, from, to }));

  rev.filter(f => f.price > 0 && minDirect > 0 && f.price < minDirect * 0.88).sort((a,b) => a.price-b.price).slice(0,2).forEach(f => {
    results.push({ type:'bidirectional', airline:f.airline, price:f.price, origPrice:minDirect, saving:Math.round(minDirect-f.price), rating:priceRating(f.price,avg), depTime:f.depTime, arrTime:f.arrTime, duration:f.duration, stops:f.stops, url:f.url, from:to, to:from, explain:`Il biglietto ${to}→${from} acquistato come solo andata costa €${f.price}, contro €${minDirect} del diretto standard.` });
  });

  fwd.filter(f => { const s=f.segments; if(!s||s.length<2) return false; const c=s.map(x=>x.carrier||x.airline||'').filter(Boolean); return new Set(c).size>1; }).sort((a,b)=>a.price-b.price).slice(0,3).forEach(f => {
    const s=f.segments, hub=s[0]?.destination||'?', al1=s[0]?.carrier||f.airline, al2=s[1]?.carrier||f.airline;
    results.push({ type:'virtual', airline:f.airline, airlines:[al1,al2], hub, price:f.price, rating:priceRating(f.price,avg), depTime:f.depTime, arrTime:f.arrTime, duration:f.duration, stops:f.stops, url:f.url, from, to, segments:s.slice(0,2).map(x=>({ airline:x.carrier||x.airline||'', from:x.origin||'', to:x.destination||'' })) });
  });

  results.sort((a,b) => a.price-b.price);
  if (results.length > 0) results[0].isBest = true;
  return { results, meta: { avgPrice:Math.round(avg), minDirectPrice:minDirect, minPrice:results[0]?.price||0, totalResults:results.length, directCount:results.filter(r=>r.type==='direct').length, bidirCount:results.filter(r=>r.type==='bidirectional').length, virtualCount:results.filter(r=>r.type==='virtual').length } };
}

app.get('/', (req, res) => { res.json({ status:'ok', service:'FairFly Backend', version:'2.0.0' }); });

app.post('/api/search', rateLimit, async (req, res) => {
  const validationError = validateSearch(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  const { from, to, date, adults=1, tripType='oneway' } = req.body;
  const cacheKey = `${from}-${to}-${date}-${adults}`;
  const cached = cache.get(cacheKey);
  if (cached) { log('info','Cache hit',{cacheKey}); return res.json({...cached, cached:true}); }
  const start = Date.now();
  log('info','Ricerca avviata',{from,to,date,adults,tripType});
  try {
    const searches = [callApify(from,to,date,adults)];
    if (tripType==='oneway') searches.push(callApify(to,from,date,adults));
    else searches.push(Promise.resolve([]));
    const [fwdResult, revResult] = await Promise.allSettled(searches);
    const fwd = fwdResult.status==='fulfilled' ? fwdResult.value : [];
    const rev = revResult.status==='fulfilled' ? revResult.value : [];
    if (fwdResult.status==='rejected') throw fwdResult.reason;
    if (fwd.length===0) return res.status(404).json({ error:'Nessun volo trovato. Prova con date diverse o aeroporti alternativi.' });
    const processed = processFlights(fwd, rev, from, to);
    cache.set(cacheKey, processed);
    log('info','Ricerca completata',{from,to,results:processed.meta.totalResults,durationMs:Date.now()-start});
    res.json({...processed, cached:false});
  } catch(err) {
    log('error','Ricerca fallita',{from,to,error:err.message,durationMs:Date.now()-start});
    res.status(500).json({ error: humanError(err) });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status:!!APIFY_TOKEN?'ok':'degraded', tokenConfigured:!!APIFY_TOKEN, cacheStats:cache.getStats(), uptime:Math.round(process.uptime()), timestamp:new Date().toISOString() });
});

app.listen(PORT, () => { log('info','FairFly backend avviato',{port:PORT,tokenConfigured:!!APIFY_TOKEN}); });
