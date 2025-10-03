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

      text = text.slice(0, 4000); // keep payload moderate for ensemble

      chrome.runtime.sendMessage({ type: "scan_text", payload: text, meta: { url: location.href, title: document.title } }, (response) => {
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
          const nodes = highlightAIText(text, response);
          try { chrome.storage.local.set({ flaggedText: text }); } catch (e) {}
          if (nodes && nodes.length) attachDeleteButton(nodes);
        }
      });
    });
  } catch (e) {
    console.warn("DeepShield content error:", e);
  }
}

function highlightAIText(aiText, resp) {
  const replacedNodes = [];
  function highlightRangeInNode(node, start, end, titleText) {
    const value = node.nodeValue || "";
    const before = value.slice(0, start);
    const target = value.slice(start, end);
    const after = value.slice(end);

    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    const span = document.createElement("span");
    span.textContent = target;
    span.style.backgroundColor = "#fff3cd";
    span.style.color = "#7c2d12";
    span.style.fontWeight = "600";
    span.style.padding = "0 2px";
    span.className = "deepshield-flag";
    span.title = titleText || "Suspected AI-generated text";
    frag.appendChild(span);
    if (after) frag.appendChild(document.createTextNode(after));
    if (node.parentNode) node.parentNode.replaceChild(frag, node);
    replacedNodes.push(span);
  }

  function highlightFirstMatch(regex) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue || "";
      const m = regex.exec(value);
      if (m) {
        const s = m.index;
        const e = s + m[0].length;
        highlightRangeInNode(node, s, e);
        return true;
      }
    }
    return false;
  }

  // Attempt 1: direct snippet match
  const pattern = safeSnippet(aiText, 200);
  if (pattern) {
    const regex = new RegExp(pattern, "i");
    if (highlightFirstMatch(regex)) return replacedNodes;
  }

  // Attempt 2: keyword pair within distance
  const words = (aiText || "").toLowerCase().match(/[a-z]{4,}/g) || [];
  const uniq = Array.from(new Set(words));
  if (uniq.length >= 2) {
    const w1 = uniq[0];
    const w2 = uniq[Math.min(uniq.length - 1, Math.floor(uniq.length / 2))];
    const kwRegex = new RegExp(`${escapeRegExp(w1)}[\\s\\S]{0,200}${escapeRegExp(w2)}`, "i");
    if (highlightFirstMatch(kwRegex)) return replacedNodes;
  }

  // Attempt 3: highlight first long text block as a last resort
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const value = (node.nodeValue || "").trim();
    if (value.split(/\s+/).length > 8) {
      highlightRangeInNode(node, 0, value.length, 'Suspected AI-generated text (heuristic)');
      return replacedNodes;
    }
  }
  return replacedNodes;
}

function attachDeleteButton(flagNodes) {
  try {
    if (!flagNodes || !flagNodes.length) return;
    // Add a floating button near the first flagged element
    const first = flagNodes[0];
    const btn = document.createElement('button');
    btn.textContent = 'Delete AI Text';
    btn.style.position = 'fixed';
    btn.style.right = '16px';
    btn.style.bottom = '16px';
    btn.style.zIndex = '2147483647';
    btn.style.padding = '8px 12px';
    btn.style.borderRadius = '8px';
    btn.style.border = '1px solid #ef4444';
    btn.style.background = '#ef4444';
    btn.style.color = '#fff';
    btn.style.boxShadow = '0 4px 12px rgba(0,0,0,.2)';
    btn.style.cursor = 'pointer';

    btn.addEventListener('click', () => {
      // Remove all flagged nodes' text from the DOM
      document.querySelectorAll('.deepshield-flag').forEach(el => {
        const parent = el.parentNode;
        if (!parent) return;
        // Remove the highlighted span entirely (delete flagged text)
        parent.removeChild(el);
        // Attempt to merge adjacent text nodes to keep layout tidy
        parent.normalize();
      });
      // Remove the button after action
      btn.remove();
    });

    document.body.appendChild(btn);
  } catch (_) {}
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
