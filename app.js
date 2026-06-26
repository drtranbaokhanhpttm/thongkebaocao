// ===== CONFIG =====
const AI_KEY_STORAGE = 'lotto-ai-key';
const TOP_K = 3;
const SPECIAL_TOP_K = 10;
const WINDOW = 1500;
const SPECIAL_WINDOW = 100;
const ALL = Array.from({ length: 100 }, (_, i) => String(i).padStart(2, '0'));

// Mô phỏng lặp ngày tiếp theo: dùng chính kết quả thuật toán trước đó làm đầu vào giả lập
function projectFutureTop3(train, days = 3, compositePreset = null) {
  const projections = [];
  let sim = train.map((d) => ({ date: d.date, loto: [...d.loto] }));
  const used = new Set();
  for (let i = 0; i < days; i += 1) {
    const order = compositePreset
      ? compositeOrder(sim.slice(-WINDOW), compositePreset.weights)
      : freqOrder(sim.slice(-WINDOW));
    const diversified = used.size
      ? [...order.filter((n) => !used.has(n)), ...order.filter((n) => used.has(n))]
      : order;
    const prob = diversified.slice(0, TOP_K);
    const top3 = prob.slice(0, 3);
    projections.push({ day: i + 1, prob, top3 });
    top3.forEach((n) => used.add(n));
    // thêm 1 draw giả lập bằng 3 số để mô phỏng ngày tiếp theo
    sim = [...sim, { date: `SIM-${i + 1}`, loto: prob }];
  }
  return projections;
}
const LIVE_CSV_URLS = [
  'https://raw.githubusercontent.com/khiemdoan/vietnam-lottery-xsmb-analysis/main/data/xsmb.csv',
  'https://raw.githubusercontent.com/khiemdoan/vietnam-lottery-xsmb-analysis/master/data/xsmb.csv',
];

