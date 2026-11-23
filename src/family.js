// ════════════════════════════════════════════════════════════
//  FAMILY — family logic, log, routine learning
// ════════════════════════════════════════════════════════════
import { S, PS, CS } from './state.js';

// ════════════════════════════════════════════════════════════
//  FAMILY LOGIC — real-time log updates
// ════════════════════════════════════════════════════════════

// Shared helper: for a family user, expand the base S.rooms list to include
// all rooms that belong to each linked patient (calls go to patient↔carer
// rooms, not patient↔family rooms).
export async function _expandFamilyRooms() {
  const expanded = [...S.rooms];
  for (const roomId of S.rooms) {
    const snap = await db.ref(`carecall/rooms/${roomId}/members`).once('value');
    const members = snap.val() || {};
    for (const [uid, m] of Object.entries(members)) {
      if (uid !== S.uid && m.role === 'patient') {
        const patientSnap = await db.ref(`carecall/users/${uid}/rooms`).once('value');
        const patientRooms = patientSnap.val() || [];
        patientRooms.forEach(r => { if (!expanded.includes(r)) expanded.push(r); });
      }
    }
  }
  return expanded;
}

export let _familyListenerRefs = [];
export let _familyRefreshTimer = null;
export async function _startFamilyListeners() {
  // Clean up old listeners
  _familyListenerRefs.forEach(ref => ref.off());
  _familyListenerRefs = [];

  // Debounced refresh — avoids hammering Firebase when multiple events fire
  function _debouncedRefresh() {
    clearTimeout(_familyRefreshTimer);
    _familyRefreshTimer = setTimeout(() => refreshLog(), 500);
  }

  // Expand to include the patient's other rooms (where calls actually go)
  let roomsToListen;
  try { roomsToListen = await _expandFamilyRooms(); } catch(e) { roomsToListen = [...S.rooms]; }

  // Listen to calls in all relevant rooms
  roomsToListen.forEach(roomId => {
    const ref = db.ref(`carecall/rooms/${roomId}/calls`).orderByChild('timestamp').limitToLast(50);
    ref.on('child_added', _debouncedRefresh);
    ref.on('child_changed', _debouncedRefresh);
    _familyListenerRefs.push(ref);
  });
}


// ════════════════════════════════════════════════════════════
//  LOG
// ════════════════════════════════════════════════════════════
export let _allLogCalls = [];  // cached for filtering + export
export let _logFilter = 'all'; // current filter
export let _logLastFetched = 0;
export const LOG_CACHE_MS = 30000;

export async function refreshLog(forceRefresh) {
  const content = document.getElementById('log-content');
  const dashboard = document.getElementById('log-dashboard');
  if (!db || !S.rooms.length) {
    content.innerHTML = '<div class="log-empty">' + t('No connections yet — add a patient or carer in Settings') + '</div>';
    if (dashboard) dashboard.style.display = 'none';
    return;
  }
  // Return cached data if fresh enough (unless force-refresh requested)
  if (!forceRefresh && _allLogCalls.length && (Date.now() - _logLastFetched) < LOG_CACHE_MS) {
    renderLogEntries();
    return;
  }
  content.innerHTML = '<div class="log-empty">' + t('Loading…') + '</div>';

  // For family role: also fetch calls from the patient's OTHER rooms
  // (calls go to patient↔carer rooms, not patient↔family rooms)
  let roomsToQuery = [...S.rooms];
  if (S.role === 'family') {
    try { roomsToQuery = await _expandFamilyRooms(); }
    catch(e) { console.warn('[Log] Family room expansion failed:', e.message); }
  }

  // Fetch calls from ALL relevant rooms
  const allCalls = [];
  const fetches = roomsToQuery.map(roomCode =>
    db.ref(`carecall/rooms/${roomCode}/calls`)
      .orderByChild('timestamp')
      .limitToLast(100)
      .once('value')
      .then(snap => {
        snap.forEach(c => {
          const call = c.val();
          call._room = roomCode;
          allCalls.push(call);
        });
      })
  );
  await Promise.all(fetches);

  // Merge handoff notes into the timeline
  const handoffNotes = await _fetchHandoffNotes(roomsToQuery);
  handoffNotes.forEach(n => { n.timestamp = n.at; allCalls.push(n); });

  allCalls.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  _allLogCalls = allCalls;
  _logLastFetched = Date.now();

  // Build filter buttons from unique names
  buildLogFilters(allCalls);
  renderLogEntries();
}

