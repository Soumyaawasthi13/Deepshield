'use strict';

// ======= Model configuration =======
const DEFAULT_MODELS = [
  'Hello-SimpleAI/chatgpt-detector-roberta',
  'openai-community/roberta-base-openai-detector',
  'roberta-base-openai-detector',
  'desklib/ai-text-detector-v1.01',
  'SuperAnnotate/ai-detector'
];

const ZERO_SHOT_FALLBACK_MODEL = 'facebook/bart-large-mnli';
function isZeroShotModel(name) {
  const n = String(name || '').toLowerCase();
  return n.includes('bart-large-mnli') || n.includes('zero-shot') || n === ZERO_SHOT_FALLBACK_MODEL.toLowerCase();
}

// Image models (zero-shot classification via CLIP)
const IMAGE_MODELS = [
  'openai/clip-vit-base-patch32',
  'openai/clip-vit-large-patch14'
];
const IMAGE_LABELS = [
  'AI-generated image',
  'photo of a real scene',
  'deepfake',
  'real'
];

// ======= Tunables for accuracy/perf =======
const CHUNK_SIZE = 800;           // characters per chunk
const MAX_CHUNKS = 3;             // at most this many chunks per page
const MAX_DETECTOR_MODELS = 2;    // number of detector models to ensemble (plus zero-shot)

// ======= Message router =======
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'scan_text') {
    // Accept up to 4000 chars for better context
    const rawText = (msg.payload || '').toString();
    const textToScan = rawText.slice(0, 4000);
    if (!textToScan.trim()) {
      sendResponse({ isAI: false, reason: 'empty_text' });
      return;
    }

    const meta = {
      url: (msg.meta && msg.meta.url) || sender?.url || sender?.tab?.url || '',
      title: (msg.meta && msg.meta.title) || sender?.tab?.title || ''
    };

    analyzeTextEnsemble(textToScan)
      .then(async (result) => {
        await saveLastScan(textToScan, result).catch(() => {});
        // Keep legacy log of flagged text only when AI
        if (result.isAI) await logToStorage(textToScan).catch(() => {});
        // Always log the site visit with classification
        if (meta.url) await logSiteVisit(meta.url, meta.title, result).catch(() => {});
        sendResponse(result);
      })
      .catch(async (err) => {
        const errorMsg = err?.message || String(err);
        console.error('DeepShield: inference error:', errorMsg);
        await saveLastScan(textToScan, { isAI: false, error: errorMsg }).catch(() => {});
        if (meta.url) await logSiteVisit(meta.url, meta.title, { isAI: false, score: 0, label: 'error', model: 'n/a' }).catch(() => {});
        sendResponse({ isAI: false, error: errorMsg });
      });
    return true; // async
  }

  if (msg.type === 'scan_image') {
    const imageUrl = String(msg.url || msg.payload || '').trim();
    const elemId = msg.elemId;
    if (!imageUrl) { sendResponse({ error: 'empty_image_url' }); return; }

    analyzeImage(imageUrl)
      .then(async (result) => {
        await saveLastImageScan(imageUrl, result).catch(() => {});
        if (result.isAI) await logImageToStorage(imageUrl, result.score).catch(() => {});
        sendResponse({ ...result, imageUrl, elemId });
      })
      .catch(async (err) => {
        const errorMsg = err?.message || String(err);
        console.error('DeepShield: image inference error:', errorMsg);
        await saveLastImageScan(imageUrl, { isAI: false, error: errorMsg }).catch(() => {});
        sendResponse({ isAI: false, error: errorMsg, imageUrl, elemId });
      });
    return true; // async
  }
});

// ======= Text analysis (ensemble) =======
function chunkText(t, size = CHUNK_SIZE, maxChunks = MAX_CHUNKS) {
  const s = String(t || '');
  const out = [];
  for (let i = 0; i < s.length && out.length < maxChunks; i += size) out.push(s.slice(i, i + size));
  return out.length ? out : [''];
}