// ===== AI =====
let aiSummary = '';
let aiTop3 = [];
let aiSummaryBroad = '';
function getAiKey() { return localStorage.getItem(AI_KEY_STORAGE) || ''; }
function saveAiKey(k) { localStorage.setItem(AI_KEY_STORAGE, k.trim()); }
const LOG_STORAGE_KEY = 'xsmb-prediction-logs';
function loadPredictionLogs() {
  try { return JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || '{}'); } catch (_) { return {}; }
}
function savePredictionLogs(logs) {
  localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(logs));
}
function buildLogEntry({ picked, train, liveInfoText, prob, ens, recent, omission, headTail, aiTop3List, aiSummaryText, aiSummaryBroadText, actualSet, specialNum }) {
  return {
    pickedDate: picked,
    updatedAt: new Date().toISOString(),
    status: actualSet ? 'settled' : 'pending',
    trainCount: train.length,
    trainLatestDate: train[train.length - 1]?.date || '',
    liveInfo: liveInfoText,
    predictions: {
      prob,
      ens,
      recent,
      omission,
      headTail,
      gpt: (aiTop3List || []).map((item) => item.number),
    },
    gpt: {
      choices: aiTop3List || [],
      summary: aiSummaryText || '',
      overview: aiSummaryBroadText || '',
    },
    actualLoto: actualSet ? [...actualSet].sort() : [],
    specialNum: specialNum || '',
  };
}
function upsertPredictionLog(entry) {
  const logs = loadPredictionLogs();
  const existing = logs[entry.pickedDate];
  logs[entry.pickedDate] = {
    createdAt: existing?.createdAt || entry.updatedAt,
    ...entry,
  };
  savePredictionLogs(logs);
}
function exportPredictionLogs() {
  const logs = loadPredictionLogs();
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `xsmb-prediction-logs-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
function renderPredictionLogs() {
  if (!logResult) return;
  const logs = Object.values(loadPredictionLogs()).sort((a, b) => b.pickedDate.localeCompare(a.pickedDate));
  if (!logs.length) {
    logResult.innerHTML = '<div class="shortlist-empty">Chưa có nhật ký.</div>';
    return;
  }
  logResult.innerHTML = `<table class="cmp-table"><thead><tr><th>Ngày</th><th>Trạng thái</th><th>Xác suất</th><th>Ensemble</th><th>Recency</th><th>Omission</th><th>Head-Tail</th><th>GPT</th><th>KQ thật</th></tr></thead><tbody>${logs.map((log) => `<tr><td>${log.pickedDate}</td><td>${log.status}</td><td>${(log.predictions?.prob || []).join(', ') || '—'}</td><td>${(log.predictions?.ens || []).join(', ') || '—'}</td><td>${(log.predictions?.recent || []).join(', ') || '—'}</td><td>${(log.predictions?.omission || []).join(', ') || '—'}</td><td>${(log.predictions?.headTail || []).join(', ') || '—'}</td><td>${(log.predictions?.gpt || []).join(', ') || '—'}</td><td>${(log.actualLoto || []).join(', ') || '—'}</td></tr>`).join('')}</tbody></table>`;
}
function clearPredictionLogs() {
  localStorage.removeItem(LOG_STORAGE_KEY);
  renderPredictionLogs();
}
function normalizeAiChoices(choices) {
  const used = new Set();
  const fallbackRanks = ['A', 'B', 'C'];
  return (Array.isArray(choices) ? choices : [])
    .map((item) => {
      const number = normTwo(item?.number);
      if (!number || used.has(number)) return null;
      used.add(number);
      return {
        rank: String(item?.rank || '').trim(),
        number,
        reason: String(item?.reason || '').trim(),
        confidence: String(item?.confidence || '').trim() || 'trung bình',
      };
    })
    .filter(Boolean)
    .slice(0, 3)
    .map((item, index) => ({
      ...item,
      rank: fallbackRanks[index],
    }));
}
async function fetchAiJson(system, user, maxTokens = 700) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getAiKey()}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return JSON.parse(data.choices?.[0]?.message?.content || '{}');
}
async function callAi(train, picked) {
  if (!getAiKey()) {
    aiTop3 = [];
    aiSummary = '';
    return;
  }
  const summary = buildAiSummary(train, picked);
  const system = 'Bạn là GPT dự đoán độc lập từ dữ liệu lịch sử. Không dùng lại output của các thuật toán khác. Hãy tự chọn 3 số từ dữ liệu thống kê thô và trả JSON hợp lệ.';
  const user = `Dữ liệu lịch sử:\n${summary}\n\nTrả JSON:\n{"summary":"...","choices":[{"rank":"A","number":"XX","reason":"...","confidence":"cao/trung bình/thăm dò"}],"note":"..."}`;
  try {
    const parsed = await fetchAiJson(system, user, 700);
    aiTop3 = normalizeAiChoices(parsed.choices);
    aiSummary = parsed.summary ? `${parsed.summary}\n\n${parsed.note || ''}` : (parsed.note || '');
  } catch (e) {
    aiTop3 = [];
    aiSummary = `Lỗi GPT dự đoán: ${e.message}`;
  }
}
function buildAiSummary(train, picked) {
  const last1000 = train.slice(-1000);
  const freq = Object.fromEntries(ALL.map((n) => [n, 0]));
  last1000.forEach((d) => new Set(d.loto).forEach((n) => { freq[n]++; }));
  const topFreqList = ALL.slice().sort((a, b) => freq[b] - freq[a]).slice(0, 20);
  const topFreq = topFreqList.map((n) => `${n}:${freq[n]}`).join(', ');
  const recent = train.slice(-20);
  const rf = {}; recent.forEach((d) => new Set(d.loto).forEach((n) => { rf[n] = (rf[n] || 0) + 1; }));
  const topRecent = ALL.slice().sort((a, b) => (rf[b] || 0) - (rf[a] || 0)).slice(0, 20).map((n) => `${n}:${rf[n] || 0}`).join(', ');
  const head = Array(10).fill(0); const tail = Array(10).fill(0);
  last1000.forEach((d) => d.loto.forEach((n) => { head[+n[0]]++; tail[+n[1]]++; }));
  return `Ngày: ${picked}\nTop 20 theo tần suất: ${topFreq}\n20 ngày gần đây: ${topRecent}\nĐầu:${head.join(',')}\nĐuôi:${tail.join(',')}\nTổng kỳ: ${train.length}\nYêu cầu: tự chọn độc lập 3 số tốt nhất từ dữ liệu trên.`;
}
function buildAiOverviewSummary(prob, ens, aiChoices, multiRows, picked, compositeSelection) {
  const aiNums = (aiChoices || []).map((item) => item.number).join(', ') || 'chưa có';
  const recent = (multiRows || []).map((row) => `${row.days} ngày: Top3 ${row.top3Rate}% | AI ${row.aiRate}%`).join('; ');
  return `Ngày: ${picked}\nXác suất 3: ${prob.join(', ')}\nEnsemble 3: ${ens.join(', ')}\nGPT dự đoán: ${aiNums}\nPreset composite: ${compositeSelection?.activePreset?.name || 'mặc định'}\nFallback: ${compositeSelection?.fallbackToProbability ? 'có' : 'không'}\nScore: ${(compositeSelection?.activeMetrics?.score || 0).toFixed(3)}\nSo sánh gần đây: ${recent}`;
}
async function callAiOverview(prob, ens, aiChoices, multiRows, picked, compositeSelection) {
  if (!getAiKey()) {
    aiSummaryBroad = '';
    return;
  }
  const system = 'Bạn là GPT tổng hợp kết quả thống kê. Không chọn thêm số mới. Chỉ tóm tắt ngắn gọn, bám đúng số liệu đầu vào, không dùng từ tuyệt đối hoặc cam kết 100%. Trả JSON hợp lệ.';
  const user = `Dữ liệu tổng hợp:\n${buildAiOverviewSummary(prob, ens, aiChoices, multiRows, picked, compositeSelection)}\n\nTrả JSON:\n{"summary":"...","note":"..."}`;
  try {
    const parsed = await fetchAiJson(system, user, 500);
    aiSummaryBroad = parsed.summary ? `${parsed.summary}\n\n${parsed.note || ''}` : (parsed.note || '');
  } catch (e) {
    aiSummaryBroad = `Lỗi GPT tổng hợp: ${e.message}`;
  }
}

// ===== DATA =====
function normTwo(v) { const d = String(v ?? '').replace(/\D/g, ''); return d.length >= 2 ? d.slice(-2) : null; }
function toDraw(rec) {
  if (!rec || !rec.date) return null;
  const prizes = Array.isArray(rec.prizes) ? rec.prizes : [];
  const loto = prizes.map(normTwo).filter(Boolean);
  const special = rec.special ? normTwo(rec.special) : (prizes[0] ? normTwo(prizes[0]) : null);
  return loto.length ? { date: rec.date, loto, special } : null;
}
function loadAllDraws() {
  const base = Array.isArray(window.BUNDLED_XSMB_DRAWS) ? window.BUNDLED_XSMB_DRAWS : [];
  const ref = Array.isArray(window.XSMB_REFERENCE_DRAWS) ? window.XSMB_REFERENCE_DRAWS : [];
  const map = new Map();
  [...base, ...ref].forEach((rec) => { const d = toDraw(rec); if (d && !map.has(d.date)) map.set(d.date, d); });
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}
let DRAWS = loadAllDraws();
let liveInfo = '';

async function fetchLiveResults() {
  const have = new Set(DRAWS.map((d) => d.date));
  for (const url of LIVE_CSV_URLS) {
    try {
      const res = await fetch(url, { headers: { Accept: 'text/csv' } });
      if (!res.ok) continue;
      const lines = (await res.text()).split(/\r?\n/).filter(Boolean);
      lines.shift();
      const added = [];
      for (const line of lines) {
        const cells = line.split(',');
        const date = (cells[0] || '').trim();
        if (!date || have.has(date)) continue;
        const loto = [];
        for (let i = 1; i < cells.length; i++) { const n = normTwo(cells[i]); if (n) loto.push(n); }
        if (loto.length) { added.push({ date, loto, special: loto[0] || null }); have.add(date); }
      }
      if (added.length) DRAWS = [...DRAWS, ...added].sort((a, b) => a.date.localeCompare(b.date));
      liveInfo = added.length ? `Tự cập nhật +${added.length} kỳ (${DRAWS.length}, mới nhất ${DRAWS[DRAWS.length-1].date})` : `Đủ ${DRAWS.length} kỳ, mới nhất ${DRAWS[DRAWS.length-1].date}`;
      return;
    } catch (_) {}
  }
  liveInfo = 'Không tải được online. Dùng dữ liệu sẵn.';
}

// ===== ALGORITHMS =====
function freqOrder(train) {
  const hit = Object.fromEntries(ALL.map((n) => [n, 0]));
  train.forEach((d) => new Set(d.loto).forEach((n) => { hit[n]++; }));
  return ALL.slice().sort((a, b) => hit[b] - hit[a] || a.localeCompare(b));
}
function ensembleOrder(train) {
  const hit = Object.fromEntries(ALL.map((n) => [n, 0]));
  train.forEach((d) => new Set(d.loto).forEach((n) => { hit[n]++; }));
  const maxHit = Math.max(...Object.values(hit), 1);
  const trans = Object.fromEntries(ALL.map((n) => [n, Object.create(null)]));
  const rowTotal = Object.fromEntries(ALL.map((n) => [n, 0]));
  for (let i = 1; i < train.length; i++) {
    const prev = new Set(train[i - 1].loto), cur = new Set(train[i].loto);
    prev.forEach((a) => cur.forEach((b) => { trans[a][b] = (trans[a][b] || 0) + 1; rowTotal[a] += 1; }));
  }
  const ls = train.length ? new Set(train[train.length - 1].loto) : new Set();
  const mk = {}; ALL.forEach((b) => { let s = 0; ls.forEach((a) => { if (rowTotal[a]) s += (trans[a][b] || 0) / rowTotal[a]; }); mk[b] = ls.size ? s / ls.size : 0; });
  const mxM = Math.max(...Object.values(mk), 1e-9);
  return ALL.map((n) => ({ n, s: 0.5 * (hit[n] / maxHit) + 0.5 * (mk[n] / mxM) }))
    .sort((a, b) => b.s - a.s || a.n.localeCompare(b.n)).map((x) => x.n);
}
const COMPOSITE_PRESETS = [
  { name: 'Thuần xác suất', weights: { freq: 1.00, ensemble: 0.00, recent: 0.00, consensus: 0.00, omission: 0.00, lag: 0.00, tail: 0.00 } },
  { name: 'Thuần ensemble', weights: { freq: 0.00, ensemble: 1.00, recent: 0.00, consensus: 0.00, omission: 0.00, lag: 0.00, tail: 0.00 } },
  { name: 'Cân bằng', weights: { freq: 0.28, ensemble: 0.18, recent: 0.16, consensus: 0.12, omission: 0.10, lag: 0.08, tail: 0.08 } },
  { name: 'Bám tần suất', weights: { freq: 0.42, ensemble: 0.12, recent: 0.14, consensus: 0.10, omission: 0.08, lag: 0.07, tail: 0.07 } },
  { name: 'Bám ensemble', weights: { freq: 0.16, ensemble: 0.34, recent: 0.12, consensus: 0.12, omission: 0.08, lag: 0.10, tail: 0.08 } },
  { name: 'Ưu tiên gần', weights: { freq: 0.18, ensemble: 0.12, recent: 0.30, consensus: 0.10, omission: 0.08, lag: 0.12, tail: 0.10 } },
  { name: 'Ổn định', weights: { freq: 0.25, ensemble: 0.18, recent: 0.12, consensus: 0.17, omission: 0.10, lag: 0.08, tail: 0.10 } },
];
function buildRankScoreMap(order) {
  const last = Math.max(order.length - 1, 1);
  const map = Object.fromEntries(ALL.map((n) => [n, 0]));
  order.forEach((n, index) => { map[n] = 1 - index / last; });
  return map;
}
function normalizeScoreMap(map) {
  const max = Math.max(...Object.values(map), 1e-9);
  const out = {};
  ALL.forEach((n) => { out[n] = (map[n] || 0) / max; });
  return out;
}
function buildRecentScoreMap(train, window = 30) {
  const recent = train.slice(-window);
  const raw = Object.fromEntries(ALL.map((n) => [n, 0]));
  recent.forEach((d, index) => {
    const weight = (index + 1) / Math.max(recent.length, 1);
    new Set(d.loto).forEach((n) => { raw[n] += weight; });
  });
  return normalizeScoreMap(raw);
}
function buildOmissionScoreMap(train, cap = 4) {
  const total = train.length;
  const lastIdx = Object.fromEntries(ALL.map((n) => [n, -1]));
  const gaps = Object.fromEntries(ALL.map((n) => [n, []]));
  train.forEach((d, index) => {
    new Set(d.loto).forEach((n) => {
      if (lastIdx[n] >= 0) gaps[n].push(index - lastIdx[n]);
      lastIdx[n] = index;
    });
  });
  const raw = {};
  ALL.forEach((n) => {
    const currentGap = lastIdx[n] >= 0 ? total - 1 - lastIdx[n] : total;
    const avgGap = gaps[n].length ? gaps[n].reduce((sum, gap) => sum + gap, 0) / gaps[n].length : Math.max(1, total / 10);
    raw[n] = Math.min(currentGap / Math.max(avgGap, 1), cap);
  });
  return normalizeScoreMap(raw);
}
function buildLagTransitionScoreMap(train, lags = [1, 2, 3]) {
  const trans = Object.fromEntries(ALL.map((n) => [n, Object.create(null)]));
  const rowTotal = Object.fromEntries(ALL.map((n) => [n, 0]));
  for (let i = 1; i < train.length; i++) {
    const prev = new Set(train[i - 1].loto);
    const cur = new Set(train[i].loto);
    prev.forEach((a) => cur.forEach((b) => { trans[a][b] = (trans[a][b] || 0) + 1; rowTotal[a] += 1; }));
  }
  const recentSets = lags.map((lag) => new Set(train[train.length - lag]?.loto || []));
  const raw = Object.fromEntries(ALL.map((n) => [n, 0]));
  ALL.forEach((candidate) => {
    let score = 0;
    recentSets.forEach((set, index) => {
      const lagWeight = 1 / (index + 1);
      set.forEach((a) => {
        if (rowTotal[a]) score += lagWeight * ((trans[a][candidate] || 0) / rowTotal[a]);
      });
    });
    raw[candidate] = score;
  });
  return normalizeScoreMap(raw);
}
function buildTailSupportScoreMap(train, window = 60) {
  const recent = train.slice(-window);
  const head = Array(10).fill(0);
  const tail = Array(10).fill(0);
  recent.forEach((d) => new Set(d.loto).forEach((n) => {
    head[+n[0]] += 1;
    tail[+n[1]] += 1;
  }));
  const maxHead = Math.max(...head, 1);
  const maxTail = Math.max(...tail, 1);
  const raw = {};
  ALL.forEach((n) => {
    raw[n] = (head[+n[0]] / maxHead) * 0.5 + (tail[+n[1]] / maxTail) * 0.5;
  });
  return raw;
}
function recentOrder(train) {
  const scores = buildRecentScoreMap(train);
  return ALL.slice().sort((a, b) => scores[b] - scores[a] || a.localeCompare(b));
}
function omissionOrder(train) {
  const scores = buildOmissionScoreMap(train);
  return ALL.slice().sort((a, b) => scores[b] - scores[a] || a.localeCompare(b));
}
function headTailOrder(train) {
  const scores = buildTailSupportScoreMap(train);
  return ALL.slice().sort((a, b) => scores[b] - scores[a] || a.localeCompare(b));
}
function compositeOrder(train, weights) {
  const freqScores = buildRankScoreMap(freqOrder(train));
  const ensembleScores = buildRankScoreMap(ensembleOrder(train));
  const recentScores = buildRecentScoreMap(train);
  const omissionScores = buildOmissionScoreMap(train);
  const lagScores = buildLagTransitionScoreMap(train);
  const tailScores = buildTailSupportScoreMap(train);
  return ALL.map((n) => {
    const consensus = (freqScores[n] + ensembleScores[n]) / 2;
    const score =
      weights.freq * freqScores[n] +
      weights.ensemble * ensembleScores[n] +
      weights.recent * recentScores[n] +
      weights.consensus * consensus +
      weights.omission * omissionScores[n] +
      weights.lag * lagScores[n] +
      weights.tail * tailScores[n];
    return { n, s: score };
  }).sort((a, b) => b.s - a.s || a.n.localeCompare(b.n)).map((item) => item.n);
}
function scoreBacktestRows(rows) {
  if (!rows.length) return { score: 0, hitDayRate: 0, avgHitRate: 0, stability: 0, hitDays: 0, totalHits: 0, totalDays: 0 };
  const totalDays = rows.length;
  const hitDays = rows.filter((row) => row.hitsCount > 0).length;
  const totalHits = rows.reduce((sum, row) => sum + row.hitsCount, 0);
  const hitDayRate = hitDays / totalDays;
  const avgHitRate = totalHits / (totalDays * TOP_K);
  const windows = [7, 14, 30].filter((days) => days <= totalDays);
  const rates = windows.map((days) => rows.slice(-days).filter((row) => row.hitsCount > 0).length / days);
  const stability = rates.length > 1 ? 1 - (Math.max(...rates) - Math.min(...rates)) : hitDayRate;
  const totalHitRate = totalHits / Math.max(totalDays, 1);
  const score = totalHitRate * 0.45 + avgHitRate * 0.30 + hitDayRate * 0.15 + stability * 0.10;
  return { score, hitDayRate, avgHitRate, totalHitRate, stability, hitDays, totalHits, totalDays };
}
function backtestCompositePreset(train, preset, days = 30) {
  if (train.length < days + 90) return null;
  const rows = [];
  const startIndex = Math.max(90, train.length - days);
  for (let i = startIndex; i < train.length; i++) {
    const history = train.slice(Math.max(0, i - WINDOW), i);
    if (history.length < 90) continue;
    const actualSet = new Set(train[i].loto);
    const picks = compositeOrder(history, preset.weights).slice(0, TOP_K);
    const hits = picks.filter((n) => actualSet.has(n));
    rows.push({ hitsCount: hits.length });
  }
  return { preset, metrics: scoreBacktestRows(rows) };
}
function evaluatePresetAcrossWindows(train, preset, windows = [14, 30, 60]) {
  const results = windows.map((days) => backtestCompositePreset(train, preset, days)).filter(Boolean);
  if (!results.length) return null;
  const aggregate = results.reduce((acc, item) => {
    acc.score += item.metrics.score;
    acc.hitDayRate += item.metrics.hitDayRate;
    acc.avgHitRate += item.metrics.avgHitRate;
    acc.stability += item.metrics.stability;
    acc.totalHits += item.metrics.totalHits;
    return acc;
  }, { score: 0, hitDayRate: 0, avgHitRate: 0, stability: 0, totalHits: 0 });
  const count = results.length;
  return {
    preset,
    windows,
    metrics: {
      score: aggregate.score / count,
      hitDayRate: aggregate.hitDayRate / count,
      avgHitRate: aggregate.avgHitRate / count,
      stability: aggregate.stability / count,
      totalHits: aggregate.totalHits,
      totalDays: results.reduce((sum, item) => sum + item.metrics.totalDays, 0),
    },
  };
}
function chooseBestCompositePreset(train) {
  const candidates = COMPOSITE_PRESETS
    .map((preset) => evaluatePresetAcrossWindows(train, preset))
    .filter(Boolean)
    .sort((a, b) => b.metrics.score - a.metrics.score || b.metrics.hitDayRate - a.metrics.hitDayRate || b.metrics.totalHits - a.metrics.totalHits);
  const baseline = candidates.find((candidate) => candidate.preset.name === 'Thuần xác suất') || candidates[0];
  const winner = candidates[0] || baseline;
  const beatsBaseline = !!winner && !!baseline && winner.preset.name !== 'Thuần xác suất'
    && winner.metrics.score > baseline.metrics.score + 0.015
    && winner.metrics.hitDayRate >= baseline.metrics.hitDayRate
    && winner.metrics.totalHits >= baseline.metrics.totalHits;
  const active = beatsBaseline ? winner : baseline;
  return {
    activePreset: active.preset,
    activeMetrics: active.metrics,
    bestPreset: winner.preset,
    bestMetrics: winner.metrics,
    baselineMetrics: baseline.metrics,
    fallbackToProbability: !beatsBaseline,
  };
}

// ===== HELPERS =====
function renderNumChips(nums, actualSet) {
  return nums.map((n) => `<span class="algo-num" style="${actualSet && actualSet.has(n) ? 'background:rgba(70,224,168,.28);border-color:var(--good)' : ''}"><strong style="${actualSet && actualSet.has(n) ? 'color:var(--good);font-weight:900' : ''}">${n}</strong></span>`).join('');
}
function renderColumn(title, color, picks, actualSet) {
  const hits = actualSet ? picks.filter((n) => actualSet.has(n)) : [];
  const meta = actualSet ? `Trùng <strong style="color:var(--good)">${hits.length}/${picks.length}</strong> (${Math.round(hits.length / picks.length * 100)}%)` : 'Chưa có kết quả';
  return `<article class="algo-card"><h3 style="color:${color}">${title}</h3><div class="algo-numbers">${renderNumChips(picks, actualSet)}</div><div class="shortlist-meta" style="margin-top:8px">${meta}</div></article>`;
}
function renderMonthLog(picks, title, color, train, picked, actualSet) {
  const prev10 = train.slice(-10).reverse();
  const byMonth = {};
  prev10.forEach((d) => { const ym = d.date.slice(0,7); if (!byMonth[ym]) byMonth[ym] = []; byMonth[ym].push(d); });
  const headerCols = picks.map((n) => `<th class="num-col">${n}</th>`).join('');
  const summary = picks.map((n) => ({ n, days: prev10.filter((d) => new Set(d.loto).has(n)).length }));
  const summaryRow = `<tr class="summary-row"><td style="font-weight:800">Tổng</td>${summary.map((s) => `<td style="font-weight:800;color:${s.days > 0 ? 'var(--good)' : 'var(--text-dim)'}">${s.days}</td>`).join('')}</tr>`;
  let rows = '';
  for (const [ym, days] of Object.entries(byMonth)) {
    const monthName = new Date(ym + '-01').toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' });
    rows += `<tr class="month-row"><td colspan="${picks.length + 1}" style="font-weight:800;color:${color};background:${color}11;padding:8px 11px">📅 ${monthName}</td></tr>`;
    days.forEach((d) => {
      const set = new Set(d.loto);
      const dayLabel = new Date(d.date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
      const marks = picks.map((n) => set.has(n) ? `<td class="hit">✓</td>` : `<td class="miss">·</td>`);
      rows += `<tr><td class="day-label">${dayLabel}</td>${marks.join('')}</tr>`;
    });
  }
  return `<div class="today-summary" style="margin-top:16px"><strong>${title}</strong><span>10 kỳ gần nhất trước ngày ${picked}, hiển thị theo tháng. ✓ = số đó đã về.</span></div><div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table class="month-table"><thead><tr><th>Ngày</th>${headerCols}</tr></thead><tbody>${summaryRow}${rows}</tbody></table></div>`;
}
function buildSpecialReport(train) {
  const last100 = train.filter((d) => d.special).slice(-SPECIAL_WINDOW);
  const hit = Object.fromEntries(ALL.map((n) => [n, 0]));
  const tail = Array(10).fill(0);
  last100.forEach((d) => { if (d.special) { hit[d.special]++; tail[+d.special[1]]++; } });
  const top = ALL.slice().sort((a, b) => hit[b] - hit[a]).slice(0, SPECIAL_TOP_K);
  return { total: last100.length, topNums: top.map((n) => ({ n, c: hit[n] })), tail };
}
function renderSpecialReport(train) {
  const r = buildSpecialReport(train);
  if (!r.total) return '';
  const topNums = r.topNums.map((x) => `<span class="algo-num"><strong>${x.n}</strong> <span style="font-size:.72rem;color:var(--text-dim)">${x.c} lần</span></span>`).join('');
  const maxTail = Math.max(...r.tail, 1);
  const tailBars = r.tail.map((v, i) => `<div style="flex:1;text-align:center"><div style="height:${Math.max(4, Math.round(v / maxTail * 52))}px;background:var(--accent);border-radius:3px 3px 0 0"></div><div style="font-size:.68rem;color:var(--text-dim)">${i}</div></div>`).join('');
  return `<div class="today-summary" style="margin-top:16px"><strong>🏆 Giải Đặc Biệt — ${r.total} kỳ</strong><span>10 số đặc biệt mạnh nhất trong ${SPECIAL_WINDOW} kỳ gần đây.</span></div><div class="algo-grid"><article class="algo-card"><h3 style="color:var(--accent)">10 số đặc biệt mạnh</h3><div class="algo-numbers">${topNums}</div></article><article class="algo-card"><h3 style="color:var(--primary)">Đuôi đặc biệt 0–9</h3><div style="display:flex;gap:3px;align-items:flex-end;height:60px">${tailBars}</div></article></div>`;
}

function computeWindowStats(train, top3, aiTop3) {
  const windows = [2, 3, 4, 5];
  return windows.map((days) => {
    const hist = train.slice(-days);
    const histSet = new Set(hist.flatMap((d) => [...new Set(d.loto)]));
    const top3Hits = top3.filter((n) => histSet.has(n));
    const aiNums = (aiTop3 || []).map((x) => x.number).filter(Boolean);
    const aiHits = aiNums.filter((n) => histSet.has(n));
    return { days, top3Hits, top3Rate: top3.length ? Math.round(top3Hits.length / top3.length * 100) : 0, top3List: top3Hits.join(', '), aiHits, aiRate: aiNums.length ? Math.round(aiHits.length / aiNums.length * 100) : 0, aiList: aiHits.join(', ') };
  });
}

function buildDetailedCompare(train, windows = [7, 14, 30], logDays = 8) {
  const rows = [];
  const maxDays = Math.max(...windows, logDays);
  const startIndex = Math.max(90, train.length - maxDays);
  for (let i = startIndex; i < train.length; i++) {
    const history = train.slice(Math.max(0, i - WINDOW), i);
    if (history.length < 90) continue;
    const actualDraw = train[i];
    const actual = [...new Set(actualDraw.loto)].sort();
    const actualSet = new Set(actual);
    const prob = freqOrder(history).slice(0, TOP_K);
    const ens = ensembleOrder(history).slice(0, TOP_K);
    const recent = recentOrder(history).slice(0, TOP_K);
    const omission = omissionOrder(history).slice(0, TOP_K);
    const headTail = headTailOrder(history).slice(0, TOP_K);
    const probHits = prob.filter((n) => actualSet.has(n));
    const ensHits = ens.filter((n) => actualSet.has(n));
    const recentHits = recent.filter((n) => actualSet.has(n));
    const omissionHits = omission.filter((n) => actualSet.has(n));
    const headTailHits = headTail.filter((n) => actualSet.has(n));
    const models = [
      { key: 'prob', label: 'Xác suất 3', hits: probHits },
      { key: 'ens', label: 'Ensemble 3', hits: ensHits },
      { key: 'recent', label: 'Recency 3', hits: recentHits },
      { key: 'omission', label: 'Omission 3', hits: omissionHits },
      { key: 'headTail', label: 'Head-Tail 3', hits: headTailHits },
    ];
    const maxHits = Math.max(...models.map((m) => m.hits.length));
    const leaders = maxHits > 0 ? models.filter((m) => m.hits.length === maxHits).map((m) => m.label) : [];
    rows.push({
      date: actualDraw.date,
      actual,
      actualSet,
      prob,
      ens,
      recent,
      omission,
      headTail,
      probHits,
      ensHits,
      recentHits,
      omissionHits,
      headTailHits,
      leaders,
      maxHits,
    });
  }
  if (!rows.length) return { error: 'Chưa đủ dữ liệu để đối chiếu chi tiết.' };

  const inspectedDays = rows.length;

  const summarizeModel = (slice, key) => {
    const hitsKey = `${key}Hits`;
    const daysHit = slice.filter((row) => row[hitsKey].length > 0).length;
    const totalHits = slice.reduce((sum, row) => sum + row[hitsKey].length, 0);
    return {
      daysHit,
      totalHits,
      rate: slice.length ? Math.round(daysHit / slice.length * 100) : 0,
      avgHits: slice.length ? (totalHits / slice.length).toFixed(2) : '0.00',
    };
  };

  const summaries = windows.map((days) => {
    const slice = rows.slice(-days);
    if (!slice.length) return null;
    const prob = summarizeModel(slice, 'prob');
    const ens = summarizeModel(slice, 'ens');
    const recent = summarizeModel(slice, 'recent');
    const omission = summarizeModel(slice, 'omission');
    const headTail = summarizeModel(slice, 'headTail');
    const maxDaysHit = Math.max(prob.daysHit, ens.daysHit, recent.daysHit, omission.daysHit, headTail.daysHit);
    const maxTotalHits = Math.max(prob.totalHits, ens.totalHits, recent.totalHits, omission.totalHits, headTail.totalHits);
    const leaders = [
      { label: 'Xác suất 3', stats: prob },
      { label: 'Ensemble 3', stats: ens },
      { label: 'Recency 3', stats: recent },
      { label: 'Omission 3', stats: omission },
      { label: 'Head-Tail 3', stats: headTail },
    ].filter((item) => item.stats.daysHit === maxDaysHit && item.stats.totalHits === maxTotalHits && maxTotalHits > 0)
      .map((item) => item.label);
    return { daysRequested: days, daysUsed: slice.length, prob, ens, recent, omission, headTail, leaders };
  }).filter(Boolean);

  return {
    summaries,
    logRows: rows.slice(-logDays).reverse(),
    totalDays: inspectedDays,
    latestDate: rows[rows.length - 1]?.date || '',
  };
}

function renderPickChips(picks, hits) {
  const hitSet = new Set(hits);
  return picks.map((n) => `<span class="note-chip ${hitSet.has(n) ? 'is-hit' : 'is-miss'}">${n}</span>`).join(' ');
}

function renderDetailStatCell(stats) {
  return `<div class="detail-stat"><strong>${stats.daysHit}</strong>/<span>${stats.rate}%</span><span class="detail-meta">${stats.totalHits} số trúng · TB ${stats.avgHits}/ngày</span></div>`;
}

function renderDetailedCompareBlock(train, picked) {
  const detail = buildDetailedCompare(train);
  if (detail.error) {
    return `<div class="today-summary" style="margin-top:16px"><strong>📚 Đối chiếu chi tiết gần đây</strong><span>${detail.error}</span></div>`;
  }
  const summaryRows = detail.summaries.map((row) => `
    <tr>
      <td>${row.daysUsed === row.daysRequested ? row.daysRequested : `${row.daysUsed}/${row.daysRequested}`} ngày</td>
      <td>${renderDetailStatCell(row.prob)}</td>
      <td>${renderDetailStatCell(row.ens)}</td>
      <td>${renderDetailStatCell(row.recent)}</td>
      <td>${renderDetailStatCell(row.omission)}</td>
      <td>${renderDetailStatCell(row.headTail)}</td>
      <td style="font-weight:800;color:${row.leaders.length ? 'var(--good)' : 'var(--text-dim)'}">${row.leaders.join(' / ') || 'Chưa có'}</td>
    </tr>`).join('');
  const logRows = detail.logRows.map((row) => `
    <tr>
      <td>${row.date}</td>
      <td>${row.actual.join(', ')}</td>
      <td><div class="detail-picks">${renderPickChips(row.prob, row.probHits)}</div><div class="detail-meta">${row.probHits.length ? `Trúng ${row.probHits.join(', ')}` : 'Trượt'}</div></td>
      <td><div class="detail-picks">${renderPickChips(row.ens, row.ensHits)}</div><div class="detail-meta">${row.ensHits.length ? `Trúng ${row.ensHits.join(', ')}` : 'Trượt'}</div></td>
      <td><div class="detail-picks">${renderPickChips(row.recent, row.recentHits)}</div><div class="detail-meta">${row.recentHits.length ? `Trúng ${row.recentHits.join(', ')}` : 'Trượt'}</div></td>
      <td><div class="detail-picks">${renderPickChips(row.omission, row.omissionHits)}</div><div class="detail-meta">${row.omissionHits.length ? `Trúng ${row.omissionHits.join(', ')}` : 'Trượt'}</div></td>
      <td><div class="detail-picks">${renderPickChips(row.headTail, row.headTailHits)}</div><div class="detail-meta">${row.headTailHits.length ? `Trúng ${row.headTailHits.join(', ')}` : 'Trượt'}</div></td>
      <td style="font-weight:800;color:${row.leaders.length ? 'var(--good)' : 'var(--text-dim)'}">${row.leaders.join(' / ') || 'Không trúng'}</td>
    </tr>`).join('');
  return `
    <div class="today-summary" style="margin-top:16px">
      <strong>📚 Đối chiếu chi tiết gần đây</strong>
      <span>Đối chiếu trước ngày ${picked}. Mỗi thuật toán chọn 3 số.</span>
      <span>${detail.totalDays} ngày đủ điều kiện, mới nhất ${detail.latestDate}.</span>
    </div>
    <table class="cmp-table">
      <thead><tr><th>Khoảng</th><th>Xác suất 3</th><th>Ensemble 3</th><th>Recency 3</th><th>Omission 3</th><th>Head-Tail 3</th><th>Dẫn đầu</th></tr></thead>
      <tbody>${summaryRows}</tbody>
    </table>
    <div class="today-summary" style="margin-top:12px">
      <strong>Nhật ký 8 ngày gần nhất</strong>
      <span>Mỗi ô hiển thị 3 số, số trúng tô xanh.</span>
    </div>
    <table class="cmp-table detail-log-table">
      <thead><tr><th>Ngày</th><th>Kết quả</th><th>Xác suất 3</th><th>Ensemble 3</th><th>Recency 3</th><th>Omission 3</th><th>Head-Tail 3</th><th>Dẫn đầu</th></tr></thead>
      <tbody>${logRows}</tbody>
    </table>`;
}

function renderFooterCompare(prob, ens, recent, omission, headTail, aiNums, actualSet, picked) {
  if (!actualSet) return '';
  const blocks = [
    { label: 'Xác suất (3)', all: prob },
    { label: 'Ensemble (3)', all: ens },
    { label: 'Recency (3)', all: recent },
    { label: 'Omission (3)', all: omission },
    { label: 'Head-Tail (3)', all: headTail },
    { label: 'GPT (3)', all: aiNums },
  ].map((b) => ({ ...b, hits: b.all.filter((n) => actualSet.has(n)) }));
  const mx = Math.max(...blocks.map((b) => b.hits.length));
  const leaders = blocks.filter((b) => b.hits.length === mx && mx > 0).map((b) => b.label);
  const renderNums = (all) => all.length ? all.map((n) => actualSet.has(n) ? `<span class="note-chip" style="background:rgba(70,224,168,.18);border:1px solid var(--good);color:var(--good)">${n}</span>` : `<span class="note-chip" style="background:rgba(93,103,129,.12);color:var(--text-dim)">${n}</span>`).join(' ') : '—';
  const row = (b) => {
    const rowStyle = b.hits.length === mx && mx > 0 ? 'background:rgba(70,224,168,.10)' : (b.hits.length === 0 ? 'background:rgba(224,97,58,.06)' : '');
    return `<tr style="${rowStyle}"><td>${b.hits.length === mx && mx > 0 ? '🏆 ' : ''}${b.label}</td><td>${renderNums(b.all)}</td><td style="color:${b.hits.length ? 'var(--good)' : 'var(--warn)'}"><strong>${b.hits.length ? b.hits.join(', ') : 'Không trúng'}</strong></td><td style="font-weight:800;color:${b.hits.length ? 'var(--good)' : 'var(--warn)'}">${b.hits.length}/${b.all.length || 1}</td></tr>`;
  };
  return `<div class="today-summary" style="margin-top:16px"><strong>📌 Đối chiếu tự động — ngày ${picked}</strong><span>Số trùng được tô xanh trong cột dự đoán. Khối dẫn đầu được gắn 🏆.</span></div><table class="cmp-table"><thead><tr><th>Khối</th><th>Số dự đoán</th><th>Số trúng</th><th>Tỉ lệ</th></tr></thead><tbody>${blocks.map(row).join('')}</tbody></table><p class="simple-note" style="text-align:left">Khối dẫn đầu: <strong>${leaders.join(' / ') || 'Không có'}</strong> với <strong>${mx}</strong> số trúng.</p>`;
}

function renderReport(train) {
  const hit = Object.fromEntries(ALL.map((n) => [n, 0]));
  const lastIdx = Object.fromEntries(ALL.map((n) => [n, -1]));
  train.forEach((d, i) => new Set(d.loto).forEach((n) => { hit[n]++; lastIdx[n] = i; }));
  const total = train.length;
  const topFreq = ALL.slice().sort((a, b) => hit[b] - hit[a]).slice(0, 10).map((n) => `<span class="algo-num"><strong>${n}</strong> <span style="font-size:.72rem;color:var(--text-dim)">${hit[n]}n·${(hit[n]/total*100).toFixed(0)}%</span></span>`).join('');
  const topGan = ALL.slice().map((n) => ({ n, gap: lastIdx[n] >= 0 ? total - 1 - lastIdx[n] : total })).sort((a, b) => b.gap - a.gap).slice(0, 10).map((x) => `<span class="algo-num"><strong>${x.n}</strong> <span style="font-size:.72rem;color:var(--text-dim)">gan ${x.gap}</span></span>`).join('');
  const head = Array(10).fill(0), tail = Array(10).fill(0);
  train.forEach((d) => d.loto.forEach((n) => { head[+n[0]]++; tail[+n[1]]++; }));
  const mx = Math.max(...head, ...tail, 1);
  const bar = (arr, label) => `<div style="margin-top:6px"><div style="font-size:.78rem;color:var(--text-dim);margin-bottom:4px">${label}</div><div style="display:flex;gap:4px">${arr.map((v, i) => `<div style="flex:1;text-align:center"><div style="height:${Math.round(v/mx*46)+4}px;background:var(--primary);border-radius:4px 4px 0 0"></div><div style="font-size:.7rem;margin-top:2px">${i}</div></div>`).join('')}</div></div>`;
  return `<div class="today-summary" style="margin-top:16px"><strong>Báo cáo (${total} kỳ)</strong><span>Mô tả quá khứ.</span></div><div class="algo-grid"><article class="algo-card"><h3 style="color:var(--good)">Tần suất</h3><div class="algo-numbers">${topFreq}</div></article><article class="algo-card"><h3 style="color:var(--accent)">Gan</h3><div class="algo-numbers">${topGan}</div></article><article class="algo-card"><h3 style="color:var(--primary)">Đầu/Đuôi</h3>${bar(head,'ĐẦU')}${bar(tail,'ĐUÔI')}</article></div>`;
}

function runHoldout(days, topK = TOP_K) {
  const all = DRAWS.slice();
  if (all.length < days + 200) return { error: `Cần >${days + 200} kỳ, có ${all.length}` };
  const testSet = all.slice(-days);
  const trainStart = all.length - days;
  let probHits = 0, ensHits = 0, recentHits = 0, omissionHits = 0, headTailHits = 0, rndHits = 0, totalDays = 0;
  for (let i = 0; i < testSet.length; i++) {
    const absIdx = trainStart + i;
    const train = all.slice(Math.max(0, absIdx - WINDOW), absIdx);
    if (train.length < 90) continue;
    const actual = new Set(testSet[i].loto);
    const prob = freqOrder(train).slice(0, topK);
    const ens = ensembleOrder(train).slice(0, topK);
    const recent = recentOrder(train).slice(0, topK);
    const omission = omissionOrder(train).slice(0, topK);
    const headTail = headTailOrder(train).slice(0, topK);
    const rnd = ALL.slice().sort(() => Math.random() - 0.5).slice(0, topK);
    if (prob.some((n) => actual.has(n))) probHits++;
    if (ens.some((n) => actual.has(n))) ensHits++;
    if (recent.some((n) => actual.has(n))) recentHits++;
    if (omission.some((n) => actual.has(n))) omissionHits++;
    if (headTail.some((n) => actual.has(n))) headTailHits++;
    if (rnd.some((n) => actual.has(n))) rndHits++;
    totalDays++;
  }
  return {
    days: totalDays,
    probHits,
    ensHits,
    recentHits,
    omissionHits,
    headTailHits,
    rndHits,
    probRate: totalDays ? probHits / totalDays : 0,
    ensRate: totalDays ? ensHits / totalDays : 0,
    recentRate: totalDays ? recentHits / totalDays : 0,
    omissionRate: totalDays ? omissionHits / totalDays : 0,
    headTailRate: totalDays ? headTailHits / totalDays : 0,
    rndRate: totalDays ? rndHits / totalDays : 0,
    testRange: `${testSet[0].date} → ${testSet[testSet.length-1].date}`,
  };
}

function renderAnalysisBlock(train, top3, aiTop3, compositePreset, compositeMetrics, compositeSelection) {
  const aiNums = (aiTop3 || []).map((x) => x.number).filter(Boolean);
  const fallbackNote = compositeSelection?.fallbackToProbability ? 'Fallback: đang dùng xác suất' : 'Fallback: không';
  const compareLabel = compositeSelection?.fallbackToProbability ? 'Top 3 tổng hợp (fallback)' : 'Top 3 tổng hợp';
  const strategyName = compositePreset?.name || 'mặc định';
  const strategyScore = (compositeMetrics?.score || 0).toFixed(3);
  const strategyHitDay = Math.round((compositeMetrics?.hitDayRate || 0) * 100);
  const strategyStability = Math.round((compositeMetrics?.stability || 0) * 100);
  const windows = [2, 3, 4, 5];
  const rows = windows.map((days) => {
    const hist = train.slice(-days);
    const histSet = new Set(hist.flatMap((d) => [...new Set(d.loto)]));
    const top3Hits = top3.filter((n) => histSet.has(n));
    const aiHits = aiNums.filter((n) => histSet.has(n));
    return {
      days,
      top3Hits: top3Hits.length,
      top3Rate: top3.length ? Math.round(top3Hits.length / top3.length * 100) : 0,
      top3List: top3Hits.join(', '),
      aiHits: aiHits.length,
      aiRate: aiNums.length ? Math.round(aiHits.length / aiNums.length * 100) : 0,
      aiList: aiHits.join(', '),
    };
  });

  // Chọn khoảng ngày hiệu quả nhất theo Top 3 và theo Trợ Lý AI
  const bestTop3 = rows.reduce((a, b) => (b.top3Rate > a.top3Rate ? b : a));
  const bestAi = rows.reduce((a, b) => (b.aiRate > a.aiRate ? b : a));

  // Tính lãi/lỗ mẫu với 1 triệu
  // Giả định đánh đều 3 số Top 3, chia đều vốn 1,000,000 cho số ngày trong khoảng tốt nhất.
  const budget = 1_000_000;
  const days = bestTop3.days;
  const perDay = budget / days;
  const perNumber = perDay / 3;
  const hitRate = bestTop3.top3Rate / 100;
  // Lô 2 số thường ăn 1 điểm 80k; 1k = 1 "điểm/80" tương đối. Dùng 80x làm mô hình tham chiếu.
  const expectedWinPerHit = perNumber * 80;
  const expectedReturn = hitRate * expectedWinPerHit * days;
  const totalStake = perDay * days;
  const net = expectedReturn - totalStake;

  return `
    <div class="today-summary" style="margin-top:16px">
      <strong>🧩 Bộ phối hợp nội bộ</strong>
      <span>Preset: ${strategyName} | Score ${strategyScore} | Hit-day ${strategyHitDay}% | Ổn định ${strategyStability}%</span>
      <span>${fallbackNote}. Khối này không tính là thuật toán độc lập.</span>
    </div>
    <div class="today-summary" style="margin-top:12px">
      <strong>📈 Xác suất & hiệu quả gần nhất</strong>
      <span>Nhóm dự đoán độc lập trên UI gồm: Xác suất, Ensemble, GPT. Bộ phối hợp chỉ để tham khảo.</span>
    </div>
    <table class="cmp-table">
      <thead><tr><th>Khoảng</th><th>Top 3</th><th>Số trúng</th><th>Trợ Lý AI</th><th>Số trúng</th></tr></thead>
      <tbody>
        ${rows.map(r => `<tr><td>${r.days} ngày</td><td style="font-weight:800;color:${r.top3Hits ? 'var(--good)' : 'var(--warn)'}">${r.top3Hits}/3 (${r.top3Rate}%)</td><td>${r.top3List || '—'}</td><td style="font-weight:800;color:${r.aiHits ? 'var(--good)' : 'var(--warn)'}">${r.aiHits}/${aiNums.length || 0} (${r.aiRate}%)</td><td>${r.aiList || '—'}</td></tr>`).join('')}
      </tbody>
    </table>
    <div class="today-summary" style="margin-top:12px">
      <strong>Khung hiệu quả nhất</strong>
      <span>Top 3 tốt nhất: ${bestTop3.days} ngày (${bestTop3.top3Rate}%). AI tốt nhất: ${bestAi.days} ngày (${bestAi.aiRate}%).</span>
    </div>
    <div class="today-summary" style="margin-top:12px">
      <strong>Mô phỏng vốn 1.000.000đ</strong>
      <span>Chia đều 1.000.000đ trong ${days} ngày: kỳ vọng ≈ <strong style="color:${net >= 0 ? 'var(--good)' : 'var(--warn)'}">${Math.round(net).toLocaleString('vi-VN')}đ</strong>.</span>
      <span>Chỉ là tham chiếu.</span>
    </div>`;
}

function runAutoHoldout() {
  const el = document.querySelector('#holdoutResult');
  if (!el) return;
  const r = runHoldout(30, TOP_K);
  if (r.error) { el.innerHTML = `<div class="today-summary">${r.error}</div>`; return; }
  el.innerHTML = `<div class="today-summary"><strong>📊 Kiểm định 30 ngày</strong><span>${r.testRange} | ${r.days} kỳ | Top-${TOP_K}. Đây là bảng tóm tắt của 5 thuật toán độc lập.</span></div><table class="cmp-table"><thead><tr><th>Mô hình</th><th>Trùng</th><th>Tỉ lệ</th></tr></thead><tbody><tr><td>Thuật toán xác suất</td><td style="color:var(--good)">${r.probHits}/${r.days}</td><td><strong>${(r.probRate*100).toFixed(1)}%</strong></td></tr><tr><td>Ensemble</td><td style="color:var(--good)">${r.ensHits}/${r.days}</td><td><strong>${(r.ensRate*100).toFixed(1)}%</strong></td></tr><tr><td>Recency</td><td style="color:var(--good)">${r.recentHits}/${r.days}</td><td><strong>${(r.recentRate*100).toFixed(1)}%</strong></td></tr><tr><td>Omission</td><td style="color:var(--good)">${r.omissionHits}/${r.days}</td><td><strong>${(r.omissionRate*100).toFixed(1)}%</strong></td></tr><tr><td>Head-Tail</td><td style="color:var(--good)">${r.headTailHits}/${r.days}</td><td><strong>${(r.headTailRate*100).toFixed(1)}%</strong></td></tr><tr><td>Ngẫu nhiên</td><td>${r.rndHits}/${r.days}</td><td>${(r.rndRate*100).toFixed(1)}%</td></tr></tbody></table>`;
}

function renderIndependentSummary(prob, ens, recent, omission, headTail) {
  return `<div class="today-summary" style="margin-top:12px"><strong>🔎 Nhóm dự đoán độc lập</strong><span>Xác suất: ${prob.join(', ')} | Ensemble: ${ens.join(', ')} | Recency: ${recent.join(', ')} | Omission: ${omission.join(', ')} | Head-Tail: ${headTail.join(', ')}</span></div>`;
}

function renderIndependentLeader(prob, ens, recent, omission, headTail) {
  const groups = [
    { label: 'Xác suất', picks: prob },
    { label: 'Ensemble', picks: ens },
    { label: 'Recency', picks: recent },
    { label: 'Omission', picks: omission },
    { label: 'Head-Tail', picks: headTail },
  ];
  const counts = {};
  groups.forEach((group) => group.picks.forEach((n) => { counts[n] = (counts[n] || 0) + 1; }));
  const leaders = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_K);
  return `<div class="today-summary" style="margin-top:12px"><strong>🎯 Điểm giao nhau độc lập</strong><span>${leaders.map(([n, c]) => `${n} (${c} thuật toán)`).join(' · ') || 'Chưa có'}</span></div>`;
}

function renderIndependentHero(prob, ens, recent, omission, headTail, liveInfoText = '') {
  return `
    <div class="today-summary" style="margin-top:16px">
      <strong>🧠 5 thuật toán độc lập</strong>
      <span>Mỗi thuật toán dưới đây tự tính trực tiếp từ dữ liệu lịch sử, không lấy output của thuật toán khác.</span>
    </div>
    <div class="today-summary" style="margin-top:12px">
      <strong>📡 Nhật ký realtime</strong>
      <span>${liveInfoText || 'Chưa có dữ liệu realtime.'}</span>
    </div>
    ${renderIndependentLeader(prob, ens, recent, omission, headTail)}
    ${renderIndependentSummary(prob, ens, recent, omission, headTail)}`;
}
function scoreTop2Rows(rows) {
  if (!rows.length) return { score: 0, hitDayRate: 0, avgHitRate: 0, stability: 0, totalHits: 0, totalDays: 0 };
  const totalDays = rows.length;
  const totalHits = rows.reduce((sum, row) => sum + row.hitsCount, 0);
  const hitDays = rows.filter((row) => row.hitsCount > 0).length;
  const hitDayRate = hitDays / totalDays;
  const avgHitRate = totalHits / (totalDays * 2);
  const windows = [7, 14, 30].filter((days) => days <= totalDays);
  const rates = windows.map((days) => rows.slice(-days).reduce((sum, row) => sum + row.hitsCount, 0) / (days * 2));
  const stability = rates.length > 1 ? 1 - (Math.max(...rates) - Math.min(...rates)) : avgHitRate;
  const score = avgHitRate * 0.55 + hitDayRate * 0.25 + stability * 0.20;
  return { score, hitDayRate, avgHitRate, stability, totalHits, totalDays };
}
function backtestNextDayTop2(train, orderBuilder, days = 45) {
  if (train.length < days + 90) return { score: 0, hitDayRate: 0, avgHitRate: 0, stability: 0, totalHits: 0, totalDays: 0 };
  const rows = [];
  const startIndex = Math.max(90, train.length - days);
  for (let i = startIndex; i < train.length; i++) {
    const history = train.slice(Math.max(0, i - WINDOW), i);
    if (history.length < 90) continue;
    const actualSet = new Set(train[i].loto);
    const picks = orderBuilder(history).slice(0, 2);
    const hits = picks.filter((n) => actualSet.has(n));
    rows.push({ hitsCount: hits.length });
  }
  return scoreTop2Rows(rows);
}
function buildNextDayTop2(train, compositePreset) {
  const history = train.slice(-WINDOW);
  const compositeBuilder = (hist) => compositePreset ? compositeOrder(hist, compositePreset.weights) : freqOrder(hist);
  const strategies = [
    { order: freqOrder, metrics: backtestNextDayTop2(train, freqOrder) },
    { order: ensembleOrder, metrics: backtestNextDayTop2(train, ensembleOrder) },
    { order: recentOrder, metrics: backtestNextDayTop2(train, recentOrder) },
    { order: omissionOrder, metrics: backtestNextDayTop2(train, omissionOrder) },
    { order: headTailOrder, metrics: backtestNextDayTop2(train, headTailOrder) },
    { order: compositeBuilder, metrics: backtestNextDayTop2(train, compositeBuilder) },
  ];
  const maxScore = Math.max(...strategies.map((s) => s.metrics.score), 1e-9);
  const score = Object.fromEntries(ALL.map((n) => [n, 0]));
  strategies.forEach(({ order, metrics }) => {
    const ranked = order(history);
    const weight = Math.max(0.05, metrics.score / maxScore);
    const last = Math.max(ranked.length - 1, 1);
    ranked.forEach((n, index) => {
      score[n] += weight * (1 - index / last);
    });
  });
  const ranked = ALL.slice().sort((a, b) => score[b] - score[a] || a.localeCompare(b));
  const picks = [];
  const usedHeads = new Set();
  const usedTails = new Set();
  for (const n of ranked) {
    if (!picks.length) {
      picks.push(n);
      usedHeads.add(n[0]);
      usedTails.add(n[1]);
      continue;
    }
    const tooSimilar = usedHeads.has(n[0]) || usedTails.has(n[1]);
    if (tooSimilar && score[n] < score[picks[0]] * 0.94) continue;
    picks.push(n);
    usedHeads.add(n[0]);
    usedTails.add(n[1]);
    if (picks.length === 2) break;
  }
  while (picks.length < 2) picks.push(ranked[picks.length]);
  return picks.slice(0, 2);
}
function renderNextDayTop2Block(nextDayTop2) {
  return `
    <div class="today-summary" style="margin-top:12px;border-color:var(--accent)">
      <strong>⭐ 2 số ưu tiên cao nhất cho ngày kế tiếp</strong>
      <span>${nextDayTop2.join(', ')}</span>
      <span>Khối này được tối ưu riêng theo tổng số hit quá khứ của 5 thuật toán và bộ phối hợp; chỉ mang tính tham khảo.</span>
    </div>`;
}

// ===== MAIN =====
async function run() {
  if (!resultBox) return;
  resultBox.innerHTML = '<div class="shortlist-empty">Đang tải dữ liệu...</div>';
  await fetchLiveResults();

  const picked = (dateInput?.value || '').trim();
  if (!picked || !DRAWS.length) {
    resultBox.innerHTML = '<div class="shortlist-empty">Chọn ngày để xem dự đoán.</div>';
    return;
  }
  const train = DRAWS.filter((d) => d.date < picked);
  if (train.length < 90) {
    resultBox.innerHTML = `<div class="shortlist-empty">Cần ≥90 kỳ trước ngày ${picked}; có ${train.length}.</div>`;
    return;
  }

  const win = train.slice(-WINDOW);
  const compositeSelection = chooseBestCompositePreset(train);
  const composite = compositeOrder(win, compositeSelection.activePreset.weights).slice(0, TOP_K);
  const prob = freqOrder(win).slice(0, TOP_K);
  const ens = ensembleOrder(win).slice(0, TOP_K);
  const recent = recentOrder(win).slice(0, TOP_K);
  const omission = omissionOrder(win).slice(0, TOP_K);
  const headTail = headTailOrder(win).slice(0, TOP_K);
  const target = DRAWS.find((d) => d.date === picked);
  const actualSet = target ? new Set(target.loto) : null;
  const specialNum = target?.special || null;
  const top3 = composite.slice(0, 3);
  const hasAiKey = !!getAiKey();

  aiTop3 = []; aiSummary = ''; aiSummaryBroad = '';
  if (hasAiKey) {
    resultBox.innerHTML = `<div class="today-summary"><strong>${picked}</strong>${liveInfo ? ` <span style="color:var(--good)">${liveInfo}</span>` : ''}</div><div class="shortlist-empty">GPT đang phân tích...</div>`;
    await callAi(train, picked);
  }

  const nextDayTop2 = buildNextDayTop2(train, compositeSelection.activePreset);
  const futureProj = projectFutureTop3(train, 3, compositeSelection.activePreset);
  const top3Day2 = futureProj[1]?.top3 || [];
  const top3Day3 = futureProj[2]?.top3 || [];
  const aiNums = aiTop3.map((x) => x.number).filter(Boolean);
  const allCounts = {};
  [...composite, ...prob, ...ens].forEach((n) => { allCounts[n] = (allCounts[n] || 0) + 1; });
  const multiRows = computeWindowStats(train, top3, aiTop3);
  if (hasAiKey) await callAiOverview(prob, ens, aiTop3, multiRows, picked, compositeSelection);
  const multiTable = multiRows.length ? `<div class="today-summary" style="margin-top:16px"><strong>📈 Tỷ lệ trúng gần nhất</strong><span>So sánh Top 3 và GPT trên 2/3/4/5 ngày gần nhất.</span></div><table class="cmp-table"><thead><tr><th>Khoảng</th><th>Top 3</th><th>Số trúng</th><th>GPT</th><th>Số trúng</th></tr></thead><tbody>${multiRows.map(r => `<tr><td>${r.days} ngày</td><td style="font-weight:800;color:${r.top3Hits ? 'var(--good)' : 'var(--warn)'}">${r.top3Hits}/3 (${r.top3Rate}%)</td><td>${r.top3List || '—'}</td><td style="font-weight:800;color:${r.aiHits ? 'var(--good)' : 'var(--warn)'}">${r.aiHits}/${aiNums.length || 0} (${r.aiRate}%)</td><td>${r.aiList || '—'}</td></tr>`).join('')}</tbody></table>` : '';

  const header = `<div class="today-summary"><strong>${actualSet ? `Kết quả XSMB ngày ${picked}` : `Dự đoán ngày ${picked} (tương lai)`}</strong><span>${actualSet ? `Lô 2 số: ${[...actualSet].sort().join(', ')}` : `Huấn luyện trên ${train.length} kỳ trước (mới nhất ${train[train.length - 1].date}).`}${specialNum ? ` | <strong>Đặc biệt: ${specialNum}</strong>` : ''}</span>${liveInfo ? `<span style="color:var(--good)">${liveInfo}</span>` : ''}</div>`;

  resultBox.innerHTML = `
    ${header}
    ${renderIndependentHero(prob, ens, recent, omission, headTail, liveInfo)}
    ${renderNextDayTop2Block(nextDayTop2, compositeSelection)}
    <div class="top3-block">
      <div class="top3-title">🧩 Bộ phối hợp nội bộ · mô phỏng ngày 2 · mô phỏng ngày 3</div>
      <div class="algo-grid">
        <div>
          <div class="top3-note" style="margin-bottom:8px">Hôm nay</div>
          <div class="top3-grid">
            ${top3.map((n, i) => `<div class="top3-card ${actualSet && actualSet.has(n) ? 'top3-hit' : ''}"><div class="top3-rank">#${i + 1}</div><div class="top3-num">${n}</div><div class="top3-vote">${allCounts[n] || 0} mô hình chọn</div></div>`).join('')}
          </div>
        </div>
        <div>
          <div class="top3-note" style="margin-bottom:8px">Mô phỏng ngày 2</div>
          <div class="top3-grid">
            ${top3Day2.map((n, i) => `<div class="top3-card"><div class="top3-rank">#${i + 1}</div><div class="top3-num">${n}</div><div class="top3-vote">mô phỏng tiếp</div></div>`).join('')}
          </div>
        </div>
        <div>
          <div class="top3-note" style="margin-bottom:8px">Mô phỏng ngày 3</div>
          <div class="top3-grid">
            ${top3Day3.map((n, i) => `<div class="top3-card"><div class="top3-rank">#${i + 1}</div><div class="top3-num">${n}</div><div class="top3-vote">mô phỏng tiếp</div></div>`).join('')}
          </div>
        </div>
      </div>
      <div class="top3-note">Đây là bộ phối hợp nội bộ, không tính là thuật toán độc lập. Ngày 2/3 chỉ là mô phỏng phụ thuộc.</div>
    </div>

    ${hasAiKey ? `
      <div class="top3-block tlai-block" style="margin-top:12px">
        <div class="top3-title">🤖 GPT dự đoán độc lập từ dữ liệu lịch sử</div>
        ${aiTop3.length ? `<div class="top3-grid">${aiTop3.map((it) => `<div class="top3-card ${actualSet && actualSet.has(it.number) ? 'top3-hit' : ''}"><div class="top3-rank">Khả năng ${it.rank}</div><div class="top3-num">${it.number}</div><div class="top3-vote">${it.confidence || ''}</div><div class="top3-note" style="margin-top:6px">${it.reason || ''}</div></div>`).join('')}</div>` : `<div class="top3-note">Chưa lấy được 3 số từ GPT.</div>`}
        <div class="tlai-content" style="margin-top:14px">${(aiSummary || 'Chưa có phản hồi GPT.').replace(/\n/g, '<br>')}</div>
      </div>
      ${aiSummaryBroad ? `<div class="today-summary" style="margin-top:12px;border-color:var(--accent)">
        <strong>🧠 GPT tổng hợp</strong>
        <div class="tlai-content" style="margin-top:10px">${aiSummaryBroad.replace(/\n/g, '<br>')}</div>
      </div>` : ''}` : `<div class="today-summary" style="margin-top:12px;border-color:var(--border)"><strong>Nhập key để bật GPT</strong></div>`}

    <div class="algo-grid">
      ${renderColumn('Thuật toán xác suất (3)', 'var(--primary)', prob, actualSet)}
      ${renderColumn('Thuật toán Ensemble (3)', 'var(--accent)', ens, actualSet)}
      ${renderColumn('Thuật toán Recency (3)', 'var(--good)', recent, actualSet)}
      ${renderColumn('Thuật toán Omission (3)', 'var(--accent)', omission, actualSet)}
      ${renderColumn('Thuật toán Head-Tail (3)', 'var(--primary)', headTail, actualSet)}
    </div>

    ${multiTable}
    ${renderDetailedCompareBlock(train, picked)}
    ${renderAnalysisBlock(train, top3, aiTop3, compositeSelection.activePreset, compositeSelection.activeMetrics, compositeSelection)}
    ${renderSpecialReport(train)}
    ${renderReport(train)}
    ${renderFooterCompare(prob, ens, recent, omission, headTail, aiNums, actualSet, picked)}
  `;

  setTimeout(runAutoHoldout, 100);
}

// ===== WIRING =====
const dateInput = document.querySelector('#dateInput');
const resultBox = document.querySelector('#result');
const aiKeyInput = document.querySelector('#gptKeyInput');
const saveAiKeyBtn = document.querySelector('#saveGptKeyBtn');
if (aiKeyInput && getAiKey()) { aiKeyInput.value = getAiKey(); aiKeyInput.placeholder = '✅ Key đã lưu'; }
saveAiKeyBtn?.addEventListener('click', () => { const k = aiKeyInput?.value?.trim(); if (!k) return alert('Vui lòng nhập key'); saveAiKey(k); aiKeyInput.placeholder = '✅ Key đã lưu'; alert('Đã lưu key'); });
let aiTimer = null;
aiKeyInput?.addEventListener('input', () => { clearTimeout(aiTimer); aiTimer = setTimeout(() => { const k = aiKeyInput?.value?.trim(); if (k) saveAiKey(k); }, 800); });
aiKeyInput?.addEventListener('change', () => { const k = aiKeyInput?.value?.trim(); if (k) saveAiKey(k); });
aiKeyInput?.addEventListener('blur', () => { const k = aiKeyInput?.value?.trim(); if (k) saveAiKey(k); });

dateInput?.addEventListener('change', run);
if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
run();
