(() => {
  'use strict';
  const L = window.ObsLogic;
  const $ = (id) => document.getElementById(id);

  const STORE_KEY = 'obs-timer-config-v1';
  const DEFAULT_CONFIG = {
    participant: '', observer: '', sessionMin: 10, intervalSec: 10, method: 'partial', cue: true,
    behaviors: [
      { name: 'On task', key: 'a', type: 'duration' },
      { name: 'Vocalisation', key: 's', type: 'event' },
      { name: 'Out of seat', key: 'd', type: 'duration' },
    ],
  };
  const METHOD_LABEL = { partial: 'Partial interval', whole: 'Whole interval', momentary: 'Momentary time sampling' };
  const BEHAVIOUR_KINDS = new Set(['event', 'start', 'stop', 'note']);

  /* ───────── config persistence (per-browser convenience only) ───────── */
  function loadConfig() {
    try {
      const c = JSON.parse(localStorage.getItem(STORE_KEY));
      if (c && Array.isArray(c.behaviors)) return { ...DEFAULT_CONFIG, ...c };
    } catch (e) { /* storage unavailable */ }
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  function saveConfig(c) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(c)); } catch (e) { /* ignore */ }
  }

  let config = loadConfig();
  let session = null;
  let tickTimer = null;
  let audioCtx = null;
  let wakeLock = null;

  /* ───────── setup panel ───────── */
  function renderSetup() {
    $('participant').value = config.participant;
    $('observer').value = config.observer;
    $('sessionMin').value = config.sessionMin;
    $('intervalSec').value = config.intervalSec;
    $('method').value = config.method;
    $('cue').checked = config.cue;
    const tbody = $('behRows');
    tbody.innerHTML = '';
    config.behaviors.forEach((b) => tbody.appendChild(behaviourRow(b)));
  }

  function behaviourRow(b) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input data-f="name" aria-label="Behaviour name"></td>
      <td><input data-f="key" maxlength="1" aria-label="Hotkey"></td>
      <td><select data-f="type" aria-label="Type">
            <option value="event">Event</option><option value="duration">Duration</option></select></td>
      <td><button type="button" class="icon" title="Remove">✕</button></td>`;
    tr.querySelector('[data-f=name]').value = b.name;
    tr.querySelector('[data-f=key]').value = b.key;
    tr.querySelector('[data-f=type]').value = b.type;
    tr.querySelector('button').addEventListener('click', () => tr.remove());
    return tr;
  }

  function readSetup() {
    const behaviors = [...$('behRows').querySelectorAll('tr')].map((tr) => ({
      name: tr.querySelector('[data-f=name]').value.trim(),
      key: tr.querySelector('[data-f=key]').value.trim().toLowerCase(),
      type: tr.querySelector('[data-f=type]').value,
    })).filter((b) => b.name || b.key);
    return {
      participant: $('participant').value.trim(),
      observer: $('observer').value.trim(),
      sessionMin: parseFloat($('sessionMin').value),
      intervalSec: parseFloat($('intervalSec').value),
      method: $('method').value,
      cue: $('cue').checked,
      behaviors,
    };
  }

  function validate(c) {
    if (!(c.sessionMin >= 0)) return 'Session length must be 0 or more minutes.';
    if (!(c.intervalSec >= 1)) return 'Interval length must be at least 1 second.';
    if (!c.behaviors.length) return 'Add at least one behaviour.';
    const seen = new Set();
    for (const b of c.behaviors) {
      if (!b.name) return `The behaviour with key "${b.key}" needs a name.`;
      if (b.key.length !== 1 || b.key === ' ') return `"${b.name}" needs a single-character hotkey (not space).`;
      if (seen.has(b.key)) return `Hotkey "${b.key}" is used more than once.`;
      seen.add(b.key);
    }
    if (c.method !== 'partial' && !c.behaviors.some((b) => b.type === 'duration')) {
      return `${METHOD_LABEL[c.method]} scores only duration behaviours. Add one or choose partial interval.`;
    }
    return null;
  }

  /* ───────── session lifecycle ───────── */
  function startSession() {
    const c = readSetup();
    const err = validate(c);
    $('setupError').textContent = err || '';
    if (err) return;
    config = c;
    saveConfig(config);

    session = {
      config: c,
      behaviors: c.behaviors.map((b, i) => ({ ...b, id: 'b' + (i + 1) })),
      events: [],
      running: true,
      base: 0,
      startPerf: performance.now(),
      startedAt: new Date(),
      lastInterval: 0,
      ended: false,
      exported: false,
    };
    session.byKey = Object.fromEntries(session.behaviors.map((b) => [b.key, b]));

    initAudio();
    requestWakeLock();
    buildButtons();
    $('meta').textContent = metaLine();
    show('run');
    renderLog();
    tickTimer = setInterval(tick, 100);
    tick();
  }

  function elapsed() {
    if (!session) return 0;
    return session.base + (session.running ? (performance.now() - session.startPerf) / 1000 : 0);
  }
  const limitSec = () => (session.config.sessionMin > 0 ? session.config.sessionMin * 60 : Infinity);

  function togglePause() {
    if (!session || session.ended) return;
    const t = elapsed();
    if (session.running) {
      session.base = t;
      session.running = false;
      session.events.push({ t, kind: 'pause' });
      releaseWakeLock();
    } else {
      session.startPerf = performance.now();
      session.running = true;
      session.events.push({ t, kind: 'resume' });
      requestWakeLock();
    }
    renderLog();
    tick();
  }

  function endSession(atT) {
    if (!session || session.ended) return;
    const t = Math.min(atT != null ? atT : elapsed(), limitSec());
    session.base = t;
    session.running = false;
    session.ended = true;
    session.endT = t;
    clearInterval(tickTimer);
    releaseWakeLock();
    renderResults();
    show('results');
  }

  function newSession() {
    if (session && !session.exported && !confirm('Discard this session without downloading a CSV?')) return;
    session = null;
    renderSetup();
    show('setup');
  }

  /* ───────── recording ───────── */
  function record(b) {
    if (!session || session.ended) return;
    if (!session.running) return;
    const t = elapsed();
    if (b.type === 'event') {
      session.events.push({ t, kind: 'event', behaviorId: b.id });
    } else {
      const on = b.id in L.activeBouts(session.events);
      session.events.push({ t, kind: on ? 'stop' : 'start', behaviorId: b.id });
    }
    const btn = document.querySelector(`.beh-btn[data-id="${b.id}"]`);
    if (btn) { btn.classList.add('hit'); setTimeout(() => btn.classList.remove('hit'), 150); }
    renderLog();
    renderButtons();
  }

  function addNote() {
    const input = $('noteInput');
    const text = input.value.trim();
    if (!session || session.ended || !text) return;
    session.events.push({ t: elapsed(), kind: 'note', text });
    input.value = '';
    renderLog();
  }

  function undo() {
    if (!session || session.ended) return;
    for (let i = session.events.length - 1; i >= 0; i--) {
      if (BEHAVIOUR_KINDS.has(session.events[i].kind)) {
        session.events.splice(i, 1);
        break;
      }
    }
    renderLog();
    renderButtons();
  }

  /* ───────── live display ───────── */
  function tick() {
    if (!session || session.ended) return;
    const t = elapsed();
    const lim = limitSec();
    if (t >= lim) { endSession(lim); return; }

    const I = session.config.intervalSec;
    const idx = Math.floor(t / I);
    if (idx > session.lastInterval) {
      session.lastInterval = idx;
      intervalCue();
    }
    $('elapsed').textContent = L.fmtTime(t, true);
    $('remaining').textContent = isFinite(lim) ? L.fmtTime(lim - t, false) : '–';
    $('intervalNum').textContent = idx + 1;
    $('intervalBar').style.width = ((t % I) / I) * 100 + '%';
    $('pauseBtn').textContent = session.running ? 'Pause' : 'Resume';
    const st = $('status');
    st.textContent = session.running ? 'Recording' : 'Paused · Space resumes';
    st.className = 'status ' + (session.running ? 'running' : 'paused');
    renderButtons();
  }

  function buildButtons() {
    const wrap = $('behButtons');
    wrap.innerHTML = '';
    for (const b of session.behaviors) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'beh-btn';
      btn.dataset.id = b.id;
      btn.innerHTML = '<span class="k"></span><span class="n"></span><span class="c"></span>';
      btn.querySelector('.k').textContent = `[${b.key.toUpperCase()}] ${b.type}`;
      btn.querySelector('.n').textContent = b.name;
      btn.addEventListener('click', () => record(b));
      wrap.appendChild(btn);
    }
  }

  function renderButtons() {
    if (!session) return;
    const t = elapsed();
    const active = L.activeBouts(session.events);
    const bouts = L.buildBouts(session.events, t);
    for (const b of session.behaviors) {
      const btn = document.querySelector(`.beh-btn[data-id="${b.id}"]`);
      if (!btn) continue;
      btn.disabled = !session.running;
      let text;
      if (b.type === 'event') {
        text = 'Count: ' + session.events.filter((e) => e.kind === 'event' && e.behaviorId === b.id).length;
        btn.classList.remove('on');
      } else {
        const list = bouts[b.id] || [];
        const total = list.reduce((a, [s, e]) => a + (e - s), 0);
        const on = b.id in active;
        btn.classList.toggle('on', on);
        text = on
          ? `ON ${L.fmtTime(t - active[b.id], false)} · total ${L.fmtTime(total, false)}`
          : `Off · ${list.length} bout${list.length === 1 ? '' : 's'} · ${L.fmtTime(total, false)}`;
      }
      btn.querySelector('.c').textContent = text;
    }
  }

  function describe(ev) {
    const b = ev.behaviorId && session.behaviors.find((x) => x.id === ev.behaviorId);
    switch (ev.kind) {
      case 'event': return b.name;
      case 'start': return `${b.name} started`;
      case 'stop': return `${b.name} stopped`;
      case 'note': return `Note: ${ev.text}`;
      case 'pause': return 'Paused';
      case 'resume': return 'Resumed';
      default: return ev.kind;
    }
  }

  function renderLog() {
    const ol = $('log');
    ol.innerHTML = '';
    const recent = session.events.slice(-200).reverse();
    for (const ev of recent) {
      const li = document.createElement('li');
      const ts = document.createElement('span');
      ts.className = 't';
      ts.textContent = L.fmtTime(ev.t, true);
      const d = document.createElement('span');
      d.textContent = describe(ev);
      li.append(ts, d);
      ol.appendChild(li);
    }
    if (!recent.length) ol.innerHTML = '<li><span class="t"></span><span>Nothing recorded yet.</span></li>';
  }

  /* ───────── cues ───────── */
  function initAudio() {
    if (!session.config.cue || audioCtx) return;
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audioCtx = null; }
  }

  function intervalCue() {
    const panel = $('run');
    panel.classList.remove('flash');
    void panel.offsetWidth; // restart animation
    panel.classList.add('flash');
    if (!session.config.cue) return;
    if (navigator.vibrate) { try { navigator.vibrate(120); } catch (e) { /* ignore */ } }
    if (!audioCtx) return;
    try {
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.3, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.2);
    } catch (e) { /* ignore */ }
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { wakeLock = null; }
  }
  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ }
    wakeLock = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session && session.running) requestWakeLock();
  });

  /* ───────── results ───────── */
  function metaLine() {
    const c = session.config;
    const parts = [];
    if (c.participant) parts.push(`Participant ${c.participant}`);
    if (c.observer) parts.push(`Observer ${c.observer}`);
    parts.push(session.startedAt.toLocaleString());
    parts.push(`${METHOD_LABEL[c.method]}, ${c.intervalSec}s intervals`);
    if (session.ended) parts.push(`Observed ${L.fmtTime(session.endT, true)}`);
    return parts.join(' · ');
  }

  function computeResults() {
    const c = session.config;
    const intervals = L.scoreIntervals(session.behaviors, session.events, session.endT, c.intervalSec, c.method);
    const summary = L.summarize(session.behaviors, session.events, session.endT, intervals);
    return { intervals, summary };
  }

  const num = (v, d = 1) => (v == null ? '' : v.toFixed(d));
  const dur = (v) => (v == null ? '' : L.fmtTime(v, true));

  function renderResults() {
    const { intervals, summary } = computeResults();
    $('summaryMeta').textContent = metaLine();
    $('status').textContent = 'Finished';
    $('status').className = 'status';

    const st = $('summary');
    st.innerHTML = '';
    const head = ['Behaviour', 'Type', 'Count', 'Rate/min', 'Total time', 'Mean bout', '% of session', 'Intervals', '% intervals'];
    st.appendChild(row('th', head));
    for (const s of summary) {
      st.appendChild(row('td', [
        s.name, s.type, s.count, num(s.ratePerMin, 2), dur(s.totalDuration), dur(s.meanDuration),
        s.pctSession == null ? '' : num(s.pctSession) + '%',
        s.intervalsScored == null ? 'n/a' : `${s.intervalsScored}/${s.intervalsTotal}`,
        s.pctIntervals == null ? '' : num(s.pctIntervals) + '%',
      ], 2));
    }

    const it = $('intervals');
    it.innerHTML = '';
    it.appendChild(row('th', ['#', 'Start', 'End', ...session.behaviors.map((b) => b.name)]));
    for (const iv of intervals) {
      const tr = row('td', [iv.index + (iv.complete ? '' : '*'), L.fmtTime(iv.start, true), L.fmtTime(iv.end, true)]);
      if (!iv.complete) { tr.classList.add('partial'); tr.title = 'Incomplete final interval, left out of interval percentages'; }
      for (const b of session.behaviors) {
        const v = iv.scores[b.id];
        const td = document.createElement('td');
        td.textContent = v == null ? '–' : v ? '✓' : '·';
        td.className = v == null ? 'na' : v ? 'yes' : '';
        tr.appendChild(td);
      }
      it.appendChild(tr);
    }
    if (!intervals.length) it.appendChild(row('td', ['No time observed.']));

    renderCharts(summary);
  }

  /* ───────── charts (plain SVG, no libraries) ───────── */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, parent) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }
  const pct = (v) => v.toFixed(1) + '%';

  function renderCharts(summary) {
    const wrap = $('charts');
    wrap.innerHTML = '';
    const durations = summary.filter((s) => s.type === 'duration');
    const counts = summary.filter((s) => s.type === 'event');
    $('chartsWrap').hidden = !(session.endT > 0) || (!durations.length && !counts.length);
    if ($('chartsWrap').hidden) return;

    if (durations.length) {
      const card = document.createElement('div');
      card.className = 'chart-card';
      card.innerHTML = '<h3>Time on vs off</h3><div class="legend"><span><i class="sw on"></i>On</span><span><i class="sw off"></i>Off</span></div>';
      const grid = document.createElement('div');
      grid.className = 'pies';
      for (const s of durations) grid.appendChild(pieChart(s));
      card.appendChild(grid);
      wrap.appendChild(card);
    }
    if (counts.length) {
      const card = document.createElement('div');
      card.className = 'chart-card';
      card.innerHTML = '<h3>Event frequency</h3>';
      card.appendChild(barChart(counts));
      wrap.appendChild(card);
    }
  }

  function pieChart(s) {
    const onSec = s.totalDuration || 0;
    const offSec = Math.max(0, session.endT - onSec);
    const frac = session.endT > 0 ? Math.min(1, onSec / session.endT) : 0;
    const onPct = frac * 100, offPct = 100 - onPct;
    const tipOn = `${s.name}: on ${pct(onPct)} (${L.fmtTime(onSec, true)}, ${s.count} bout${s.count === 1 ? '' : 's'})`;
    const tipOff = `${s.name}: off ${pct(offPct)} (${L.fmtTime(offSec, true)})`;

    const fig = document.createElement('figure');
    fig.className = 'pie';
    const size = 132, r = 60, c = size / 2;
    const svg = svgEl('svg', {
      viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img',
      'aria-label': `${s.name}: on ${pct(onPct)}, off ${pct(offPct)} of the session`,
    }, fig);

    if (frac <= 0 || frac >= 1) {
      svgEl('circle', { cx: c, cy: c, r, class: frac >= 1 ? 'slice-on' : 'slice-off', 'data-tip': frac >= 1 ? tipOn : tipOff }, svg);
    } else {
      // "On" slice runs clockwise from 12 o'clock; "off" fills the rest.
      const a = frac * 2 * Math.PI;
      const x = c + r * Math.sin(a), y = c - r * Math.cos(a);
      const large = frac > 0.5 ? 1 : 0;
      svgEl('path', { d: `M${c},${c} L${c},${c - r} A${r},${r} 0 ${large} 1 ${x},${y} Z`, class: 'slice-on', 'data-tip': tipOn }, svg);
      svgEl('path', { d: `M${c},${c} L${x},${y} A${r},${r} 0 ${1 - large} 1 ${c},${c - r} Z`, class: 'slice-off', 'data-tip': tipOff }, svg);
    }

    const cap = document.createElement('figcaption');
    cap.innerHTML = '<b></b><span class="v"></span><span class="sub"></span>';
    cap.querySelector('b').textContent = s.name;
    cap.querySelector('.v').textContent = `${pct(onPct)} on`;
    cap.querySelector('.sub').textContent = `${L.fmtTime(onSec, false)} of ${L.fmtTime(session.endT, false)}`;
    fig.appendChild(cap);
    return fig;
  }

  function niceStep(max) {
    if (max <= 5) return 1;
    const raw = max / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  }

  function barChart(items) {
    const maxCount = Math.max(...items.map((s) => s.count));
    const step = niceStep(Math.max(maxCount, 1));
    const top = Math.max(step, Math.ceil(maxCount / step) * step);
    const slot = 100, barW = 48, padL = 40, padR = 12, padT = 22, plotH = 170, padB = 42;
    const W = padL + padR + slot * items.length, H = padT + plotH + padB;
    const y = (v) => padT + plotH - (v / top) * plotH;

    const box = document.createElement('div');
    box.className = 'bar-wrap';
    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
      'aria-label': 'Event frequency: ' + items.map((s) => `${s.name} ${s.count}`).join(', '),
    }, box);

    for (let v = 0; v <= top + 1e-9; v += step) {
      svgEl('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }, svg);
      const t = svgEl('text', { x: padL - 8, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, svg);
      t.textContent = v;
    }

    items.forEach((s, i) => {
      const cx = padL + slot * i + slot / 2;
      const x0 = cx - barW / 2;
      const yTop = y(s.count), yBase = y(0);
      const tip = `${s.name}: ${s.count} (${s.ratePerMin.toFixed(2)}/min)`;
      // Generous invisible hit target for the tooltip.
      svgEl('rect', { x: cx - slot / 2 + 2, y: padT, width: slot - 4, height: plotH, class: 'hit', 'data-tip': tip }, svg);
      if (s.count > 0) {
        const h = yBase - yTop, rr = Math.min(4, h, barW / 2);
        svgEl('path', {
          d: `M${x0},${yBase} V${yTop + rr} Q${x0},${yTop} ${x0 + rr},${yTop} H${x0 + barW - rr} Q${x0 + barW},${yTop} ${x0 + barW},${yTop + rr} V${yBase} Z`,
          class: 'bar',
        }, svg);
      }
      const val = svgEl('text', { x: cx, y: yTop - 6, class: 'val', 'text-anchor': 'middle' }, svg);
      val.textContent = s.count;
      const lab = svgEl('text', { x: cx, y: yBase + 18, class: 'lab', 'text-anchor': 'middle' }, svg);
      lab.textContent = s.name.length > 14 ? s.name.slice(0, 13) + '…' : s.name;
      const key = svgEl('text', { x: cx, y: yBase + 34, class: 'tick', 'text-anchor': 'middle' }, svg);
      key.textContent = `[${s.key.toUpperCase()}]`;
    });
    return box;
  }

  // One shared tooltip for every chart mark carrying data-tip.
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  document.body.appendChild(tip);
  function showTip(e) {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.getAttribute('data-tip');
    tip.hidden = false;
    const pad = 12, w = tip.offsetWidth, h = tip.offsetHeight;
    let left = e.clientX + pad, topY = e.clientY - h - pad;
    if (left + w > window.innerWidth - 8) left = e.clientX - w - pad;
    if (topY < 8) topY = e.clientY + pad;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = topY + 'px';
  }
  $('charts').addEventListener('pointermove', showTip);
  $('charts').addEventListener('pointerdown', showTip);
  $('charts').addEventListener('pointerleave', () => { tip.hidden = true; });
  window.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });

  function row(tag, cells, numericFrom = Infinity) {
    const tr = document.createElement('tr');
    cells.forEach((v, i) => {
      const el = document.createElement(tag);
      el.textContent = v;
      if (tag === 'td' && i >= numericFrom) el.className = 'num';
      tr.appendChild(el);
    });
    return tr;
  }

  /* ───────── CSV export ───────── */
  function baseName(kind) {
    const c = session.config;
    const d = session.startedAt;
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const who = (c.participant || 'session').replace(/[^\w.-]+/g, '_');
    return `${who}_${stamp}_${kind}.csv`;
  }

  function download(name, text) {
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    session.exported = true;
  }

  function exportEvents() {
    const c = session.config;
    const rows = [['participant', 'observer', 'session_start', 'time_s', 'time', 'interval', 'behaviour', 'key', 'type', 'action', 'note']];
    for (const ev of session.events) {
      const b = ev.behaviorId ? session.behaviors.find((x) => x.id === ev.behaviorId) : null;
      rows.push([
        c.participant, c.observer, session.startedAt.toISOString(),
        ev.t.toFixed(2), L.fmtTime(ev.t, true), Math.floor(ev.t / c.intervalSec) + 1,
        b ? b.name : '', b ? b.key : '', b ? b.type : '', ev.kind, ev.text || '',
      ]);
    }
    rows.push([c.participant, c.observer, session.startedAt.toISOString(),
      session.endT.toFixed(2), L.fmtTime(session.endT, true), '', '', '', '', 'end', '']);
    download(baseName('events'), L.toCSV(rows));
  }

  function exportIntervals() {
    const { intervals } = computeResults();
    const rows = [['interval', 'start_s', 'end_s', 'complete', ...session.behaviors.map((b) => b.name)]];
    for (const iv of intervals) {
      rows.push([iv.index, iv.start.toFixed(2), iv.end.toFixed(2), iv.complete ? 1 : 0,
        ...session.behaviors.map((b) => (iv.scores[b.id] == null ? '' : iv.scores[b.id] ? 1 : 0))]);
    }
    download(baseName('intervals'), L.toCSV(rows));
  }

  function exportSummary() {
    const c = session.config;
    const { summary } = computeResults();
    const rows = [['participant', 'observer', 'session_start', 'session_s', 'method', 'interval_s',
      'behaviour', 'key', 'type', 'count', 'rate_per_min', 'total_duration_s', 'mean_duration_s',
      'pct_session', 'intervals_scored', 'intervals_total', 'pct_intervals']];
    for (const s of summary) {
      rows.push([c.participant, c.observer, session.startedAt.toISOString(), session.endT.toFixed(2),
        c.method, c.intervalSec, s.name, s.key, s.type, s.count, num(s.ratePerMin, 3),
        num(s.totalDuration, 2), num(s.meanDuration, 2), num(s.pctSession, 2),
        s.intervalsScored == null ? '' : s.intervalsScored, s.intervalsTotal, num(s.pctIntervals, 2)]);
    }
    download(baseName('summary'), L.toCSV(rows));
  }

  /* ───────── wiring ───────── */
  function show(which) {
    for (const id of ['setup', 'run', 'results']) $(id).hidden = id !== which;
    if (which === 'setup') { $('status').textContent = 'Setup'; $('status').className = 'status'; }
  }

  $('addBeh').addEventListener('click', () => {
    const tr = behaviourRow({ name: '', key: '', type: 'event' });
    $('behRows').appendChild(tr);
    tr.querySelector('input').focus();
  });
  $('startBtn').addEventListener('click', startSession);
  $('pauseBtn').addEventListener('click', togglePause);
  $('undoBtn').addEventListener('click', undo);
  $('stopBtn').addEventListener('click', () => { if (confirm('End this session now?')) endSession(); });
  $('noteBtn').addEventListener('click', addNote);
  $('noteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addNote(); } });
  $('newBtn').addEventListener('click', newSession);
  $('csvEvents').addEventListener('click', exportEvents);
  $('csvIntervals').addEventListener('click', exportIntervals);
  $('csvSummary').addEventListener('click', exportSummary);

  document.addEventListener('keydown', (e) => {
    if (!session || session.ended || $('run').hidden) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); togglePause(); return; }
    if (e.repeat) return;
    const b = session.byKey[e.key.toLowerCase()];
    if (b) { e.preventDefault(); record(b); }
  });

  window.addEventListener('beforeunload', (e) => {
    if (session && (!session.ended || !session.exported)) { e.preventDefault(); e.returnValue = ''; }
  });

  renderSetup();
})();