async function analyzeTextEnsemble(text) {
  const { token, threshold, model_id } = await getSettings();
  const decisionThreshold = typeof threshold === 'number' ? threshold : 0.6;

  // Build model pool: a couple of detector models + always include zero-shot
  const pool = [];
  if (model_id && typeof model_id === 'string' && model_id.trim()) pool.push(model_id.trim());
  for (const m of DEFAULT_MODELS) if (!pool.includes(m)) pool.push(m);

  const detectors = pool.filter(m => !isZeroShotModel(m));
  const useDetectors = detectors.slice(0, MAX_DETECTOR_MODELS);
  const modelsToRun = [...useDetectors, ZERO_SHOT_FALLBACK_MODEL];

  const chunks = chunkText(text);

  const perModel = [];
  const aiScores = [];
  const labelScores = new Map(); // label -> cumulative score

  for (const model of modelsToRun) {
    for (const ch of chunks) {
      try {
        const result = isZeroShotModel(model)
          ? await callZeroShot(ch, token)
          : await callInference(model, ch, token);
        const normalized = normalizePredictions(result.predictions);
        const { aiScore, aiLabel, best } = decideAIScore(normalized);
        aiScores.push(aiScore);
        const lbl = aiLabel || best?.label || '';
        if (lbl) labelScores.set(lbl, (labelScores.get(lbl) || 0) + aiScore);
        perModel.push({ model, chunkLen: ch.length, aiScore, label: lbl });
      } catch (e) {
        const msg = e?.message || String(e);
        console.warn(`DeepShield: model '${model}' chunk failed:`, msg);
        // skip this chunk/model
        continue;
      }
    }
  }

  if (!aiScores.length) {
    // All models failed -> heuristic
    const preds = heuristicPredict(text);
    const normalized = normalizePredictions(preds);
    const { aiScore, aiLabel, best } = decideAIScore(normalized);
    const isAI = aiScore >= decisionThreshold;
    return { isAI, label: aiLabel || best?.label, score: aiScore, predictions: normalized, model: 'heuristic-local', status: 200, perModel };
  }

  // Aggregate
  const finalScore = aiScores.reduce((a, b) => a + b, 0) / aiScores.length;
  // Pick label with highest cumulative score
  let finalLabel = 'AI';
  if (labelScores.size) {
    finalLabel = Array.from(labelScores.entries()).sort((a, b) => b[1] - a[1])[0][0];
  }
  const isAI = finalScore >= decisionThreshold;

  return { isAI, label: finalLabel, score: finalScore, model: modelsToRun.join(' + '), status: 200, perModel };
}

async function callInference(model, text, token) {
  const endpoint = `https://api-inference.huggingface.co/models/${encodeURIComponent(model)}`;
  console.log('DeepShield: querying model', model);

  async function doFetch(withToken) {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (withToken && token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ inputs: text }) });
    const raw = await res.text();
    if (!res.ok) { let errMsg = `HTTP ${res.status}`; try { const j = JSON.parse(raw); errMsg += `: ${j.error || raw}`; } catch { errMsg += `: ${raw}`; } throw new Error(errMsg); }
    let data; try { data = JSON.parse(raw); } catch { throw new Error('Invalid JSON from API'); }
    return { predictions: data, raw, status: 200 };
  }

  try { return await doFetch(true); }
  catch (e) {
    const msg = e?.message || '';
    if (token && (/HTTP\s*401/i.test(msg) || (/HTTP\s*403/i.test(msg) && /Inference Providers/i.test(msg)))) {
      console.warn('DeepShield: retrying anonymously due to auth restriction...');
      return await doFetch(false);
    }
    throw e;
  }
}