export function buildLogFilters(calls) {
  const bar = document.getElementById('log-filters');
  bar.innerHTML = '';
  const names = new Set();
  calls.forEach(c => {
    if (c.fromName) names.add(c.fromName);
    if (c.from && c._type === 'handoff') names.add(c.from);
    if (c.ackName) names.add(c.ackName);
  });

  const mkBtn = (label, value) => {
    const btn = document.createElement('button');
    btn.className = `log-filter-btn${_logFilter === value ? ' selected' : ''}`;
    btn.dataset.filter = value;
    btn.textContent = label;
    btn.onclick = () => setLogFilter(value, btn);
    bar.appendChild(btn);
  };

  mkBtn('All', 'all');
  mkBtn('📋 Notes', 'handoff');
  names.forEach(name => mkBtn(name, name));
}

export function setLogFilter(value) {
  _logFilter = value;
  document.querySelectorAll('.log-filter-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.filter === value);
  });
  renderLogEntries();
}

export function renderLogEntries() {
  const content = document.getElementById('log-content');
  const dashboard = document.getElementById('log-dashboard');
  let calls = _allLogCalls;
  if (_logFilter === 'handoff') {
    calls = calls.filter(c => c._type === 'handoff');
  } else if (_logFilter !== 'all') {
    calls = calls.filter(c => c.fromName === _logFilter || c.ackName === _logFilter || c.from === _logFilter);
  }
  if (!calls.length) {
    content.innerHTML = '<div class="log-empty">📞 No calls yet<br><span style="font-size:0.8rem;opacity:0.6">Your call history will appear here</span></div>';
    dashboard.style.display = 'none';
    return;
  }

  // ── Analytics dashboard ──
  dashboard.style.display = '';
  const acked = calls.filter(c => c.status === 'acknowledged' && c.ackAt && c.timestamp);
  const responseTimes = acked.map(c => c.ackAt - c.timestamp).filter(t => t > 0);
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayCalls = calls.filter(c => c.timestamp >= todayStart.getTime());

  document.getElementById('dash-total').textContent = calls.length;
  document.getElementById('dash-responded').textContent = acked.length;
  document.getElementById('dash-today').textContent = todayCalls.length;

  if (responseTimes.length) {
    const avg = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
    const fastest = Math.min(...responseTimes);
    const slowest = Math.max(...responseTimes);
    document.getElementById('dash-avg-response').textContent = formatDuration(avg);
    document.getElementById('dash-fastest').textContent = formatDuration(fastest);
    document.getElementById('dash-slowest').textContent = formatDuration(slowest);
  } else {
    document.getElementById('dash-avg-response').textContent = '—';
    document.getElementById('dash-fastest').textContent = '—';
    document.getElementById('dash-slowest').textContent = '—';
  }

  // Most common needs
  const needCounts = {};
  calls.forEach(c => {
    const types = (c.type || 'help').split(',');
    types.forEach(t => { needCounts[t] = (needCounts[t] || 0) + 1; });
  });
  const sortedNeeds = Object.entries(needCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const needsEl = document.getElementById('dash-needs');
  needsEl.innerHTML = sortedNeeds.map(([t, n]) =>
    `<span class="dash-need-chip">${needLabel(t).split(' ')[0]} ${needLabel(t).split(' ').slice(1).join(' ')} (${n})</span>`
  ).join('');

  // ── AI Insights: rule-based pattern detection ──
  _renderWellnessScore(calls);
  _renderInsights(calls);

  content.innerHTML = '';
  const multiRoom = S.rooms.length > 1;
  calls.forEach(call => {
    const ts = call.timestamp ? new Date(call.timestamp).toLocaleString() : '';
    const entry = document.createElement('div');

    // Handoff notes have a distinct visual style
    if (call._type === 'handoff') {
      const priorityColors = { urgent: 'var(--danger)', important: 'var(--warning)', normal: 'var(--carer-primary)' };
      const priorityIcons = { urgent: '🚨', important: '⚠️', normal: '📋' };
      const color = priorityColors[call.priority] || priorityColors.normal;
      const icon = priorityIcons[call.priority] || '📋';
      // v2: render status chips if present
      let statusTagsHtml = '';
      if (call.status && typeof call.status === 'object') {
        const tags = Object.keys(call.status).map(dim => {
          const dimDef = HANDOFF_STATUS_DIMENSIONS.find(d => d.key === dim);
          if (!dimDef) return '';
          const opt = dimDef.options.find(o => o.v === call.status[dim]);
          if (!opt) return '';
          const cls = opt.cls.replace('ho-', '');
          return `<span class="ho-tag ${cls}">${escHtml(opt.label)}</span>`;
        }).filter(Boolean);
        if (tags.length) statusTagsHtml = `<div class="ho-tags">${tags.join('')}</div>`;
      }
      // v2: show who acked (read-receipt) — list other carers who tapped "Got it".
      let acksHtml = '';
      if (call.acks && typeof call.acks === 'object') {
        const names = Object.values(call.acks)
          .filter(a => a && a.byUid !== call.fromUid)
          .map(a => escHtml(a.by || ''))
          .filter(Boolean);
        if (names.length) {
          acksHtml = `<div class="log-ack" style="color:var(--success)">👍 ${t('Read by')}: ${names.join(', ')}</div>`;
        }
      }
      entry.className = 'log-entry';
      entry.style.borderLeft = `3px solid ${color}`;
      entry.innerHTML = `
        <div class="log-icon-col" style="background:rgba(14,165,233,0.1)">${icon}</div>
        <div class="log-body">
          <div class="log-who">${call.avatar ? escHtml(call.avatar) + ' ' : ''}${escHtml(call.from)} <span style="font-size:0.7rem;color:#6889A5;font-weight:400">· ${t('Shift Note')}</span></div>
          ${call.text ? `<div class="log-msg" style="color:#F1F5F9;font-style:normal;font-size:0.85rem">"${escHtml(call.text)}"</div>` : ''}
          ${statusTagsHtml}
          <div class="log-meta">📅 ${ts}</div>
          ${acksHtml}
        </div>`;
    } else {
      // Regular call entry
      const responseMs = call.ackAt && call.timestamp ? call.ackAt - call.timestamp : null;
      const responseTxt = responseMs ? formatDuration(responseMs) : null;
      entry.className = 'log-entry';
      entry.innerHTML = `
        <div class="log-icon-col ${call.status==='acknowledged'?'acked':'active'}">${needLabel(call.type).split(' ')[0]}</div>
        <div class="log-body">
          <div class="log-who">${call.avatar ? escHtml(call.avatar) + ' ' : ''}${escHtml(call.fromName)}${multiRoom ? `<span class="log-room-tag">${escHtml(call._room)}</span>` : ''}</div>
          <div class="log-type">${needLabel(call.type)}</div>
          ${call.message ? `<div class="log-msg">"${escHtml(call.message)}"</div>` : ''}
          <div class="log-meta">📅 ${ts}</div>
          ${call.status==='acknowledged'
            ? `<div class="log-ack">✅ ${escHtml(call.ackName||'')} responded${responseTxt ? ` in ${responseTxt}` : ''}</div>`
            : `<div class="log-unacked">⏳ No response recorded</div>`}
          ${call.careNote ? `<div class="log-msg" style="color:var(--carer-primary)">📝 ${escHtml(call.careNote.text)} — ${escHtml(call.careNote.by)}</div>` : ''}
          ${call.location ? `<div class="log-meta"><a href="https://maps.google.com/maps?q=${call.location.lat},${call.location.lng}" target="_blank" style="color:var(--carer-primary);text-decoration:none">📍 View location</a></div>` : ''}
        </div>`;
    }
    content.appendChild(entry);
  });

  // Fire-and-forget: fetch med events and render the trendline + missed
  // charts. Separate path from _allLogCalls because those are room call
  // records; medication events live at carecall/rooms/{room}/medications.
  _renderMedChartsInLog();
}

// Renders the 30-day adherence trendline + most-missed-med bar chart
// in the log dashboard. Runs for all roles; scopes data by role:
//   - patient: only their own events
//   - family / carer: all medication events in their rooms
export async function _renderMedChartsInLog() {
  const row = document.getElementById('med-charts-row');
  const missedRow = document.getElementById('med-missed-row');
  if (!row || !missedRow) return;
  const rooms = (S && S.rooms) || [];
  if (!rooms.length) { row.style.display = 'none'; missedRow.style.display = 'none'; return; }

  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const events = [];
  await Promise.all(rooms.map(async r => {
    try {
      const snap = await db.ref(`carecall/rooms/${r}/medications`)
        .orderByChild('timestamp').startAt(since).once('value');
      snap.forEach(c => { const v = c.val(); if (v) events.push(v); });
    } catch(e) { /* ignore */ }
  }));

  const filtered = (S.role === 'patient')
    ? events.filter(e => e.uid === S.uid)
    : events;

  if (!filtered.length) { row.style.display = 'none'; missedRow.style.display = 'none'; return; }

  const dayBuckets = {};
  const missedByMed = {};
  filtered.forEach(e => {
    const d = new Date(e.timestamp || Date.now());
    const key = d.toISOString().slice(0, 10);
    if (!dayBuckets[key]) dayBuckets[key] = { taken: 0, scheduled: 0 };
    const status = (e.status || '').toLowerCase();
    if (status === 'taken') dayBuckets[key].taken++;
    if (status === 'taken' || status === 'missed') dayBuckets[key].scheduled++;
    if (status === 'missed') {
      const name = _medLabelForEvent(e);
      missedByMed[name] = (missedByMed[name] || 0) + 1;
    }
  });

  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const b = dayBuckets[key];
    const pct = b && b.scheduled > 0 ? (b.taken / b.scheduled) * 100 : null;
    days.push({ date: key, pct });
  }

  _renderAdherenceSvg(days);
  _renderMostMissed(missedByMed);
  row.style.display = '';
  missedRow.style.display = Object.keys(missedByMed).length ? '' : 'none';
}

