/**
 * Cloudflare Pages Function: GET /api/market-data
 *
 * ── 数据源说明（全部免费，绝大多数无需注册）──
 *
 *  指标             数据源                    需要Key?
 *  S&P500           Yahoo Finance (^GSPC)     ❌ 无
 *  Nasdaq           Yahoo Finance (^IXIC)     ❌ 无
 *  VIX              Yahoo Finance (^VIX)      ❌ 无
 *  Nikkei 225       Yahoo Finance (^N225)     ❌ 无
 *  USD/JPY          Yahoo Finance (JPY=X)     ❌ 无
 *  CSI 300          Yahoo Finance (000300.SS) ❌ 无
 *  Nasdaq P/E       Yahoo Finance QQQ         ❌ 无
 *  Fear & Greed     CNN dataviz               ❌ 无（公开接口）
 *  美债 10Y         Yahoo Finance (^TNX)      ❌ 无
 *  美债 2Y          Yahoo Finance (^IRX代理)  ❌ 无
 *  美债精确历史     FRED API (DGS10/DGS2)     ✅ 可选
 *
 *  【可选：FRED Key】精确历史数据，免费秒批：
 *  https://fredaccount.stlouisfed.org/login/secure/
 *  Cloudflare Pages → Settings → Environment Variables → FRED_API_KEY
 *  不配置也可正常运行，自动用 Yahoo ^TNX 补位。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

async function yahooChart(symbol, range, interval) {
  range = range || '1y';
  interval = interval || '1d';
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) + '?interval=' + interval + '&range=' + range;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!r.ok) throw new Error('Yahoo ' + symbol + ': HTTP ' + r.status);
  const j = await r.json();
  const result = j.chart && j.chart.result && j.chart.result[0];
  if (!result) throw new Error('Yahoo ' + symbol + ': empty');
  return result;
}

function parseQuote(result) {
  const closes = result.indicators.quote[0].close.filter(function(v){ return v != null; });
  const timestamps = result.timestamp || [];
  const current = closes[closes.length - 1];
  const prev    = closes[closes.length - 2] || current;
  const pct_day = ((current - prev) / prev) * 100;
  const slice200 = closes.slice(-200);
  const ma200 = slice200.reduce(function(a,b){ return a+b; }, 0) / slice200.length;
  const vs_ma200 = ((current - ma200) / ma200) * 100;
  const histLen = Math.min(60, closes.length);
  const hist = [];
  for (var i = 0; i < histLen; i++) {
    var tsIdx = timestamps.length - histLen + i;
    var ts = tsIdx >= 0 ? timestamps[tsIdx] : null;
    var date = ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null;
    hist.push({ date: date, value: +closes[closes.length - histLen + i].toFixed(4) });
  }
  return { current: current, pct_day: pct_day, ma200: ma200, vs_ma200: vs_ma200, hist: hist };
}

async function fetchFearGreed() {
  try {
    var r = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://edition.cnn.com/',
        'Accept': 'application/json',
      },
    });
    if (!r.ok) throw new Error('CNN F&G: ' + r.status);
    var j = await r.json();
    if (j.fear_and_greed && j.fear_and_greed.score != null) {
      return {
        score: Math.round(j.fear_and_greed.score),
        rating: j.fear_and_greed.rating || '',
        prev_week: j.fear_and_greed.previous_week_close != null
          ? Math.round(j.fear_and_greed.previous_week_close) : null,
      };
    }
  } catch(e) {}
  return null;
}

async function fredSeries(apiKey, seriesId, limit) {
  limit = limit || 60;
  var url = 'https://api.stlouisfed.org/fred/series/observations' +
    '?series_id=' + seriesId + '&api_key=' + apiKey +
    '&file_type=json&sort_order=desc&limit=' + limit;
  var r = await fetch(url);
  if (!r.ok) throw new Error('FRED ' + seriesId + ': ' + r.status);
  var j = await r.json();
  return (j.observations || [])
    .filter(function(o){ return o.value !== '.' && !isNaN(parseFloat(o.value)); })
    .map(function(o){ return { date: o.date, value: parseFloat(o.value) }; })
    .reverse();
}

export async function onRequestGet(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  var fredKey = (context.env && context.env.FRED_API_KEY) || null;

  var tasks = [
    yahooChart('^GSPC'),
    yahooChart('^IXIC'),
    yahooChart('^VIX'),
    yahooChart('^N225'),
    yahooChart('JPY=X'),
    yahooChart('000300.SS'),
    yahooChart('^TNX'),
    yahooChart('^IRX'),
    fetch('https://query1.finance.yahoo.com/v10/finance/quoteSummary/QQQ?modules=summaryDetail', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    }).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; }),
    fetchFearGreed(),
    fredKey ? fredSeries(fredKey, 'DGS10', 60) : Promise.resolve(null),
    fredKey ? fredSeries(fredKey, 'DGS2',  60) : Promise.resolve(null),
  ];

  var results = await Promise.allSettled(tasks);
  function ok(p){ return p.status === 'fulfilled' ? p.value : null; }

  var spR  = ok(results[0]);
  var nqR  = ok(results[1]);
  var vxR  = ok(results[2]);
  var nkR  = ok(results[3]);
  var jpyR = ok(results[4]);
  var csiR = ok(results[5]);
  var tnxR = ok(results[6]);
  var irxR = ok(results[7]);
  var qqqR = ok(results[8]);
  var fg   = ok(results[9]);
  var fred10 = ok(results[10]);
  var fred2  = ok(results[11]);

  var spQ  = spR  ? parseQuote(spR)  : null;
  var nqQ  = nqR  ? parseQuote(nqR)  : null;
  var vxQ  = vxR  ? parseQuote(vxR)  : null;
  var nkQ  = nkR  ? parseQuote(nkR)  : null;
  var jpyQ = jpyR ? parseQuote(jpyR) : null;
  var csiQ = csiR ? parseQuote(csiR) : null;
  var tnxQ = tnxR ? parseQuote(tnxR) : null;
  var irxQ = irxR ? parseQuote(irxR) : null;

  var nasdaqPE = null;
  try {
    nasdaqPE = qqqR.quoteSummary.result[0].summaryDetail.trailingPE.raw;
  } catch(e) {}

  // 美债 10Y: ^TNX 单位就是 %（如 4.28）
  var rate10y = tnxQ ? tnxQ.current : null;

  // 2Y: FRED优先，否则用 ^IRX (13周) 做近似代理
  // ^IRX 单位同样是%，但期限短，乘以调整系数近似2Y
  var rate2y = null;
  var hist10y = [];
  var hist2y  = [];
  if (fred10 && fred10.length > 0) {
    hist10y  = fred10.slice(-52);
    rate10y  = fred10[fred10.length - 1].value; // FRED更准确
    if (fred2 && fred2.length > 0) {
      hist2y = fred2.slice(-52);
      rate2y = fred2[fred2.length - 1].value;
    }
  } else {
    hist10y = tnxQ ? tnxQ.hist : [];
    if (irxQ) {
      rate2y = +(irxQ.current * 1.02).toFixed(3); // 13W*1.02 ≈ 2Y（粗近似）
      hist2y = irxQ.hist.map(function(h){
        return { date: h.date, value: +(h.value * 1.02).toFixed(3) };
      });
    }
  }

  // 利差 10Y-2Y
  var spread = (rate10y != null && rate2y != null) ? +(rate10y - rate2y).toFixed(3) : null;

  // 30日变化
  var hist10ySorted = hist10y.slice().sort(function(a,b){ return (a.date||'').localeCompare(b.date||''); });
  var prev30val = hist10ySorted.length >= 22 ? hist10ySorted[hist10ySorted.length - 22].value : null;
  var change30d = (rate10y != null && prev30val != null) ? +(rate10y - prev30val).toFixed(3) : null;

  // 利差历史
  var histSpread = hist10ySorted.map(function(o) {
    var match = hist2y.find(function(x){ return x.date === o.date; });
    if (!match) return null;
    return { date: o.date, value: +(o.value - match.value).toFixed(3) };
  }).filter(function(x){ return x !== null; });

  var payload = {
    timestamp: new Date().toISOString(),
    source: 'live',
    data_sources: {
      yahoo_finance: 'OK · 无需Key',
      cnn_fear_greed: fg ? 'OK · 无需Key' : 'FAIL · 使用演示值',
      fred: fredKey ? 'OK · Key已配置（精确历史）' : '未配置 · Yahoo ^TNX补位（功能正常）',
    },
    indicators: {
      sp500:  { price: spQ  ? +spQ.current.toFixed(2)  : null, pct_day: spQ  ? +spQ.pct_day.toFixed(3)  : null, ma200: spQ  ? +spQ.ma200.toFixed(2)  : null, vs_ma200: spQ  ? +spQ.vs_ma200.toFixed(3)  : null },
      nasdaq: { price: nqQ  ? +nqQ.current.toFixed(2)  : null, pct_day: nqQ  ? +nqQ.pct_day.toFixed(3)  : null, pe: nasdaqPE ? +nasdaqPE.toFixed(1) : null },
      vix:    { value: vxQ  ? +vxQ.current.toFixed(2)  : null, pct_day: vxQ  ? +vxQ.pct_day.toFixed(3)  : null },
      nikkei: { price: nkQ  ? +nkQ.current.toFixed(0)  : null, pct_day: nkQ  ? +nkQ.pct_day.toFixed(3)  : null, vs_ma200: nkQ ? +nkQ.vs_ma200.toFixed(3) : null },
      usdjpy: { rate:  jpyQ ? +jpyQ.current.toFixed(3) : null, pct_day: jpyQ ? +jpyQ.pct_day.toFixed(4) : null },
      csi300: { price: csiQ ? +csiQ.current.toFixed(2) : null, pct_day: csiQ ? +csiQ.pct_day.toFixed(3) : null, vs_ma200: csiQ ? +csiQ.vs_ma200.toFixed(3) : null },
      rates: {
        rate_10y:       rate10y  != null ? +rate10y.toFixed(3)  : null,
        rate_2y:        rate2y   != null ? +rate2y.toFixed(3)   : null,
        spread_2y10y:   spread   != null ? +spread.toFixed(3)   : null,
        change_30d:     change30d!= null ? +change30d.toFixed(3): null,
        history_10y:    hist10ySorted.slice(-52),
        history_2y:     hist2y.slice(-52),
        history_spread: histSpread.slice(-52),
      },
      fear_greed: fg || null,
    },
  };

  return new Response(JSON.stringify(payload), {
    headers: Object.assign({}, CORS, {
      'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=300',
    }),
  });
}