async function callZeroShot(text, token) {
  const model = ZERO_SHOT_FALLBACK_MODEL;
  const endpoint = `https://api-inference.huggingface.co/models/${encodeURIComponent(model)}`;
  console.log('DeepShield: zero-shot querying model', model);

  const body = {
    inputs: text,
    parameters: { candidate_labels: ['AI-generated', 'human-written'], hypothesis_template: 'This text is {label}.' }
  };

  async function doFetch(withToken) {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (withToken && token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    const raw = await res.text();
    if (!res.ok) { let errMsg = `HTTP ${res.status}`; try { const j = JSON.parse(raw); errMsg += `: ${j.error || raw}`; } catch { errMsg += `: ${raw}`; } throw new Error(errMsg); }
    let data; try { data = JSON.parse(raw); } catch { throw new Error('Invalid JSON from API'); }
    return { predictions: data, raw, status: 200 };
  }

  try { return await doFetch(true); }
  catch (e) { const msg = e?.message || ''; if (token && (/HTTP\s*401/i.test(msg) || /HTTP\s*403/i.test(msg))) { console.warn('DeepShield: zero-shot retrying anonymously due to auth restriction...'); return await doFetch(false); } throw e; }
}

// ======= Image analysis =======
async function analyzeImage(imageUrl) {
  const { token, threshold, model_id } = await getSettings();
  const decisionThreshold = typeof threshold === 'number' ? threshold : 0.6;

  const modelsToTry = [];
  if (model_id && typeof model_id === 'string' && model_id.trim()) modelsToTry.push(model_id.trim());
  for (const m of IMAGE_MODELS) if (!modelsToTry.includes(m)) modelsToTry.push(m);

  let lastError = null;
  for (const model of modelsToTry) {
    try {
      const { predictions, raw } = await callImageZeroShot(model, imageUrl, token);
      console.log('DeepShield: image raw response:', raw);
      const normalized = normalizePredictions(predictions);
      const { aiScore, aiLabel, best } = decideAIScore(normalized);
      const isAI = aiScore >= decisionThreshold;
      return { isAI, label: aiLabel || best?.label, score: aiScore, predictions: normalized, model, status: 200 };
    } catch (e) {
      const msg = e?.message || String(e);
      lastError = msg;
      if (/HTTP\s*(400|401|403|404|429|503)/i.test(msg) || /not\s*found/i.test(msg) || /loading/i.test(msg)) {
        console.warn(`DeepShield: image model '${model}' failed (${msg}). Trying next...`);
        continue;
      }
      throw e;
    }
  }

  // Last resort heuristic for image
  console.warn('DeepShield: image models failed. Falling back to heuristic.');
  const score = 0.5;
  const preds = [{ label: 'AI_image_heuristic', score }];
  const normalized = normalizePredictions(preds);
  const { aiScore, aiLabel, best } = decideAIScore(normalized);
  const isAI = aiScore >= decisionThreshold;
  return { isAI, label: aiLabel || best?.label, score: aiScore, predictions: normalized, model: 'image-heuristic-local', status: 200 };
}

async function fetchImageAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || 'image/jpeg';
  const buf = await res.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  return `data:${ct};base64,${b64}`;
}

async function callImageZeroShot(model, imageUrl, token) {
  const endpoint = `https://api-inference.huggingface.co/models/${encodeURIComponent(model)}`;
  console.log('DeepShield: image querying model', model);

  const imageDataUrl = await fetchImageAsBase64(imageUrl);

  async function doFetch(withToken) {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (withToken && token) headers['Authorization'] = `Bearer ${token}`;
    const body = { inputs: imageDataUrl, parameters: { candidate_labels: IMAGE_LABELS } };
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    const raw = await res.text();
    if (!res.ok) { let errMsg = `HTTP ${res.status}`; try { const j = JSON.parse(raw); errMsg += `: ${j.error || raw}`; } catch { errMsg += `: ${raw}`; } throw new Error(errMsg); }
    let data; try { data = JSON.parse(raw); } catch { throw new Error('Invalid JSON from API'); }
    return { predictions: data, raw, status: 200 };
  }

  try { return await doFetch(true); }
  catch (e) { const msg = e?.message || ''; if (token && (/HTTP\s*401/i.test(msg) || /HTTP\s*403/i.test(msg))) { console.warn('DeepShield: image retrying anonymously due to auth restriction...'); return await doFetch(false); } throw e; }
}

// ======= Utilities & storage =======
function normalizePredictions(data) {
  // Accepts: [[{label,score}...]], [{label,score}...], {labels:[],scores:[]}, [{labels:[],scores:[]}]
  let preds = null;
  if (Array.isArray(data) && data.length && Array.isArray(data[0])) preds = data[0];
  else if (Array.isArray(data) && data.length && data[0] && typeof data[0] === 'object' && Array.isArray(data[0].labels) && Array.isArray(data[0].scores)) {
    preds = data[0].labels.map((label, i) => ({ label: String(label), score: Number(data[0].scores[i] || 0) }));
  } else if (data && typeof data === 'object' && Array.isArray(data.labels) && Array.isArray(data.scores)) {
    preds = data.labels.map((label, i) => ({ label: String(label), score: Number(data.scores[i] || 0) }));
  } else if (Array.isArray(data)) preds = data;
  if (!Array.isArray(preds)) return [];
  return preds.filter(p => p && typeof p === 'object').map(p => ({ label: String(p.label || ''), score: Number(p.score || 0) }));
}