export function _medLabelForEvent(e) {
  const n = e.medName || '—';
  if (e.dose != null) return n + ' ' + e.dose + (e.unit || '');
  return n;
}

export function _renderAdherenceSvg(days) {
  const svg = document.getElementById('adherence-trend');
  if (!svg) return;
  const W = 300, H = 80, padY = 8;
  const n = days.length;
  const xFor = i => (i / (n - 1)) * W;
  const yFor = pct => H - padY - (pct / 100) * (H - 2 * padY);

  const pts = days.map((d, i) => d.pct === null ? null : [xFor(i), yFor(d.pct)]);
  let pathD = '';
  pts.forEach((p, i) => {
    if (!p) return;
    pathD += (i === 0 || !pts[i - 1]) ? `M${p[0]},${p[1]}` : ` L${p[0]},${p[1]}`;
  });

  const defined = days.filter(d => d.pct !== null);
  const overall = defined.length
    ? Math.round(defined.reduce((s, d) => s + d.pct, 0) / defined.length)
    : null;

  const lastDefinedIdx = pts.map((p, i) => p ? i : -1).filter(i => i >= 0).pop();
  const firstDefinedIdx = pts.findIndex(p => p);
  const fillPath = (pathD && firstDefinedIdx >= 0 && lastDefinedIdx >= 0)
    ? pathD + ` L${xFor(lastDefinedIdx)},${H} L${xFor(firstDefinedIdx)},${H} Z`
    : '';

  svg.innerHTML = `
    <defs>
      <linearGradient id="adhFill" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="#0EA5E9" stop-opacity="0.45"/>
        <stop offset="1" stop-color="#0EA5E9" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line x1="0" y1="${yFor(80)}" x2="${W}" y2="${yFor(80)}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="2,3"/>
    <line x1="0" y1="${yFor(50)}" x2="${W}" y2="${yFor(50)}" stroke="rgba(255,255,255,0.05)" stroke-dasharray="2,3"/>
    ${fillPath ? `<path d="${fillPath}" fill="url(#adhFill)"/>` : ''}
    ${pathD ? `<path d="${pathD}" fill="none" stroke="#0EA5E9" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
  `;

  const summary = document.getElementById('adherence-summary');
  if (summary) {
    summary.textContent = overall === null
      ? t('No medication data yet.')
      : t('30-day average') + ': ' + overall + '%';
  }
}

export function _renderMostMissed(missedByMed) {
  const el = document.getElementById('most-missed-list');
  if (!el) return;
  const arr = Object.entries(missedByMed).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!arr.length) {
    el.innerHTML = `<div style="font-size:0.78rem;color:#6889A5;padding:4px 0">${t('No missed doses in the last 30 days 🎉')}</div>`;
    return;
  }
  const max = arr[0][1];
  el.innerHTML = arr.map(([name, cnt]) => {
    const pct = Math.max(10, (cnt / max) * 100);
    return `
      <div class="mm-row">
        <div class="mm-label" title="${escHtml(name)}">${escHtml(name)}</div>
        <div class="mm-bar-wrap"><div class="mm-bar" style="width:${pct}%"></div></div>
        <div class="mm-count">${cnt}</div>
      </div>`;
  }).join('');
}

export function _renderWellnessScore(calls) {
  const card = document.getElementById('wellness-card');
  if (!card || calls.length < 3) { if (card) card.style.display = 'none'; return; }
  card.style.display = 'flex';

  const now = Date.now();
  const WEEK = 7 * 86400000;
  const thisWeek = calls.filter(c => c.timestamp >= now - WEEK);
  const lastWeek = calls.filter(c => c.timestamp >= now - 2*WEEK && c.timestamp < now - WEEK);

  let score = 10;
  const factors = [];

  // 1. Call frequency trend (0-2 points deduction)
  if (thisWeek.length && lastWeek.length) {
    const change = (thisWeek.length - lastWeek.length) / lastWeek.length;
    if (change > 0.5) { score -= 2; factors.push({ text: 'Calls up ' + Math.round(change*100) + '%', level: 'bad' }); }
    else if (change > 0.2) { score -= 1; factors.push({ text: 'Calls rising', level: 'warn' }); }
    else if (change < -0.2) { factors.push({ text: 'Calls decreasing', level: 'good' }); }
  }

  // 2. Response rate (0-2 points deduction)
  if (thisWeek.length >= 3) {
    const unresponded = thisWeek.filter(c => c.status !== 'acknowledged').length;
    const rate = unresponded / thisWeek.length;
    if (rate > 0.3) { score -= 2; factors.push({ text: Math.round(rate*100) + '% unanswered', level: 'bad' }); }
    else if (rate > 0.1) { score -= 1; factors.push({ text: 'Some unanswered', level: 'warn' }); }
    else { factors.push({ text: 'All answered', level: 'good' }); }
  }

  // 3. Pain/fall events (0-2 points deduction)
  const painCalls = thisWeek.filter(c => (c.type||'').includes('pain'));
  const fallCalls = thisWeek.filter(c => c.type === 'fall');
  if (fallCalls.length >= 2) { score -= 2; factors.push({ text: fallCalls.length + ' falls', level: 'bad' }); }
  else if (fallCalls.length === 1) { score -= 1; factors.push({ text: '1 fall', level: 'warn' }); }
  if (painCalls.length >= 3) { score -= 1; factors.push({ text: painCalls.length + ' pain calls', level: 'bad' }); }

  // 4. Medication adherence (0-2 points deduction)
  const medMissed = thisWeek.filter(c => c.type === 'med-missed');
  const medTotal = thisWeek.filter(c => c.type === 'med-missed' || c.type === 'med-taken');
  if (medTotal.length >= 3) {
    const adherence = (medTotal.length - medMissed.length) / medTotal.length;
    if (adherence < 0.7) { score -= 2; factors.push({ text: 'Meds ' + Math.round(adherence*100) + '%', level: 'bad' }); }
    else if (adherence < 0.9) { score -= 1; factors.push({ text: 'Meds ' + Math.round(adherence*100) + '%', level: 'warn' }); }
    else { factors.push({ text: 'Meds ' + Math.round(adherence*100) + '%', level: 'good' }); }
  }

  // 5. Missed check-ins (0-1 point deduction)
  const missedCheckins = thisWeek.filter(c => c.type === 'checkin-missed');
  if (missedCheckins.length >= 3) { score -= 1; factors.push({ text: missedCheckins.length + ' missed check-ins', level: 'warn' }); }

  // 6. Night activity (0-1 point deduction)
  const nightCalls = thisWeek.filter(c => { const h = new Date(c.timestamp).getHours(); return h >= 22 || h < 6; });
  if (nightCalls.length >= 3) { score -= 1; factors.push({ text: nightCalls.length + ' night calls', level: 'warn' }); }

  score = Math.max(1, Math.min(10, score));

  // Render
  const scoreEl = document.getElementById('ws-score');
  const ringEl = document.getElementById('ws-ring-fill');
  const labelEl = document.getElementById('ws-label');
  const factorsEl = document.getElementById('ws-factors');

  scoreEl.textContent = score;
  const circumference = 264; // 2 * pi * 42
  ringEl.style.strokeDashoffset = String(circumference * (1 - score / 10));
  ringEl.style.stroke = score >= 8 ? 'var(--success)' : score >= 5 ? 'var(--warning)' : 'var(--danger)';

  const labels = ['', 'Critical', 'Very Poor', 'Poor', 'Concerning', 'Fair', 'Moderate', 'Good', 'Very Good', 'Excellent', 'Excellent'];
  labelEl.textContent = labels[score] || 'Calculating…';

  factorsEl.innerHTML = factors.map(f => `<span class="ws-factor ${f.level}">${f.text}</span>`).join('');
}

export function _renderInsights(calls) {
  const el = document.getElementById('dash-insights');
  if (!el) return;
  const insights = _generateInsights(calls);
  el.innerHTML = '';
  if (!insights.length) return;
  // Build each insight via DOM APIs so any future insight generator that
  // forgets to escape user-controlled text (e.g. a patient's display name
  // slipping into the body copy) cannot execute script. Today's generators
  // interpolate only numbers/durations/fixed labels, but that's a fragile
  // invariant — the defence-in-depth here makes the pattern safe by default.
  // The existing rich text (e.g. <strong> tags) is preserved via innerHTML
  // into a *dedicated* text span whose content is fully controlled here.
  insights.forEach(i => {
    const row = document.createElement('div');
    row.className = 'insight-item ' + (i.level || '');
    const icon = document.createElement('span');
    icon.className = 'insight-icon';
    icon.textContent = i.icon || '';
    const text = document.createElement('span');
    text.className = 'insight-text';
    // i.text is generated in-app; keep the <strong> markup by letting it
    // render as HTML here — but ALL interpolated substrings that reach
    // this point must be numeric or from a fixed vocabulary. Audit the
    // generators (_generateInsights / _generateRoutineInsights /
    // _generateCarerWellbeingInsights) before adding any user-derived
    // string to i.text.
    text.innerHTML = i.text || '';
    row.appendChild(icon);
    row.appendChild(text);
    el.appendChild(row);
  });
}

export function _generateInsights(calls) {
  const insights = [];
  if (calls.length < 2) return insights;

  const now = Date.now();
  const DAY = 86400000;
  const WEEK = 7 * DAY;

  // Split calls into time periods
  const thisWeek = calls.filter(c => c.timestamp >= now - WEEK);
  const lastWeek = calls.filter(c => c.timestamp >= now - 2*WEEK && c.timestamp < now - WEEK);
  const today = calls.filter(c => c.timestamp >= now - DAY);
  const yesterday = calls.filter(c => c.timestamp >= now - 2*DAY && c.timestamp < now - DAY);

  // ── 1. Call frequency trend ──
  if (thisWeek.length && lastWeek.length) {
    const change = ((thisWeek.length - lastWeek.length) / lastWeek.length * 100).toFixed(0);
    if (change > 30) {
      insights.push({ icon: '📈', level: 'warn', text: `Call frequency <strong>up ${change}%</strong> this week (${thisWeek.length} vs ${lastWeek.length} last week). Consider checking on the patient.` });
    } else if (change < -30) {
      insights.push({ icon: '📉', level: 'good', text: `Call frequency <strong>down ${Math.abs(change)}%</strong> this week (${thisWeek.length} vs ${lastWeek.length} last week).` });
    }
  }

  // ── 2. Response time trend ──
  const getAvgResponse = (list) => {
    const times = list.filter(c => c.ackAt && c.timestamp).map(c => c.ackAt - c.timestamp).filter(t => t > 0);
    return times.length ? times.reduce((a,b) => a+b, 0) / times.length : null;
  };
  const thisWeekAvg = getAvgResponse(thisWeek);
  const lastWeekAvg = getAvgResponse(lastWeek);
  if (thisWeekAvg && lastWeekAvg) {
    const changePct = ((thisWeekAvg - lastWeekAvg) / lastWeekAvg * 100).toFixed(0);
    if (changePct > 50) {
      insights.push({ icon: '⏱️', level: 'warn', text: `Average response time <strong>increased ${changePct}%</strong> (${formatDuration(thisWeekAvg)} vs ${formatDuration(lastWeekAvg)} last week). Carers may need support.` });
    } else if (changePct < -30) {
      insights.push({ icon: '⚡', level: 'good', text: `Response time <strong>improved ${Math.abs(changePct)}%</strong> this week (${formatDuration(thisWeekAvg)} avg).` });
    }
  }

  // ── 3. Unresponded calls ──
  const unresponded = thisWeek.filter(c => c.status !== 'acknowledged');
  if (unresponded.length >= 3) {
    insights.push({ icon: '⚠️', level: 'alert', text: `<strong>${unresponded.length} calls</strong> this week had no response. Ensure carers have notifications enabled.` });
  }

  // ── 4. New need types appearing ──
  const thisWeekTypes = new Set(); const lastWeekTypes = new Set();
  thisWeek.forEach(c => (c.type||'help').split(',').forEach(t => thisWeekTypes.add(t)));
  lastWeek.forEach(c => (c.type||'help').split(',').forEach(t => lastWeekTypes.add(t)));
  const newTypes = [...thisWeekTypes].filter(t => !lastWeekTypes.has(t) && t !== 'help');
  if (newTypes.length && lastWeek.length >= 3) {
    const labels = newTypes.map(t => needLabel(t)).join(', ');
    insights.push({ icon: '🆕', level: 'warn', text: `New need type this week: <strong>${labels}</strong>. This may indicate a change in condition.` });
  }

  // ── 5. Pain/fall frequency ──
  const painCalls = thisWeek.filter(c => (c.type||'').includes('pain'));
  if (painCalls.length >= 3) {
    insights.push({ icon: '😣', level: 'alert', text: `<strong>${painCalls.length} pain-related calls</strong> this week. Consider consulting a healthcare professional.` });
  }
  const fallCalls = thisWeek.filter(c => c.type === 'fall');
  if (fallCalls.length >= 2) {
    insights.push({ icon: '🚨', level: 'alert', text: `<strong>${fallCalls.length} falls detected</strong> this week. Fall risk assessment recommended.` });
  }

  // ── 6. Peak hours pattern ──
  if (thisWeek.length >= 5) {
    const hourBuckets = {};
    thisWeek.forEach(c => {
      if (!c.timestamp) return;
      const h = new Date(c.timestamp).getHours();
      hourBuckets[h] = (hourBuckets[h] || 0) + 1;
    });
    const peak = Object.entries(hourBuckets).sort((a,b) => b[1] - a[1])[0];
    if (peak && peak[1] >= 3) {
      const h = parseInt(peak[0]);
      const label = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h-12} PM`;
      const isNight = h >= 22 || h < 6;
      if (isNight) {
        insights.push({ icon: '🌙', level: 'warn', text: `<strong>${peak[1]} calls around ${label}</strong> — nighttime calls may indicate sleep disturbance or discomfort.` });
      } else {
        insights.push({ icon: '📊', level: '', text: `Peak call time: <strong>${label}</strong> (${peak[1]} calls this week).` });
      }
    }
  }

  // ── 7. Medication adherence ──
  const medMissed = thisWeek.filter(c => c.type === 'med-missed');
  const medTotal = thisWeek.filter(c => c.type === 'med-missed' || c.type === 'med-taken');
  if (medTotal.length >= 3) {
    const adherence = ((medTotal.length - medMissed.length) / medTotal.length * 100).toFixed(0);
    if (adherence < 80) {
      insights.push({ icon: '💊', level: 'alert', text: `Medication adherence is <strong>${adherence}%</strong> this week (${medMissed.length} missed). Consider reminding the patient or adjusting the schedule.` });
    } else if (adherence >= 95) {
      insights.push({ icon: '💊', level: 'good', text: `Excellent medication adherence: <strong>${adherence}%</strong> this week.` });
    }
  }

  // ── 8. Check-in misses ──
  const checkinMissed = thisWeek.filter(c => c.type === 'checkin-missed');
  if (checkinMissed.length >= 2) {
    insights.push({ icon: '👋', level: 'warn', text: `<strong>${checkinMissed.length} missed check-ins</strong> this week. Patient may not be responding to prompts.` });
  }

  // ── 9. Activity today vs usual ──
  if (today.length && thisWeek.length >= 7) {
    const dailyAvg = thisWeek.length / 7;
    if (today.length > dailyAvg * 2 && today.length >= 3) {
      insights.push({ icon: '🔥', level: 'warn', text: `<strong>${today.length} calls today</strong> — more than double the daily average (${dailyAvg.toFixed(1)}). Check on the patient.` });
    }
  }

  // ── 10. Positive: good week ──
  if (thisWeek.length && !insights.some(i => i.level === 'alert' || i.level === 'warn')) {
    const responseRate = thisWeek.filter(c => c.status === 'acknowledged').length;
    insights.push({ icon: '✅', level: 'good', text: `Good week — <strong>${thisWeek.length} calls</strong>, ${responseRate} responded. No concerns detected.` });
  }

  // Add routine learning insights (needs 2+ weeks of data)
  const routineInsights = _generateRoutineInsights(calls);
  insights.push(...routineInsights);

  // Add carer wellbeing insights
  const wellbeingInsights = _generateCarerWellbeingInsights(calls);
  insights.push(...wellbeingInsights);

  return insights;
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

