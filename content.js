"use strict";

console.log("DeepShield content script loaded");

function safeSnippet(text, max = 80) {
  const snippet = (text || "").slice(0, max);
  return snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getVisibleText() {
  try {
    const body = document.body;
    if (!body) return;

    // Respect real-time detection toggle
    chrome.storage.local.get(["realtime"], (cfg) => {
      if (cfg && cfg.realtime === false) return; // user disabled autoscan

      let text = (body.innerText || "").trim();
      if (!text) return; // nothing to scan

      text = text.slice(0, 1000); // keep payload small

      chrome.runtime.sendMessage({ type: "scan_text", payload: text }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("DeepShield: message error:", chrome.runtime.lastError.message);
          return;
        }
        if (!response) return;
        if (response.error) {
          console.warn("DeepShield: background error:", response.error);
          // As a last resort, still try to highlight heuristically
          highlightAIText(text);
          return;
        }
        if (response.isAI) {
          highlightAIText(text);
          try { chrome.storage.local.set({ flaggedText: text }); } catch (e) {}
        }
      });
    });
  } catch (e) {
    console.warn("DeepShield content error:", e);
  }
}

function highlightAIText(aiText) {
  // Helper: highlight using a regex on text nodes; returns true if highlighted
  function highlightFirstMatch(regex) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue || "";
      if (regex.test(value)) {
        const span = document.createElement("span");
        span.textContent = value;
        span.style.backgroundColor = "yellow";
        span.style.color = "red";
        span.style.fontWeight = "bold";
        span.title = "Suspected AI-generated text";
        if (node.parentNode) node.parentNode.replaceChild(span, node);
        return true;
      }
    }
    return false;
  }

  // Attempt 1: direct snippet match
  const pattern = safeSnippet(aiText, 80);
  if (pattern) {
    const regex = new RegExp(pattern, "i");
    if (highlightFirstMatch(regex)) return;
  }

  // Attempt 2: keyword pair within distance
  const words = (aiText || "").toLowerCase().match(/[a-z]{4,}/g) || [];
  const uniq = Array.from(new Set(words));
  if (uniq.length >= 2) {
    const w1 = uniq[0];
    const w2 = uniq[Math.min(uniq.length - 1, Math.floor(uniq.length / 2))];
    const kwRegex = new RegExp(`${escapeRegExp(w1)}[\\s\\S]{0,120}${escapeRegExp(w2)}`, "i");
    if (highlightFirstMatch(kwRegex)) return;
  }

  // Attempt 3: highlight first long text block as a last resort
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const value = (node.nodeValue || "").trim();
    if (value.split(/\s+/).length > 8) {
      const span = document.createElement("span");
      span.textContent = value;
      span.style.backgroundColor = "yellow";
      span.style.color = "red";
      span.style.fontWeight = "bold";
      span.title = "Suspected AI-generated text (heuristic)";
      if (node.parentNode) node.parentNode.replaceChild(span, node);
      return;
    }
  }
}

function overlayBadge(img, text, color) {
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.style.display = 'inline-block';
  wrap.style.lineHeight = '0';

  const badge = document.createElement('div');
  badge.textContent = text;
  badge.style.position = 'absolute';
  badge.style.left = '6px';
  badge.style.top = '6px';
  badge.style.padding = '3px 6px';
  badge.style.fontSize = '12px';
  badge.style.borderRadius = '6px';
  badge.style.color = '#fff';
  badge.style.background = color || 'rgba(239,68,68,.9)';
  badge.style.zIndex = '9999';

  img.parentNode.insertBefore(wrap, img);
  wrap.appendChild(img);
  wrap.appendChild(badge);
}

function scanImagesOnPage() {
  chrome.storage.local.get(["realtime"], (cfg) => {
    if (cfg && cfg.realtime === false) return;

    const imgs = Array.from(document.images || []);
    imgs.slice(0, 8).forEach((img, idx) => {
      try {
        const src = img.currentSrc || img.src;
        if (!src || /data:image\//i.test(src)) return; // skip inline base64
        const elemId = `ds-img-${Date.now()}-${idx}`;
        img.setAttribute('data-ds-id', elemId);

        chrome.runtime.sendMessage({ type: 'scan_image', url: src, elemId }, (res) => {
          if (!res || res.error) return;
          const score = Number(res.score || 0);
          if (!Number.isFinite(score)) return;

          if (score > 0.7) overlayBadge(img, `AI ${Math.round(score*100)}%`, 'rgba(239,68,68,.9)');
          else if (score >= 0.3) overlayBadge(img, `Uncertain ${Math.round(score*100)}%`, 'rgba(245,158,11,.9)');
          else overlayBadge(img, `Human ${Math.round((1-score)*100)}%`, 'rgba(16,185,129,.9)');
        });
      } catch {}
    });
  });
}

function triggerScanWhenReady() {
  if (document.readyState === "complete" || document.readyState === "interactive") {
    getVisibleText();
    scanImagesOnPage();
  } else {
    window.addEventListener("DOMContentLoaded", () => { getVisibleText(); scanImagesOnPage(); }, { once: true });
  }
}

triggerScanWhenReady();
