'use strict';

// ======= Model configuration =======
const DEFAULT_MODELS = [
  'Hello-SimpleAI/chatgpt-detector-roberta',
  'roberta-base-openai-detector',
  'desklib/ai-text-detector-v1.01',
  'SuperAnnotate/ai-detector',
  'openai-community/roberta-base-openai-detector'
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

// ======= Message router =======
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'scan_text') {
    const textToScan = (msg.payload || '').toString().slice(0, 1000);
    if (!textToScan.trim()) {
      sendResponse({ isAI: false, reason: 'empty_text' });
      return; }

    analyzeText(textToScan)
      .then(async (result) => {
        await saveLastScan(textToScan, result).catch(() => {});
        if (result.isAI) await logToStorage(textToScan).catch(() => {});
        sendResponse(result);
      })
      .catch(async (err) => {
        const errorMsg = err?.message || String(err);
        console.error('DeepShield: inference error:', errorMsg);
        await saveLastScan(textToScan, { isAI: false, error: errorMsg }).catch(() => {});
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

// ======= Text analysis =======
async function analyzeText(text) {
  const { token, threshold, model_id } = await getSettings();
  const decisionThreshold = typeof threshold === 'number' ? threshold : 0.6;

  const modelsToTry = [];
  if (model_id && typeof model_id === 'string' && model_id.trim()) modelsToTry.push(model_id.trim());
  for (const m of DEFAULT_MODELS) if (!modelsToTry.includes(m)) modelsToTry.push(m);

  let lastError = null;
  for (const model of modelsToTry) {
    try {
      const result = isZeroShotModel(model)
        ? await callZeroShot(text, token)
        : await callInference(model, text, token);
      const { predictions, raw, status } = result;
      console.log('DeepShield: raw response:', raw);
      const normalized = normalizePredictions(predictions);
      const { aiScore, aiLabel, best } = decideAIScore(normalized);
      const isAI = aiScore >= decisionThreshold;
      return { isAI, label: aiLabel || best?.label, score: aiScore, predictions: normalized, model, status };
    } catch (e) {
      const msg = e?.message || String(e);
      lastError = msg;
      if (/HTTP\s*(400|401|403|404|429|503)/i.test(msg) || /not\s*found/i.test(msg) || /loading/i.test(msg)) {
        console.warn(`DeepShield: model '${model}' failed (${msg}). Trying next...`);
        continue;
      }
      throw e;
    }
  }

  // Zero-shot fallback then heuristic
  try {
    const { predictions, raw } = await callZeroShot(text, token);
    console.log('DeepShield: zero-shot raw response:', raw);
    const normalized = normalizePredictions(predictions);
    const { aiScore, aiLabel, best } = decideAIScore(normalized);
    const isAI = aiScore >= decisionThreshold;
    return { isAI, label: aiLabel || best?.label, score: aiScore, predictions: normalized, model: ZERO_SHOT_FALLBACK_MODEL, status: 200 };
  } catch (e2) {
    console.warn('DeepShield: zero-shot fallback failed:', e2?.message || e2);
    const preds = heuristicPredict(text);
    const normalized = normalizePredictions(preds);
    const { aiScore, aiLabel, best } = decideAIScore(normalized);
    const isAI = aiScore >= decisionThreshold;
    return { isAI, label: aiLabel || best?.label, score: aiScore, predictions: normalized, model: 'heuristic-local', status: 200 };
  }
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

  const aiCandidates = match(/fake|ai|gpt|generated|deepfake/);
  if (aiCandidates.length) {
    const aiBest = aiCandidates.reduce((a, b) => (a.score || 0) > (b.score || 0) ? a : b);
    return { aiScore: aiBest.score || 0, aiLabel: aiBest.label, best };
  }
  const lbl1 = byLabel('LABEL_1');
  const lbl0 = byLabel('LABEL_0');
  if (lbl1) return { aiScore: lbl1.score || 0, aiLabel: 'LABEL_1', best };
  if (lbl0) return { aiScore: 1 - (lbl0.score || 0), aiLabel: 'not LABEL_0', best };

  const real = match(/real/);
  if (real.length) {
    const realBest = real.reduce((a, b) => (a.score || 0) > (b.score || 0) ? a : b);
    return { aiScore: 1 - (realBest.score || 0), aiLabel: 'not real', best };
  }
  return { aiScore: best.score || 0, aiLabel: best.label, best };
}

function heuristicPredict(text) {
  const t = (text || '').toLowerCase();
  const phrases = ['as an ai language model','as a language model','i do not have personal','cannot browse the internet','my training data','chatgpt','openai','large language model','in this essay','in conclusion','furthermore','moreover','on the other hand','this article explores','this report discusses'];
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