export function exportLogCSV() {
  if (!_allLogCalls.length) { toast(t('No calls to export')); return; }
  let calls = _allLogCalls;
  if (_logFilter === 'handoff') {
    calls = calls.filter(c => c._type === 'handoff');
  } else if (_logFilter !== 'all') {
    calls = calls.filter(c => c.fromName === _logFilter || c.ackName === _logFilter || c.from === _logFilter);
  }

  const rows = [['Date', 'Time', 'Room', 'Patient', 'Need Type', 'Message', 'Status', 'Carer', 'Response Time (s)', 'Acknowledged At']];
  calls.forEach(call => {
    const d = call.timestamp ? new Date(call.timestamp) : null;
    const date = d ? d.toLocaleDateString() : '';
    const time = d ? d.toLocaleTimeString() : '';
    const ackD = call.ackAt ? new Date(call.ackAt) : null;
    const ackTs = ackD ? ackD.toLocaleString() : '';
    const respSec = call.ackAt && call.timestamp ? Math.round((call.ackAt - call.timestamp) / 1000) : '';
    const types = call.type ? call.type.split(',').join('; ') : 'help';
    rows.push([
      date, time, call._room || '', call.fromName || '',
      types, call.message || '', call.status || '',
      call.ackName || '', respSec, ackTs,
    ]);
  });

  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const filterSuffix = _logFilter !== 'all' ? `_${_logFilter.replace(/\s+/g, '_')}` : '';
  a.download = `carecall_log${filterSuffix}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(t('CSV downloaded'));
}


// ════════════════════════════════════════════════════════════
//  ROUTINE LEARNING (Pattern Detection)
// ════════════════════════════════════════════════════════════
export function _generateRoutineInsights(calls) {
  // Needs 2+ weeks of data to detect patterns
  const insights = [];
  if (calls.length < 14) return insights;

  const now = Date.now();
  const WEEK = 7 * 86400000;
  const thisWeek = calls.filter(c => c.timestamp >= now - WEEK);
  const prevWeeks = calls.filter(c => c.timestamp < now - WEEK);
  if (prevWeeks.length < 7) return insights;

  // Build historical "usual" patterns
  const prevDailyAvg = prevWeeks.length / Math.max(1, Math.ceil((now - WEEK - Math.min(...prevWeeks.map(c=>c.timestamp))) / 86400000));
  const thisDailyAvg = thisWeek.length / 7;

  // 1. Daily call count deviation
  const today = calls.filter(c => c.timestamp >= now - 86400000);
  if (today.length > prevDailyAvg * 2.5 && today.length >= 4) {
    insights.push({ icon: '🔍', level: 'warn', text: `<strong>Unusual activity:</strong> ${today.length} calls today vs average ${prevDailyAvg.toFixed(1)}/day. Pattern deviation detected.` });
  }

  // 2. Missing routine calls
  const prevTypes = {};
  prevWeeks.forEach(c => { const t = c.type || 'help'; prevTypes[t] = (prevTypes[t] || 0) + 1; });
  const thisTypes = {};
  thisWeek.forEach(c => { const t = c.type || 'help'; thisTypes[t] = (thisTypes[t] || 0) + 1; });
  Object.entries(prevTypes).forEach(([type, count]) => {
    const weeklyRate = count / Math.max(1, Math.ceil(prevWeeks.length / 7));
    if (weeklyRate >= 3 && (!thisTypes[type] || thisTypes[type] < weeklyRate * 0.3)) {
      insights.push({ icon: '🔍', level: 'warn', text: `<strong>${needLabel(type)}</strong> calls dropped significantly — usually ${weeklyRate.toFixed(0)}/week, only ${thisTypes[type] || 0} this week.` });
    }
  });

  // 3. Response time getting consistently slower
  const getAvgResp = (list) => {
    const times = list.filter(c => c.ackAt && c.timestamp).map(c => c.ackAt - c.timestamp).filter(t => t > 0);
    return times.length >= 3 ? times.reduce((a,b) => a+b, 0) / times.length : null;
  };
  const prevResp = getAvgResp(prevWeeks);
  const thisResp = getAvgResp(thisWeek);
  if (prevResp && thisResp && thisResp > prevResp * 1.8) {
    insights.push({ icon: '🔍', level: 'warn', text: `<strong>Response pattern change:</strong> carers taking ${formatDuration(thisResp)} avg vs historical ${formatDuration(prevResp)}. Consistent slowdown detected.` });
  }

  return insights;
}

