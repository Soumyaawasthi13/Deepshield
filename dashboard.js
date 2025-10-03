document.addEventListener("DOMContentLoaded", () => {
  const els = {
    token: document.getElementById("hf-token"),
    toggleToken: document.getElementById("toggle-token"),
    checkToken: document.getElementById("check-token"),
    tokenStatus: document.getElementById("token-status"),
    model: document.getElementById("model-id"),
    thresholdSlider: document.getElementById("threshold-slider"),
    thresholdValue: document.getElementById("threshold-value"),
    realtimeToggle: document.getElementById("realtime-toggle"),
    themeToggle: document.getElementById("theme-toggle"),

    saveBtn: document.getElementById("save-settings"),
    clearBtn: document.getElementById("clear-token"),

    scanStatus: document.getElementById("scan-status"),
    scanScore: document.getElementById("scan-score"),
    scanLabel: document.getElementById("scan-label"),
    scanModel: document.getElementById("scan-model"),

    quickInput: document.getElementById("quick-input"),
    runTest: document.getElementById("run-test"),
    quickResult: document.getElementById("quick-result"),

    logList: document.getElementById("log-list"),
    toast: document.getElementById("toast"),
    sites: document.getElementById("sites"),
    clearSites: document.getElementById("clear-sites"),
  };

  // UI helpers
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    setTimeout(() => els.toast.classList.remove("show"), 1600);
  }
  function setStatus(el, type, text) {
    el.className = `status ${type}`;
    el.textContent = text;
  }
  function setBadge(score) {
    if (typeof score !== 'number') {
      els.scanStatus.className = 'badge';
      els.scanStatus.textContent = 'No recent scan';
      return;
    }
    if (score < 0.3) {
      els.scanStatus.className = 'badge green';
      els.scanStatus.textContent = '🟢 Likely Human';
    } else if (score <= 0.7) {
      els.scanStatus.className = 'badge yellow';
      els.scanStatus.textContent = '🟡 Uncertain';
    } else {
      els.scanStatus.className = 'badge red';
      els.scanStatus.textContent = '🔴 Likely AI';
    }
  }

  // Load existing settings & state
  chrome.storage.local.get([
    "hf_token", "model_id", "threshold", "logs", "last_scan", "flaggedText", "realtime", "theme", "last_image_scan", "site_visits"
  ], (data) => {
    if (els.token && typeof data.hf_token === "string") els.token.value = data.hf_token;
    if (els.model && typeof data.model_id === "string") els.model.value = data.model_id;

    // Threshold slider
    const t = (typeof data.threshold === 'number') ? data.threshold : 0.6;
    els.thresholdSlider.value = String(t);
    els.thresholdValue.textContent = t.toFixed(2);

    // Toggles
    if (typeof data.realtime === 'boolean') els.realtimeToggle.checked = data.realtime; else els.realtimeToggle.checked = true;
    if (typeof data.theme === 'string') document.body.classList.toggle('dark', data.theme === 'dark');
    els.themeToggle.checked = document.body.classList.contains('dark');

    // Last scan details
    const last = data.last_scan;
    if (last && last.result) {
      const r = last.result;
      if (r.error) {
        els.scanStatus.className = 'badge red';
        els.scanStatus.textContent = `Error`;
        els.scanScore.textContent = '—';
        els.scanLabel.textContent = r.error;
        els.scanModel.textContent = '—';
      } else {
        const score = typeof r.score === 'number' ? r.score : NaN;
        setBadge(score);
        els.scanScore.textContent = Number.isFinite(score) ? score.toFixed(3) : '—';
        // Colorful label chip
        const lbl = r.label || '—';
        els.scanLabel.innerHTML = '';
        const chip = document.createElement('span');
        chip.className = 'label-chip ' + (score < 0.3 ? 'label-green' : score <= 0.7 ? 'label-yellow' : 'label-red');
        chip.textContent = lbl;
        els.scanLabel.appendChild(chip);
        els.scanModel.textContent = r.model || '—';
      }
    }

    // Last image scan details
    const lastImg = data.last_image_scan;
    if (lastImg && lastImg.result) {
      const r = lastImg.result;
      const score = typeof r.score === 'number' ? r.score : NaN;
      const imgScore = document.getElementById('img-score');
      const imgLabel = document.getElementById('img-label');
      const imgModel = document.getElementById('img-model');
      const imgUrl = document.getElementById('img-url');
      const imgStatus = document.getElementById('img-status');
      if (imgScore) imgScore.textContent = Number.isFinite(score) ? score.toFixed(3) : '—';
      if (imgLabel) {
        imgLabel.innerHTML = '';
        const chip = document.createElement('span');
        chip.className = 'label-chip ' + (score < 0.3 ? 'label-green' : score <= 0.7 ? 'label-yellow' : 'label-red');
        chip.textContent = r.label || '—';
        imgLabel.appendChild(chip);
      }
      if (imgModel) imgModel.textContent = r.model || '—';
      if (imgUrl) imgUrl.textContent = lastImg.url || '—';
      if (imgStatus) {
        if (score < 0.3) { imgStatus.className = 'badge green'; imgStatus.textContent = '🟢 Likely Human'; }
        else if (score <= 0.7) { imgStatus.className = 'badge yellow'; imgStatus.textContent = '🟡 Uncertain'; }
        else { imgStatus.className = 'badge red'; imgStatus.textContent = '🔴 Likely AI'; }
      }
    }

    // Logs
    const logs = Array.isArray(data.logs) ? data.logs : [];
    renderLogs(logs);

    // Sites
    const sites = Array.isArray(data.site_visits) ? data.site_visits : [];
    renderSites(sites);
  });

  function renderLogs(logs) {
    els.logList.innerHTML = '';
    logs.forEach((entry, idx) => {
      const item = document.createElement('div');
      item.className = 'log-item';
      item.innerHTML = `
        <div class="log-head">
          <div class="chip">${entry.date || ''}</div>
          <div>
            <button class="btn small" data-copy="${idx}">Copy</button>
            <button class="btn small danger" data-delete-log="${idx}">Delete</button>
          </div>
        </div>
        <div class="log-text" id="log-${idx}"></div>
      `;
      els.logList.appendChild(item);
      const textEl = document.getElementById(`log-${idx}`);
      const text = String(entry.text || '');
      // Simple highlight of suspicious phrases
      const phrases = /(chatgpt|as an ai|language model|in conclusion|furthermore|moreover)/gi;
      textEl.innerHTML = text.replace(phrases, (m) => `<span class="highlight">${m}</span>`);
    });
  }

  function renderSites(sites) {
    if (!els.sites) return;
    els.sites.innerHTML = '';
    sites.slice().reverse().forEach((s) => {
      const row = document.createElement('div');
      row.className = 'site-item';
      const score = typeof s.score === 'number' ? s.score : NaN;
      const badgeClass = !Number.isFinite(score) ? '' : (score < 0.3 ? 'green' : score <= 0.7 ? 'yellow' : 'red');
      const badgeText = !Number.isFinite(score) ? '—' : (score < 0.3 ? '🟢 Human' : score <= 0.7 ? '🟡 Uncertain' : '🔴 AI');
      row.innerHTML = `
        <div class="site-meta">
          <div class="site-title">${(s.title || s.url || '').replace(/</g,'&lt;')}</div>
          <div class="site-url">${(s.url || '').replace(/</g,'&lt;')}</div>
          <div class="help">${s.date || ''}</div>
        </div>
        <div>
          <span class="badge ${badgeClass}">${badgeText}</span>
        </div>`;
      els.sites.appendChild(row);
    });
  }

  // Save / Clear
  els.saveBtn.addEventListener('click', () => {
    const hf_token = els.token ? els.token.value.trim() : '';
    const model_id = els.model ? els.model.value.trim() : '';
    const tVal = Number(els.thresholdSlider.value);
    const threshold = Number.isFinite(tVal) ? tVal : 0.6;
    const realtime = !!els.realtimeToggle.checked;
    const theme = els.themeToggle.checked ? 'dark' : 'light';

    const payload = { hf_token, threshold, realtime, theme };
    if (model_id) payload.model_id = model_id;

    chrome.storage.local.set(payload, () => toast('Settings saved'));
  });

  els.clearBtn.addEventListener('click', () => {
    if (els.token) els.token.value = '';
    chrome.storage.local.remove(['hf_token'], () => toast('Token cleared'));
  });

  // Token show/hide
  els.toggleToken.addEventListener('click', () => {
    if (!els.token) return;
    els.token.type = els.token.type === 'password' ? 'text' : 'password';
    els.toggleToken.textContent = els.token.type === 'password' ? '👁️' : '🙈';
  });

  // Token check: makes a simple call to a public model
  els.checkToken.addEventListener('click', async () => {
    const token = els.token.value.trim();
    if (!token) {
      setStatus(els.tokenStatus, 'warn', 'No token');
      return;
    }
    setStatus(els.tokenStatus, 'warn', 'Checking...');
    try {
      const res = await fetch('https://api-inference.huggingface.co/models/facebook/bart-large-mnli', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ inputs: 'Hello world' })
      });
      if (res.status === 401) { setStatus(els.tokenStatus, 'err', 'Invalid'); return; }
      if (res.status === 403) { setStatus(els.tokenStatus, 'warn', 'Limited'); return; }
      if (!res.ok) { setStatus(els.tokenStatus, 'warn', `HTTP ${res.status}`); return; }
      setStatus(els.tokenStatus, 'ok', 'Valid');
    } catch (e) {
      setStatus(els.tokenStatus, 'err', 'Network error');
    }
  });

  // Slider reflect value
  els.thresholdSlider.addEventListener('input', () => {
    const v = Number(els.thresholdSlider.value);
    els.thresholdValue.textContent = v.toFixed(2);
  });

  // Dark mode toggle immediate
  els.themeToggle.addEventListener('change', () => {
    const dark = !!els.themeToggle.checked;
    document.body.classList.toggle('dark', dark);
  });

  // Quick test runner: bypass content script and hit background through runtime
  els.runTest.addEventListener('click', () => {
    const text = (els.quickInput.value || '').slice(0, 1000);
    if (!text.trim()) { els.quickResult.textContent = 'Enter some text.'; return; }
    els.quickResult.textContent = 'Testing...';

    chrome.runtime.sendMessage({ type: 'scan_text', payload: text }, (response) => {
      if (chrome.runtime.lastError) {
        els.quickResult.textContent = `Error: ${chrome.runtime.lastError.message}`;
        return;
      }
      if (!response) { els.quickResult.textContent = 'No response'; return; }
      if (response.error) { els.quickResult.textContent = `Error: ${response.error}`; return; }

      const score = typeof response.score === 'number' ? response.score : NaN;
      els.quickResult.textContent = `Score=${Number.isFinite(score) ? score.toFixed(3) : '—'} · Label=${response.label || '—'} · Model=${response.model || '—'}`;
      // Also update last scan card immediately
      setBadge(score);
      els.scanScore.textContent = Number.isFinite(score) ? score.toFixed(3) : '—';
      els.scanLabel.innerHTML = '';
      const chip = document.createElement('span');
      chip.className = 'label-chip ' + (score < 0.3 ? 'label-green' : score <= 0.7 ? 'label-yellow' : 'label-red');
      chip.textContent = response.label || '—';
      els.scanLabel.appendChild(chip);
      els.scanModel.textContent = response.model || '—';
    });
  });

  // Manual image upload flow
  const imgFile = document.getElementById('img-file');
  const imgPreview = document.getElementById('img-preview');
  const imgResult = document.getElementById('img-result');
  const runImage = document.getElementById('run-image');
  const dlImgReport = document.getElementById('download-img-report');

  if (imgFile) {
    imgFile.addEventListener('change', () => {
      const f = imgFile.files && imgFile.files[0];
      if (!f) { if(imgPreview){imgPreview.style.display = 'none'; imgPreview.src='';} return; }
      const url = URL.createObjectURL(f);
      if (imgPreview) { imgPreview.src = url; imgPreview.style.display = 'block'; }
    });
  }

  if (runImage) {
    runImage.addEventListener('click', async () => {
      const f = imgFile && imgFile.files && imgFile.files[0];
      if (!f) { if(imgResult) imgResult.textContent = 'Choose an image first.'; return; }
      if (imgResult) imgResult.textContent = 'Analyzing...';
      try {
        const b64 = await fileToDataURL(f);
        const blob = await (await fetch(b64)).blob();
        const tmpUrl = URL.createObjectURL(blob);
        chrome.runtime.sendMessage({ type: 'scan_image', url: tmpUrl }, (res) => {
          if (chrome.runtime.lastError) { if(imgResult) imgResult.textContent = `Error: ${chrome.runtime.lastError.message}`; return; }
          if (!res) { if(imgResult) imgResult.textContent = 'No response'; return; }
          if (res.error) { if(imgResult) imgResult.textContent = `Error: ${res.error}`; return; }
          const score = typeof res.score === 'number' ? res.score : NaN;
          // Emphasized, color-coded image result
          if (imgResult) {
            imgResult.className = 'emph-result ' + (score < 0.3 ? 'emph-green' : score <= 0.7 ? 'emph-yellow' : 'emph-red');
            imgResult.textContent = (score < 0.3 ? 'Likely Human' : score <= 0.7 ? 'Uncertain' : 'Likely AI') + ` · Score=${Number.isFinite(score) ? score.toFixed(3) : '—'}`;
          }
          URL.revokeObjectURL(tmpUrl);
          // Reflect in Last Image Scan panel immediately
          const imgScore = document.getElementById('img-score');
          const imgLabel = document.getElementById('img-label');
          const imgModel = document.getElementById('img-model');
          const imgUrl = document.getElementById('img-url');
          const imgStatus = document.getElementById('img-status');
          if (imgScore) imgScore.textContent = Number.isFinite(score) ? score.toFixed(3) : '—';
          if (imgLabel) { imgLabel.innerHTML = ''; const chip = document.createElement('span'); chip.className = 'label-chip ' + (score < 0.3 ? 'label-green' : score <= 0.7 ? 'label-yellow' : 'label-red'); chip.textContent = res.label || '—'; imgLabel.appendChild(chip); }
          if (imgModel) imgModel.textContent = res.model || '—';
          if (imgUrl) imgUrl.textContent = res.imageUrl || '—';
          if (imgStatus) { if (score < 0.3) { imgStatus.className = 'badge green'; imgStatus.textContent = '🟢 Likely Human'; } else if (score <= 0.7) { imgStatus.className = 'badge yellow'; imgStatus.textContent = '🟡 Uncertain'; } else { imgStatus.className = 'badge red'; imgStatus.textContent = '🔴 Likely AI'; } }
        });
      } catch (e) {
        if (imgResult) imgResult.textContent = `Error: ${e?.message || e}`;
      }
    });
  }

  if (dlImgReport) {
    dlImgReport.addEventListener('click', () => {
      chrome.storage.local.get(['last_image_scan'], (data) => {
        const rep = data.last_image_scan || {};
        const text = JSON.stringify(rep, null, 2);
        download('deepshield_image_report.json', text);
      });
    });
  }

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read_error'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(file);
    });
  }

  // Export logs
  function download(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  document.getElementById('export-json').addEventListener('click', () => {
    chrome.storage.local.get(['logs'], (data) => {
      const logs = Array.isArray(data.logs) ? data.logs : [];
      download('deepshield_logs.json', JSON.stringify(logs, null, 2));
    });
  });

  document.getElementById('export-csv').addEventListener('click', () => {
    chrome.storage.local.get(['logs'], (data) => {
      const logs = Array.isArray(data.logs) ? data.logs : [];
      const csv = ['date,text'].concat(logs.map(l => `"${(l.date||'').replace(/"/g,'""')}","${(l.text||'').replace(/"/g,'""')}"`)).join('\n');
      download('deepshield_logs.csv', csv);
    });
  });

  if (els.clearSites) {
    els.clearSites.addEventListener('click', () => {
      chrome.storage.local.remove(['site_visits'], () => {
        renderSites([]);
        toast('Cleared site activity');
      });
    });
  }

  // Copy/Delete buttons delegation
  els.logList.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('button[data-copy]');
    const delBtn = e.target.closest('button[data-delete-log]');

    if (copyBtn) {
      const idx = Number(copyBtn.getAttribute('data-copy'));
      const el = document.getElementById(`log-${idx}`);
      const text = el ? el.textContent : '';
      navigator.clipboard.writeText(text).then(() => toast('Copied'));
      return;
    }

    if (delBtn) {
      const idx = Number(delBtn.getAttribute('data-delete-log'));
      chrome.storage.local.get(['logs'], (data) => {
        const logs = Array.isArray(data.logs) ? data.logs : [];
        if (idx >= 0 && idx < logs.length) {
          logs.splice(idx, 1);
          chrome.storage.local.set({ logs }, () => {
            renderLogs(logs);
            toast('Deleted');
          });
        }
      });
      return;
    }
  });
});
