(function () {
  var OVERLAY_ID = 'yt-shorts-outlier-v3';
  var existing = document.getElementById(OVERLAY_ID);
  if (existing) { existing.remove(); }

  var processedIds = new Set();
  var allVideos = [];
  var autoInterval = null;
  var domObserver = null;
  var activeMinScore = 0;
  var uiRender = null;

  // ─── VIEW PARSING ─────────────────────────────────────────────────────────
  // Handles: "1.2M views", "380K views", "380 thousand views", "1.2 million views",
  //          "380,000 views", "1234 views", plain numbers
  function parseViews(s) {
    if (!s) return 0;
    s = s.replace(/,/g, '').toLowerCase().trim();

    // "X thousand/million/billion views"
    var mWord = s.match(/([\d.]+)\s*(thousand|million|billion)/);
    if (mWord) {
      var n = parseFloat(mWord[1]);
      if (mWord[2] === 'thousand') return Math.round(n * 1e3);
      if (mWord[2] === 'million')  return Math.round(n * 1e6);
      if (mWord[2] === 'billion')  return Math.round(n * 1e9);
    }
    // "1.2M", "380K", "5B" with optional "views"
    var mShort = s.match(/([\d.]+)\s*([kmb])\s*(views?)?/);
    if (mShort) {
      var n2 = parseFloat(mShort[1]);
      if (mShort[2] === 'k') return Math.round(n2 * 1e3);
      if (mShort[2] === 'm') return Math.round(n2 * 1e6);
      if (mShort[2] === 'b') return Math.round(n2 * 1e9);
    }
    // plain "380000 views"
    var mPlain = s.match(/([\d]+)\s*views?/);
    if (mPlain) return parseInt(mPlain[1]);
    // bare number at end
    var mNum = s.match(/([\d]+)$/);
    if (mNum) return parseInt(mNum[1]);
    return 0;
  }

  function parseHours(s) {
    if (!s) return 48;
    s = s.toLowerCase();
    var m;
    if ((m = s.match(/(\d+)\s*sec/)))   return parseFloat(m[1]) / 3600;
    if ((m = s.match(/(\d+)\s*min/)))   return parseFloat(m[1]) / 60;
    if ((m = s.match(/(\d+)\s*hour/)))  return parseFloat(m[1]);
    if ((m = s.match(/(\d+)\s*day/)))   return parseFloat(m[1]) * 24;
    if ((m = s.match(/(\d+)\s*week/)))  return parseFloat(m[1]) * 168;
    if ((m = s.match(/(\d+)\s*month/))) return parseFloat(m[1]) * 720;
    if ((m = s.match(/(\d+)\s*year/)))  return parseFloat(m[1]) * 8760;
    return 48;
  }

  // ─── SCORE ALGORITHM ──────────────────────────────────────────────────────
  function scoreCalc(views, hours) {
    var vph = hours > 0 ? views / hours : 0;
    var s = 0;
    if (vph >= 500000) s += 20;
    else if (vph >= 200000) s += 15;
    else if (vph >= 100000) s += 12;
    else if (vph >= 50000)  s += 9;
    else if (vph >= 20000)  s += 7;
    else if (vph >= 10000)  s += 5;
    else if (vph >= 5000)   s += 3;
    else if (vph >= 1000)   s += 1;
    if (hours < 1 && views > 100000)     s += 8;
    else if (hours < 3 && views > 500000) s += 6;
    else if (hours < 6 && views > 1000000) s += 4;
    else if (hours < 24 && views > 5000000) s += 3;
    if (views >= 5000000)      s += 5;
    else if (views >= 2000000) s += 4;
    else if (views >= 1000000) s += 3;
    else if (views >= 500000)  s += 2;
    return { score: s, vph: Math.round(vph) };
  }

  // ─── CHANNEL EXTRACTION ───────────────────────────────────────────────────
  function extractChannel(item) {
    var strategies = [
      // 1. yt-formatted-string inside ytd-channel-name
      function () {
        var e = item.querySelector('ytd-channel-name yt-formatted-string');
        return e && e.textContent.trim();
      },
      // 2. #channel-name direct text
      function () {
        var e = item.querySelector('#channel-name');
        if (!e) return null;
        // Get just the direct text, not nested counts etc
        var a = e.querySelector('a');
        return (a && a.textContent.trim()) || e.textContent.trim();
      },
      // 3. #owner-text or #owner-name anchor
      function () {
        var e = item.querySelector('#owner-text a, #owner-name a, #channel-info a');
        return e && e.textContent.trim();
      },
      // 4. ytd-video-owner-renderer
      function () {
        var e = item.querySelector('ytd-video-owner-renderer yt-formatted-string');
        return e && e.textContent.trim();
      },
      // 5. avatar link aria-label (often "Channel Name" or "Go to Channel Name")
      function () {
        var e = item.querySelector('a#avatar-link, a[id="avatar-link"]');
        if (!e) return null;
        var lbl = e.getAttribute('aria-label') || '';
        return lbl.replace(/^go\s+to\s+/i, '').trim();
      },
      // 6. Any /@handle in href - extract handle cleanly
      function () {
        var links = item.querySelectorAll('a[href*="/@"]');
        for (var i = 0; i < links.length; i++) {
          var href = links[i].getAttribute('href') || '';
          var m = href.match(/\/@([^/?&#]+)/);
          if (m) {
            // Prefer text label over raw handle if it looks like a real name
            var txt = links[i].textContent.trim();
            if (txt && txt.length > 1 && txt.length < 60 && !/^\d+[KMBkmb]?\s*(view|sub)/i.test(txt)) {
              return txt;
            }
            return '@' + m[1];
          }
        }
      },
      // 7. Any /channel/ or /user/ link
      function () {
        var links = item.querySelectorAll('a[href*="/channel/"], a[href*="/user/"]');
        for (var i = 0; i < links.length; i++) {
          var txt = links[i].textContent.trim();
          if (txt && txt.length > 1 && txt.length < 60 && !/^\d+|view|sub|ago/i.test(txt)) {
            return txt;
          }
        }
      },
      // 8. ytd-reel-player-overlay channel display
      function () {
        var e = item.querySelector('ytd-reel-player-overlay-renderer #channel-name, ytd-shorts #channel-name');
        return e && e.textContent.trim();
      },
      // 9. Any element with class containing "channel" and has non-numeric text
      function () {
        var candidates = item.querySelectorAll('[class*="channel"]');
        for (var i = 0; i < candidates.length; i++) {
          var txt = candidates[i].textContent.trim();
          if (txt && txt.length > 1 && txt.length < 60 && !/^\d/.test(txt)) {
            return txt;
          }
        }
      },
      // 10. ytd-rich-item-renderer > look for any text near/after thumbnail not matching view/time patterns
      function () {
        var spans = item.querySelectorAll('#metadata-line span, #video-info span, #metadata span');
        for (var i = 0; i < spans.length; i++) {
          var txt = spans[i].textContent.trim();
          if (txt && txt.length > 2 && txt.length < 60 &&
              !/^\d|view|ago|sec|min|hour|day|week|month|year/i.test(txt)) {
            return txt;
          }
        }
      },
    ];

    for (var i = 0; i < strategies.length; i++) {
      try {
        var r = strategies[i]();
        if (r && r.length > 0 && r.length < 80) return r;
      } catch (e) { /* skip */ }
    }
    return null; // explicitly null so we can show debug hint
  }

  // ─── META EXTRACTION (views + time) ───────────────────────────────────────
  // YouTube shorts in subscription feed stores data in several formats.
  // Strategy: gather ALL text strings from the item, then classify each.
  function extractMeta(item) {
    var texts = new Set();

    // A. Metadata-line spans (normal feed)
    item.querySelectorAll(
      '#metadata-line span, ytd-video-meta-block span, #video-info span, ' +
      '.ytd-video-meta-block span, #metadata span, yt-formatted-string.ytd-video-meta-block'
    ).forEach(function (e) { var t = e.textContent.trim(); if (t) texts.add(t); });

    // B. All aria-labels on the item - YouTube often puts full info here
    item.querySelectorAll('[aria-label]').forEach(function (e) {
      var a = e.getAttribute('aria-label') || '';
      if (a && /view|hour|minute|second|day|week|month|year|ago/i.test(a)) {
        texts.add(a);
      }
    });

    // C. title attribute on anchors (sometimes has "380K views · 2 days ago")
    item.querySelectorAll('a[title], span[title]').forEach(function (e) {
      var t = e.getAttribute('title') || '';
      if (t && /view|ago/i.test(t)) texts.add(t);
    });

    // D. accessibility text / screen-reader spans
    item.querySelectorAll('.ytd-thumbnail-overlay-time-status-renderer, ' +
      'span[aria-label], yt-formatted-string[aria-label]').forEach(function (e) {
      var a = e.getAttribute('aria-label') || e.textContent.trim();
      if (a) texts.add(a);
    });

    var views = 0, hours = 48, timeText = '';

    texts.forEach(function (t) {
      // Views detection
      if (/view|thousand|million|billion/i.test(t)) {
        var v = parseViews(t);
        if (v > views) views = v;
      }
      // Time detection
      if (/ago|second|minute|hour|day|week|month|year/i.test(t) && !timeText) {
        var h = parseHours(t);
        if (h < 9999) {
          hours = h;
          // Clean up time text to just the relevant part
          var m = t.match(/\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago/i);
          timeText = m ? m[0] : t.slice(0, 30);
        }
      }
    });

    return { views: views, hours: hours, timeText: timeText };
  }

  // ─── TITLE EXTRACTION ─────────────────────────────────────────────────────
  function extractTitle(item) {
    var selectors = [
      '#video-title',
      'yt-formatted-string#video-title',
      'h3 a',
      'a#video-title-link',
      'ytd-rich-grid-media #video-title',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var e = item.querySelector(selectors[i]);
      if (e) {
        var t = (e.textContent || e.getAttribute('title') || e.getAttribute('aria-label') || '').trim();
        if (t) return t;
      }
    }
    // Fallback: aria-label on the shorts link, strip "– play Short" and view counts
    var link = item.querySelector('a[href*="/shorts/"]');
    if (link) {
      var ariaLabel = link.getAttribute('aria-label') || '';
      // Strip suffixes like ", 380 thousand views – play Short"
      var cleaned = ariaLabel
        .replace(/,?\s*[\d.,]+ ?(thousand|million|billion|k|m|b)?\s*views?.*$/i, '')
        .replace(/\s*[-–]\s*play\s*short.*$/i, '')
        .trim();
      if (cleaned) return cleaned;
      // Use link text as last resort
      var txt = link.textContent.trim();
      if (txt && txt.length < 200) return txt;
    }
    return '';
  }

  // ─── FULL VIDEO EXTRACTION ────────────────────────────────────────────────
  function extractVideo(item) {
    var title = extractTitle(item);
    var linkEl = item.querySelector('a[href*="/shorts/"]');
    var href = linkEl ? (linkEl.getAttribute('href') || '') : '';
    var idMatch = href.match(/\/shorts\/([^/?&#]+)/);
    var videoId = idMatch ? idMatch[1] : (title.slice(0, 40) || Math.random().toString(36).slice(2));

    var meta = extractMeta(item);
    var channel = extractChannel(item);
    var calc = scoreCalc(meta.views, meta.hours);

    // Debug snapshot: grab raw text of the whole item for inspection
    var rawSnap = '';
    try {
      var snapParts = [];
      item.querySelectorAll('yt-formatted-string, span, a').forEach(function (e) {
        var t = (e.textContent || '').trim();
        if (t && t.length < 100 && snapParts.indexOf(t) === -1) snapParts.push(t);
      });
      rawSnap = snapParts.slice(0, 20).join(' | ');
    } catch (e) {}

    return {
      id: videoId,
      title: title || '(no title)',
      channel: channel || 'Unknown',
      views: meta.views,
      hours: meta.hours,
      timeText: meta.timeText,
      vph: calc.vph,
      score: calc.score,
      href: href,
      _raw: rawSnap,
    };
  }

  // ─── SCAN DOM ─────────────────────────────────────────────────────────────
  function scanAll() {
    var sel = [
      'ytd-rich-item-renderer',
      'ytd-reel-item-renderer',
      'ytd-video-renderer',
      'ytd-grid-video-renderer',
      'ytd-compact-video-renderer',
    ].join(', ');
    document.querySelectorAll(sel).forEach(function (item) {
      var d = extractVideo(item);
      if (!d.id) return;
      if (processedIds.has(d.id)) {
        for (var i = 0; i < allVideos.length; i++) {
          if (allVideos[i].id === d.id) { allVideos[i] = d; break; }
        }
      } else {
        processedIds.add(d.id);
        allVideos.push(d);
      }
    });
  }

  // ─── FORMATTERS ──────────────────────────────────────────────────────────
  function fv(n) {
    if (!n) return '?';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }
  function fvph(n) {
    if (!n) return '0/h';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M/h';
    if (n >= 1e3) return Math.round(n / 1e3) + 'K/h';
    return n + '/h';
  }
  function ftime(v) {
    if (v.timeText) return v.timeText;
    if (v.hours < 1)  return Math.round(v.hours * 60) + 'm ago';
    if (v.hours < 24) return Math.round(v.hours) + 'h ago';
    return Math.round(v.hours / 24) + 'd ago';
  }
  function scoreColor(s) {
    if (s >= 20) return '#ff3535';
    if (s >= 15) return '#ff7a00';
    if (s >= 10) return '#ffd600';
    if (s >= 5)  return '#69e040';
    return '#444';
  }
  function scoreLabel(s) {
    if (s >= 20) return '💥 VIRAL';
    if (s >= 15) return '⭐ TOP';
    if (s >= 10) return '🔥 HOT';
    if (s >= 5)  return '📈 RISING';
    return '';
  }

  // ─── PURE DOM HELPERS ─────────────────────────────────────────────────────
  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function btn(label, css, handler) {
    var b = el('button', css, label);
    b.addEventListener('click', handler);
    return b;
  }

  // ─── AUTO REFRESH ─────────────────────────────────────────────────────────
  function stopAuto() {
    if (autoInterval)  { clearInterval(autoInterval);  autoInterval = null; }
    if (domObserver)   { domObserver.disconnect();      domObserver = null; }
  }
  function startAuto(renderFn) {
    stopAuto();
    autoInterval = setInterval(function () { scanAll(); renderFn(); }, 3000);
    var target = document.querySelector('ytd-app') || document.body;
    domObserver = new MutationObserver(function (muts) {
      if (muts.some(function (m) { return m.addedNodes.length > 0; })) {
        scanAll(); renderFn();
      }
    });
    domObserver.observe(target, { childList: true, subtree: true });
  }

  // ─── DEBUG HELPER ─────────────────────────────────────────────────────────
  function debugFirstItem() {
    var item = document.querySelector('ytd-rich-item-renderer, ytd-reel-item-renderer');
    if (!item) { alert('No video items found in DOM yet. Scroll down a bit first.'); return; }
    var lines = ['=== DOM DEBUG (first video item) ===\n'];

    // Show all text-bearing elements
    var seen = new Set();
    item.querySelectorAll('*').forEach(function (e) {
      var t = (e.textContent || '').trim();
      if (t && t.length < 150 && !seen.has(t) && t.split(/\s+/).length < 25) {
        seen.add(t);
        var tag = e.tagName.toLowerCase();
        var id = e.id ? '#' + e.id : '';
        var cls = e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '';
        var aria = e.getAttribute('aria-label') ? ' [aria="' + e.getAttribute('aria-label').slice(0, 60) + '"]' : '';
        var href = e.getAttribute('href') ? ' [href=' + e.getAttribute('href').slice(0, 40) + ']' : '';
        lines.push(tag + id + cls + aria + href + ' → "' + t.slice(0, 80) + '"');
      }
    });

    var out = lines.join('\n');
    console.log(out);

    // Show in a modal overlay
    var modal = el('div', 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
      'width:600px;max-height:80vh;background:#0f0f0f;border:1px solid #333;border-radius:12px;' +
      'z-index:2147483647;padding:16px;display:flex;flex-direction:column;gap:10px;');
    var hdr2 = el('div', 'display:flex;justify-content:space-between;align-items:center;');
    var htitle = el('span', 'color:#fff;font-size:13px;font-weight:700;', '🔍 DOM Debug — First Video Item');
    var closeM = btn('✕', 'background:none;border:none;color:#888;cursor:pointer;font-size:16px;', function () { modal.remove(); });
    hdr2.appendChild(htitle); hdr2.appendChild(closeM);
    var pre = el('pre', 'overflow:auto;color:#a0a0a0;font-size:10px;line-height:1.5;flex:1;' +
      'font-family:monospace;white-space:pre-wrap;word-break:break-all;background:#000;padding:10px;border-radius:8px;');
    pre.textContent = out;
    var copyB = btn('📋 Copy to clipboard', 'background:#1a1a1a;color:#ccc;border:1px solid #333;' +
      'border-radius:8px;padding:6px 14px;cursor:pointer;font-size:11px;',
      function () {
        var ta = document.createElement('textarea');
        ta.value = out;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        ta.remove();
        copyB.textContent = '✅ Copied!';
        setTimeout(function () { copyB.textContent = '📋 Copy to clipboard'; }, 1500);
      });
    modal.appendChild(hdr2); modal.appendChild(pre); modal.appendChild(copyB);
    document.body.appendChild(modal);
  }

  // ─── BUILD OVERLAY ────────────────────────────────────────────────────────
  function buildOverlay() {
    var wrap = el('div', [
      'position:fixed', 'top:12px', 'right:12px', 'width:400px', 'max-height:88vh',
      'background:#0a0a0a', 'border:1px solid #2a2a2a', 'border-radius:14px',
      'z-index:2147483647', 'display:flex', 'flex-direction:column',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'box-shadow:0 12px 48px rgba(0,0,0,.9),0 0 0 1px rgba(255,255,255,.04)',
      'overflow:hidden', 'color:#fff'
    ].join(';'));
    wrap.id = OVERLAY_ID;

    // ── HEADER
    var hdr = el('div', 'padding:11px 14px;background:#111;border-bottom:1px solid #222;' +
      'display:flex;align-items:center;gap:8px;flex-shrink:0;cursor:move;user-select:none;');
    var logoWrap = el('div', 'display:flex;align-items:center;gap:7px;flex:1;min-width:0;');
    logoWrap.appendChild(el('span', 'font-size:18px;line-height:1;flex-shrink:0;', '⚡'));
    logoWrap.appendChild(el('span', 'color:#fff;font-weight:700;font-size:13px;letter-spacing:-.2px;flex-shrink:0;', 'Shorts Outlier'));
    logoWrap.appendChild(el('span', 'color:#444;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', '/ subscriptions'));

    var hCtrl = el('div', 'display:flex;gap:5px;align-items:center;flex-shrink:0;');
    var BtnCSS = 'background:#1e1e1e;color:#ccc;border:1px solid #333;border-radius:7px;padding:4px 9px;cursor:pointer;font-size:12px;transition:all .15s;';

    var refreshB = btn('↻', BtnCSS, function () {
      refreshB.textContent = '⏳'; scanAll(); renderList();
      setTimeout(function () { refreshB.textContent = '↻'; }, 600);
    });

    var autoOn = false;
    var autoB = btn('Auto', BtnCSS + 'font-size:10px;font-weight:600;', function () {
      autoOn = !autoOn;
      autoB.textContent = autoOn ? 'Auto ●' : 'Auto';
      autoB.style.color = autoOn ? '#4ade80' : '#ccc';
      autoB.style.background = autoOn ? '#0f2a1a' : '#1e1e1e';
      autoB.style.borderColor = autoOn ? '#166534' : '#333';
      if (autoOn) startAuto(renderList); else stopAuto();
    });

    var debugB = btn('🔍', BtnCSS + 'color:#888;', debugFirstItem);
    debugB.title = 'Debug: show raw DOM data for first video item';

    var closeB = btn('✕', 'background:transparent;color:#444;border:none;cursor:pointer;font-size:14px;padding:2px 5px;', function () {
      stopAuto(); wrap.remove();
    });

    hCtrl.appendChild(refreshB); hCtrl.appendChild(autoB); hCtrl.appendChild(debugB); hCtrl.appendChild(closeB);
    hdr.appendChild(logoWrap); hdr.appendChild(hCtrl);

    // ── STATS BAR
    var statBar = el('div', 'padding:5px 14px;background:#0d0d0d;border-bottom:1px solid #1a1a1a;display:flex;gap:14px;align-items:center;flex-shrink:0;');
    var statVids    = el('span', 'color:#555;font-size:10px;', 'Videos: 0');
    var statOut     = el('span', 'color:#ff5555;font-size:10px;', 'Outliers: 0');
    var statUnknown = el('span', 'color:#666;font-size:10px;', '');
    var statTime    = el('span', 'color:#333;font-size:10px;margin-left:auto;', '—');
    statBar.appendChild(statVids); statBar.appendChild(statOut); statBar.appendChild(statUnknown); statBar.appendChild(statTime);

    // ── FILTER TABS
    var tabs = el('div', 'padding:7px 12px;background:#0a0a0a;border-bottom:1px solid #1a1a1a;display:flex;gap:5px;flex-shrink:0;flex-wrap:wrap;');
    var filterDefs = [
      { label: 'All', min: 0 },
      { label: '📈 Rising', min: 5 },
      { label: '🔥 Hot', min: 10 },
      { label: '⭐ Top', min: 15 },
      { label: '💥 Viral', min: 20 },
    ];
    var tabBtns = filterDefs.map(function (f, idx) {
      var active = idx === 0;
      var b = btn(f.label,
        'background:' + (active ? '#ff0000' : '#1a1a1a') + ';color:' + (active ? '#fff' : '#555') +
        ';border:1px solid ' + (active ? '#ff0000' : '#2a2a2a') + ';border-radius:20px;' +
        'padding:3px 10px;cursor:pointer;font-size:10px;transition:all .15s;',
        function () {
          activeMinScore = f.min;
          tabBtns.forEach(function (bb, i) {
            bb.style.background = (i === idx) ? '#ff0000' : '#1a1a1a';
            bb.style.color      = (i === idx) ? '#fff'    : '#555';
            bb.style.borderColor= (i === idx) ? '#ff0000' : '#2a2a2a';
          });
          renderList();
        });
      tabs.appendChild(b);
      return b;
    });

    // ── CONTENT AREA
    var content = el('div', 'overflow-y:auto;flex:1;');

    // ── FOOTER
    var footer = el('div', 'padding:6px 14px;background:#0d0d0d;border-top:1px solid #1a1a1a;flex-shrink:0;display:flex;gap:8px;align-items:center;');
    var clearB = btn('Clear & Rescan', 'background:#1a1a1a;color:#777;border:1px solid #2a2a2a;border-radius:7px;padding:3px 10px;cursor:pointer;font-size:10px;', function () {
      processedIds.clear(); allVideos = []; scanAll(); renderList();
    });
    var footNote = el('span', 'color:#2a2a2a;font-size:10px;margin-left:auto;', 'scroll to load more ↓');
    footer.appendChild(clearB); footer.appendChild(footNote);

    wrap.appendChild(hdr);
    wrap.appendChild(statBar);
    wrap.appendChild(tabs);
    wrap.appendChild(content);
    wrap.appendChild(footer);
    document.body.appendChild(wrap);

    // ── DRAG
    var drag = { on: false, ox: 0, oy: 0 };
    hdr.addEventListener('mousedown', function (e) {
      drag.on = true;
      var r = wrap.getBoundingClientRect();
      drag.ox = e.clientX - r.left; drag.oy = e.clientY - r.top;
      wrap.style.right = 'auto';
    });
    document.addEventListener('mousemove', function (e) {
      if (!drag.on) return;
      wrap.style.left = (e.clientX - drag.ox) + 'px';
      wrap.style.top  = (e.clientY - drag.oy) + 'px';
    });
    document.addEventListener('mouseup', function () { drag.on = false; });

    // ── RENDER
    function renderList() {
      var sorted = allVideos.slice().sort(function (a, b) { return b.score - a.score; });
      var filtered = sorted.filter(function (v) { return v.score >= activeMinScore; });

      statVids.textContent    = 'Videos: ' + allVideos.length;
      statOut.textContent     = 'Outliers: ' + allVideos.filter(function (v) { return v.score >= 10; }).length;
      var unknownCount = allVideos.filter(function (v) { return v.channel === 'Unknown'; }).length;
      statUnknown.textContent = unknownCount > 0 ? ('⚠ ' + unknownCount + ' unknown ch') : '✓ all channels';
      statUnknown.style.color = unknownCount > 0 ? '#664400' : '#1a5c1a';

      var now = new Date();
      statTime.textContent = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');

      while (content.firstChild) content.removeChild(content.firstChild);

      if (filtered.length === 0) {
        var empty = el('div', 'padding:32px 16px;text-align:center;');
        empty.appendChild(el('div', 'font-size:28px;margin-bottom:8px;', allVideos.length === 0 ? '🔍' : '📭'));
        empty.appendChild(el('div', 'color:#333;font-size:12px;line-height:1.6;', allVideos.length === 0
          ? 'No videos found.\nScroll down first, then hit ↻' : 'No videos at this threshold.\nTry a lower filter.'));
        content.appendChild(empty);
        return;
      }

      filtered.forEach(function (v, idx) {
        var card = el('div', 'padding:9px 13px 8px;border-bottom:1px solid #111;cursor:pointer;transition:background .1s;');
        card.addEventListener('mouseover', function () { card.style.background = '#0f0f0f'; });
        card.addEventListener('mouseout',  function () { card.style.background = ''; });
        if (v.href) card.addEventListener('click', function () {
          window.open('https://www.youtube.com' + v.href, '_blank');
        });

        // ROW 1: rank · score badge · title
        var r1 = el('div', 'display:flex;align-items:flex-start;gap:6px;margin-bottom:4px;');
        r1.appendChild(el('span', 'color:#2a2a2a;font-size:10px;min-width:20px;padding-top:2px;flex-shrink:0;', '#' + (idx + 1)));

        var badge = el('span', 'background:' + scoreColor(v.score) + ';color:#000;font-size:9px;font-weight:800;' +
          'padding:2px 5px;border-radius:8px;flex-shrink:0;margin-top:1px;line-height:1.4;', String(v.score));
        r1.appendChild(badge);

        var titleEl2 = el('span', 'color:#e0e0e0;font-size:12px;line-height:1.35;flex:1;');
        titleEl2.textContent = v.title;
        r1.appendChild(titleEl2);

        // ROW 2: label · channel · views · vph · time
        var r2 = el('div', 'display:flex;gap:6px;padding-left:26px;align-items:center;flex-wrap:wrap;');

        if (v.score >= 5) {
          r2.appendChild(el('span', 'color:' + scoreColor(v.score) + ';font-size:9px;font-weight:700;flex-shrink:0;', scoreLabel(v.score)));
        }

        // Channel pill
        var chanPill = el('span', 'color:' + (v.channel === 'Unknown' ? '#443300' : '#3ea6ff') + ';' +
          'font-size:10px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;',
          v.channel === 'Unknown' ? '⚠ Unknown' : v.channel);
        chanPill.title = v.channel;
        r2.appendChild(chanPill);

        r2.appendChild(el('span', 'color:#888;font-size:10px;', fv(v.views) + ' views'));
        r2.appendChild(el('span', 'color:#f59e0b;font-size:10px;font-weight:600;', fvph(v.vph)));
        r2.appendChild(el('span', 'color:#333;font-size:10px;', ftime(v)));

        card.appendChild(r1); card.appendChild(r2);

        // If channel unknown, show raw debug hint in tiny text
        if (v.channel === 'Unknown' && v._raw) {
          var debugHint = el('div', 'padding-left:26px;margin-top:2px;');
          var hint = el('span', 'color:#2a2a2a;font-size:9px;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;max-width:340px;');
          hint.textContent = v._raw.slice(0, 100);
          hint.title = v._raw;
          debugHint.appendChild(hint);
          card.appendChild(debugHint);
        }

        content.appendChild(card);
      });
    }

    return renderList;
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────
  uiRender = buildOverlay();
  scanAll();
  uiRender();
})();