function decideAIScore(predictions) {
  if (!predictions.length) return { aiScore: 0, best: null };
  const best = predictions.reduce((a, b) => (a.score || 0) > (b.score || 0) ? a : b);
  const byLabel = (name) => predictions.find(p => p.label.toLowerCase() === name.toLowerCase());
  const match = (re) => predictions.filter(p => re.test(p.label.toLowerCase()));

  const aiCandidates = match(/fake|ai|gpt|generated|deepfake|machine|synthetic/);
  if (aiCandidates.length) {
    const aiBest = aiCandidates.reduce((a, b) => (a.score || 0) > (b.score || 0) ? a : b);
    return { aiScore: aiBest.score || 0, aiLabel: aiBest.label, best };
  }
  const lbl1 = byLabel('LABEL_1');
  const lbl0 = byLabel('LABEL_0');
  if (lbl1) return { aiScore: lbl1.score || 0, aiLabel: 'LABEL_1', best };
  if (lbl0) return { aiScore: 1 - (lbl0.score || 0), aiLabel: 'not LABEL_0', best };

  const real = match(/real|human/);
  if (real.length) {
    const realBest = real.reduce((a, b) => (a.score || 0) > (b.score || 0) ? a : b);
    return { aiScore: 1 - (realBest.score || 0), aiLabel: 'not real', best };
  }
  return { aiScore: best.score || 0, aiLabel: best.label, best };
}

function heuristicPredict(text) {
  const t = (text || '').toLowerCase();
  const phrases = [
    'as an ai language model','as a language model','i do not have personal','cannot browse the internet','my training data','chatgpt','openai','large language model','in this essay','in conclusion','furthermore','moreover','on the other hand','this article explores','this report discusses'
  ];
  let hits = 0; for (const p of phrases) if (t.includes(p)) hits += 1;
  const sentences = t.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
  const words = t.match(/[a-z']+/g) || []; const unique = Array.from(new Set(words));
  let score = 0; score += Math.min(0.6, hits * 0.2);
  if (sentences.length) { const avgLen = words.length / sentences.length; if (avgLen > 18) score += 0.1; if (avgLen > 25) score += 0.1; }
  const ttr = words.length ? unique.length / words.length : 1; if (ttr < 0.45) score += 0.1; if (ttr < 0.35) score += 0.1;
  score = Math.max(0, Math.min(1, score)); return [{ label: 'AI_heuristic', score }];
}

function getSettings() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(['hf_token', 'threshold', 'model_id'], res => {
        resolve({ token: res?.hf_token || null, threshold: typeof res?.threshold === 'number' ? res.threshold : null, model_id: res?.model_id || null });
      });
    } catch { resolve({ token: null, threshold: null, model_id: null }); }
  });
}

function logToStorage(text) {
  return new Promise(resolve => {
    const entry = { text, date: new Date().toLocaleString() };
    chrome.storage.local.get(['logs'], result => {
      const logs = Array.isArray(result?.logs) ? result.logs : []; logs.push(entry);
      chrome.storage.local.set({ logs }, resolve);
    });
  });
}

function logSiteVisit(url, title, detection) {
  return new Promise(resolve => {
    const entry = {
      url: String(url || ''),
      title: String(title || ''),
      isAI: !!detection?.isAI,
      score: typeof detection?.score === 'number' ? detection.score : null,
      label: detection?.label || '',
      model: detection?.model || '',
      date: new Date().toLocaleString()
    };
    chrome.storage.local.get(['site_visits'], res => {
      const visits = Array.isArray(res?.site_visits) ? res.site_visits : [];
      visits.push(entry);
      chrome.storage.local.set({ site_visits: visits }, resolve);
    });
  });
}

function saveLastScan(text, result) {
  return new Promise(resolve => { const payload = { text, ts: Date.now(), result }; chrome.storage.local.set({ last_scan: payload }, resolve); });
}

function saveLastImageScan(url, result) {
  return new Promise(resolve => { const payload = { url, ts: Date.now(), result }; chrome.storage.local.set({ last_image_scan: payload }, resolve); });
}

function logImageToStorage(url, score) {
  return new Promise(resolve => {
    const entry = { url, score, date: new Date().toLocaleString() };
    chrome.storage.local.get(['image_logs'], res => {
      const logs = Array.isArray(res?.image_logs) ? res.image_logs : []; logs.push(entry);
      chrome.storage.local.set({ image_logs: logs }, resolve);
    });
  });
}
