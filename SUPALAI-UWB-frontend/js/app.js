/* tracking-web front end.
 *
 * Eight screens from the "tracking v02" design, rendered client-side over the
 * JSON API served by the FastAPI backend (backend/backend/main.py). Hash
 * routing so the whole thing is one document and the header/rail never
 * repaint between pages.
 *
 * Convention worth keeping: every figure on screen is tagged with where it
 * came from -- LIVE (derived from the UWB database), CONFIG (a json file) or
 * "ไม่มีข้อมูล" (no source exists yet). A dashboard that cannot tell you which
 * of its numbers are real is worse than one with fewer numbers.
 */
'use strict';

(() => {
const {
  api: requestApi,
  websocketUrl,
  state: S,
  OfflineError,
} = window.SUPALAI_API;

/* ------------------------------------------------------------------ utils */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* A button that silently does nothing is the worst failure mode there is --
   it looks like a broken page when the real problem is a stopped server. Every
   unhandled failure gets a banner saying which it was. */
function fatal(err) {
  const offline = err instanceof OfflineError;
  let bar = document.getElementById('fatal-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'fatal-bar';          /* positioned by app.css, along the bottom */
    document.body.appendChild(bar);
  }
  bar.innerHTML = offline
    ? 'ติดต่อ server ไม่ได้ — ตรวจว่า backend API (uvicorn) ยังรันอยู่ ' +
      'แล้วรีเฟรชหน้านี้'
    : 'เกิดข้อผิดพลาด: ' + esc(err && err.message ? err.message : String(err));
}

window.addEventListener('unhandledrejection', ev => fatal(ev.reason));
window.addEventListener('error', ev => fatal(ev.error || ev.message));

const pad = n => String(n).padStart(2, '0');

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtHM(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/* The design writes dates in the Buddhist era (01/01/2569), so follow it. */
function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear() + 543}`;
}
function fmtDur(sec) {
  if (sec == null) return '—';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h} ชม. ${m} นาที`;
  if (m) return `${m} นาที ${s} วิ`;
  return `${s} วิ`;
}
const m2 = v => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)} m`);

function toEpoch(dateStr, endOfDay) {
  if (!dateStr) return null;
  const d = new Date(dateStr + (endOfDay ? 'T23:59:59' : 'T00:00:00'));
  return isNaN(d) ? null : d.getTime() / 1000;
}

function rangeQuery(extra = {}) {
  const p = new URLSearchParams();
  const f = toEpoch(S.filters.from, false), t = toEpoch(S.filters.to, true);
  if (f) p.set('from', f);
  if (t) p.set('to', t);
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return p.toString() ? '?' + p.toString() : '';
}

const badge = on =>
  `<span class="badge ${on ? 'badge-on' : 'badge-off'}">${on ? 'ON' : 'OFF'}</span>`;

function battery(pct) {
  if (pct == null) return '<span class="batt batt-na">ไม่มีข้อมูล</span>';
  const cls = pct >= 60 ? 'batt-ok' : pct >= 30 ? 'batt-mid' : 'batt-low';
  return `<span class="batt ${cls}">${pct}%</span>`;
}

function dealCell(status) {
  if (!status) return '<span class="deal" style="color:var(--muted)">—</span>';
  const cls = status === 'ปิดการขาย' ? 'deal-won'
            : status === 'ยกเลิกการขาย' ? 'deal-lost' : 'deal-open';
  return `<span class="deal ${cls}">${esc(status)}</span>`;
}

const srcTag = kind => ({
  live: '<span class="src src-live">LIVE</span>',
  cfg: '<span class="src src-cfg">CONFIG</span>',
  none: '<span class="src src-none">ยังไม่มีข้อมูล</span>',
}[kind] || '');

function emptyRow(cols, msg) {
  return `<tr class="empty-row"><td colspan="${cols}">${esc(msg)}</td></tr>`;
}

/* -------------------------------------------------------------- floor plan */
function selectedPlanId() {
  if (S.filters.plan) return S.filters.plan;
  if (S.filters.project) {
    const project = (S.boot?.projects || []).find(item => item.project_id === S.filters.project);
    const plan = (project?.plans || []).find(item => item.live) || project?.plans?.[0];
    if (plan) return plan.plan_id;
  }
  return S.boot?.live_plan_id || '';
}

function selectedProjectId() {
  if (S.filters.project) return S.filters.project;
  const planId = selectedPlanId();
  const owner = (S.boot?.projects || []).find(project => (project.plans || []).some(
    plan => String(plan.plan_id) === String(planId)));
  return owner?.project_id || S.boot?.live_project_id || '';
}

function scopedApiPath(path, extra = {}) {
  const params = new URLSearchParams();
  const projectId = selectedProjectId();
  const planId = selectedPlanId();
  if (projectId) params.set('project', projectId);
  if (planId) params.set('plan', planId);
  Object.entries(extra).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, value);
  });
  return `${path}?${params.toString()}`;
}

async function loadPlanDrawing(planId = selectedPlanId()) {
  if (!planId) return {};
  S.planDrawingCache = S.planDrawingCache || new Map();
  if (S.planDrawingCache.has(planId)) return S.planDrawingCache.get(planId);
  const encoded = encodeURIComponent(planId);
  const pending = Promise.all([
    requestApi(`/api/plans/${encoded}`),
    requestApi(`/api/plans/${encoded}/objects`),
    requestApi(`/api/plans/${encoded}/zones`),
    requestApi(`/api/plans/${encoded}/anchors`),
    requestApi(`/api/plans/${encoded}/dimensions`),
  ]).then(([plan, objects, zones, anchors, dimensions]) => ({
    plan: plan.plan,
    objects: objects.objects || [],
    zones: zones.zones || [],
    anchors: Object.fromEntries((anchors.anchors || []).map(anchor => [anchor.anchor_id, [anchor.x, anchor.y]])),
    dimensions: dimensions.dimensions || [],
  })).catch(error => {
    S.planDrawingCache.delete(planId);
    throw error;
  });
  S.planDrawingCache.set(planId, pending);
  return pending;
}

function planSVG(opts = {}) {
  const zs = opts.zones || (S.boot ? S.boot.zones : []) || [];
  const anc = opts.anchors || (S.boot ? S.boot.anchors : {}) || {};
  const objects = opts.objects || [];
  const dimensions = opts.dimensions || [];
  const plan = opts.plan || null;
  const tags = opts.tags || [];
  const path = opts.path || [];

  let xs = [], ys = [];
  if (plan) {
    xs.push(0, Number(plan.width_m));
    ys.push(0, Number(plan.height_m));
  }
  zs.forEach(z => {
    const points = z.geometry?.points || [];
    if (points.length) points.forEach(point => { xs.push(Number(point[0])); ys.push(Number(point[1])); });
    else if (z.x && z.y) { xs.push(z.x[0], z.x[1]); ys.push(z.y[0], z.y[1]); }
    else { xs.push(z.x_min, z.x_max); ys.push(z.y_min, z.y_max); }
  });
  objects.forEach(object => {
    const geometry = object.geometry || {};
    (geometry.points || []).forEach(point => { xs.push(Number(point[0])); ys.push(Number(point[1])); });
    if (Number.isFinite(Number(geometry.x))) {
      xs.push(Number(geometry.x), Number(geometry.x) + Number(geometry.width || 0));
      ys.push(Number(geometry.y), Number(geometry.y) + Number(geometry.height || 0));
    }
  });
  Object.values(anc).forEach(p => { xs.push(p[0]); ys.push(p[1]); });
  tags.forEach(t => { if (t.x != null) { xs.push(t.x); ys.push(t.y); } });
  path.forEach(p => { xs.push(p[0]); ys.push(p[1]); });
  if (!xs.length) { xs = [0, 3]; ys = [0, 3]; }

  /* Clamp to percentiles: a handful of wild fixes must not shrink the room to
     a dot in the corner. Anything outside is reported under the drawing. */
  const sorted = a => a.slice().sort((p, q) => p - q);
  const qt = (a, f) => a[Math.min(a.length - 1, Math.floor(a.length * f))];
  const sx = sorted(xs), sy = sorted(ys), pad = 0.45;
  const x0 = plan ? -pad : qt(sx, 0.01) - pad;
  const x1 = plan ? Number(plan.width_m) + pad : qt(sx, 0.99) + pad;
  const y0 = plan ? -pad : qt(sy, 0.01) - pad;
  const y1 = plan ? Number(plan.height_m) + pad : qt(sy, 0.99) + pad;
  const W = 640, H = Math.max(260, Math.min(720, W * (y1 - y0) / (x1 - x0 || 1)));
  const X = v => (v - x0) / (x1 - x0) * W;
  const Y = v => H - (v - y0) / (y1 - y0) * H;

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="แผนผังโครงการ">`;
  s += `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff" rx="6"/>`;

  if (plan) {
    s += `<rect x="${X(0)}" y="${Y(Number(plan.height_m))}" width="${X(Number(plan.width_m)) - X(0)}"
            height="${Y(0) - Y(Number(plan.height_m))}" fill="none" stroke="#12315f" stroke-width="1.4"/>`;
  }

  objects.forEach(object => {
    const geometry = object.geometry || {};
    const type = String(geometry.type || object.object_type || '').toLowerCase();
    if (type === 'line' && (geometry.points || []).length >= 2) {
      const points = geometry.points.slice(0, 2).map(point => `${X(Number(point[0]))},${Y(Number(point[1]))}`).join(' ');
      s += `<polyline points="${points}" fill="none" stroke="#344054" stroke-width="1.6"/>`;
    } else if (type === 'rectangle' && Number.isFinite(Number(geometry.x))) {
      const left = X(Number(geometry.x));
      const top = Y(Number(geometry.y) + Number(geometry.height));
      s += `<rect x="${left}" y="${top}" width="${Math.abs(X(Number(geometry.x) + Number(geometry.width)) - left)}"
              height="${Math.abs(Y(Number(geometry.y)) - top)}" fill="#475467" fill-opacity=".035" stroke="#344054" stroke-width="1.4"/>`;
    }
  });

  zs.forEach(z => {
    const points = z.geometry?.points || [];
    if (points.length >= 3) {
      const polygon = points.map(point => `${X(Number(point[0]))},${Y(Number(point[1]))}`).join(' ');
      s += `<polygon points="${polygon}" fill="#12315f" fill-opacity=".06" stroke="#12315f"
              stroke-opacity=".45" stroke-dasharray="6 4"/>`;
      s += `<text x="${X(Number(points[0][0])) + 9}" y="${Y(Number(points[0][1])) + 19}" font-size="12" fill="#475467">${esc(z.name)}</text>`;
    } else {
      const zx = z.x || [z.x_min, z.x_max];
      const zy = z.y || [z.y_min, z.y_max];
      const w = X(zx[1]) - X(zx[0]), h = Y(zy[0]) - Y(zy[1]);
      s += `<rect x="${X(zx[0])}" y="${Y(zy[1])}" width="${w}" height="${h}"
              fill="#12315f" fill-opacity=".045" stroke="#12315f" stroke-opacity=".28"
              stroke-dasharray="6 4" rx="3"/>`;
      s += `<text x="${X(zx[0]) + 9}" y="${Y(zy[1]) + 19}" font-size="12" fill="#475467">${esc(z.name)}</text>`;
    }
  });

  dimensions.forEach(dimension => {
    s += `<line x1="${X(Number(dimension.x1))}" y1="${Y(Number(dimension.y1))}"
            x2="${X(Number(dimension.x2))}" y2="${Y(Number(dimension.y2))}"
            stroke="#1f6fd0" stroke-width="1" stroke-dasharray="4 3"/>`;
  });

  if (path.length > 1) {
    s += `<polyline fill="none" stroke="#1f6fd0" stroke-opacity=".38"
            stroke-width="2" stroke-linejoin="round"
            points="${path.map(p => `${X(p[0])},${Y(p[1])}`).join(' ')}"/>`;
  }

  Object.entries(anc).forEach(([id, p]) => {
    const cx = X(p[0]), cy = Y(p[1]);
    const on = (opts.anchorStatus || {})[id];
    const fill = on === false ? '#c8322b' : '#b5540b';
    s += `<rect x="${cx - 6}" y="${cy - 6}" width="12" height="12" fill="${fill}"
            transform="rotate(45 ${cx} ${cy})"/>`;
    s += `<text x="${cx + 12}" y="${cy - 9}" font-size="11" fill="#475467">${esc(id)}</text>`;
  });

  tags.forEach(t => {
    if (t.x == null) return;
    const cx = X(t.x), cy = Y(t.y);
    const col = t.on === false ? '#8a93a3' : '#1f6fd0';
    s += `<circle cx="${cx}" cy="${cy}" r="13" fill="${col}" opacity=".18"/>`;
    s += `<circle cx="${cx}" cy="${cy}" r="5.5" fill="${col}"/>`;
    s += `<text x="${cx + 12}" y="${cy + 4}" font-size="11.5" font-weight="600"
            fill="#1d2430">${esc(t.label || t.tag_id)}</text>`;
  });

  s += '</svg>';

  const outside = path.filter(p => p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1).length;
  return `<div class="plan">${s}</div>
    <div class="legend">
      <span><i style="background:#1f6fd0"></i>แท็ก (ออนไลน์)</span>
      <span><i style="background:#8a93a3"></i>แท็ก (ออฟไลน์)</span>
      <span><i class="sq" style="background:#b5540b"></i>Anchor</span>
      ${outside ? `<span style="color:var(--muted)">ไม่ได้วาด ${outside} จุดที่หลุดนอกกรอบ</span>` : ''}
    </div>`;
}

/* ------------------------------------------------------------------ shell */
const MENU = [
  { group: 'เมนูหลัก', items: [
    { id: 'overview', label: 'ข้อมูลภาพรวม' },
    { id: 'project', label: 'ติดตามรายโครงการ' },
    { id: 'sales', label: 'การติดตามสถานะพนักงานขาย' },
    { id: 'visits', label: 'บันทึกการเยี่ยมชมโครงการ' },
  ] },
  { group: 'ตั้งค่า', roles: ['admin'], items: [
    { id: 'plan-editor', label: 'Plan Editor', href: 'plan-editor.html' },
    { id: 'devices', label: 'ตั้งค่าอุปกรณ์' },
    { id: 'device-tracking', label: 'ติดตามอุปกรณ์' },
  ] },
];

function initials(u) {
  if (!u) return '?';
  return ((u.first_en || '?')[0] + (u.last_en || '')[0] || '?').toUpperCase();
}

function shell(inner) {
  const role = S.user ? S.user.role : 'sale';
  const rail = MENU.filter(g => !g.roles || g.roles.includes(role)).map(g => `
    <div class="rail-group">
      <div class="rail-title">${esc(g.group)}</div>
      ${g.items.map(i => `<a href="${i.href || '#/' + i.id}" class="${S.route === i.id ? 'on' : ''}">${esc(i.label)}</a>`).join('')}
    </div>`).join('');

  return `
  <header class="header">
    <div class="brand"><span class="brand-mark">S</span>SUPALAI</div>
    <div class="header-right">
      <div class="who">
        <b>${esc(S.user ? `${S.user.first_th} ${S.user.last_th}` : '')}</b>
        <span>${esc(S.user ? `${S.user.employee_id} · ${S.user.position}` : '')}</span>
      </div>
      <div class="avatar">${esc(initials(S.user))}</div>
      <button class="linkish" id="logout">Logout</button>
    </div>
  </header>
  <nav class="rail">${rail}</nav>
  <main class="main">${inner}</main>`;
}

function filterCard(fields) {
  const F = S.filters;
  const provinces = [...new Set((S.boot.projects || []).map(p => p.province))];
  const projects = (S.boot.projects || [])
    .filter(p => !F.province || p.province === F.province);
  const plans = projects.flatMap(p => (p.plans || []).map(
    pl => ({ id: pl.plan_id, name: pl.name, live: pl.live })));

  const bits = {
    province: `<div class="field"><label class="label" for="f-province">จังหวัด</label>
      <select class="control" id="f-province"><option value="">ทั้งหมด</option>
      ${provinces.map(p => `<option ${F.province === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
      </select></div>`,
    project: `<div class="field"><label class="label" for="f-project">ชื่อโครงการ</label>
      <select class="control" id="f-project"><option value="">ทั้งหมด</option>
      ${projects.map(p => `<option value="${esc(p.project_id)}" ${F.project === p.project_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select></div>`,
    plan: `<div class="field"><label class="label" for="f-plan">แผนผังโครงการ</label>
      <select class="control" id="f-plan"><option value="">ทั้งหมด</option>
      ${plans.map(p => `<option value="${esc(p.id)}" ${F.plan === p.id ? 'selected' : ''}>${esc(p.name)}${p.live ? ' (มีอุปกรณ์จริง)' : ''}</option>`).join('')}
      </select></div>`,
    employee: `<div class="field"><label class="label" for="f-emp">รหัสพนักงาน</label>
      <select class="control" id="f-emp"><option value="">ทั้งหมด</option>
      ${(S.boot.people || []).filter(p => p.tag_id).map(p => `<option value="${esc(p.employee_id)}" ${F.employee === p.employee_id ? 'selected' : ''}>${esc(p.employee_id)} — ${esc(p.first_en)} ${esc(p.last_en)}</option>`).join('')}
      </select></div>`,
    customer: `<div class="field"><label class="label" for="f-cust">รหัสลูกค้า</label>
      <input class="control" id="f-cust" placeholder="SPL-PT-001" value="${esc(F.customer)}"></div>`,
    dates: `<div class="field"><span class="label">ช่วงวันที่</span>
      <div class="field-row">
        <label class="sub"><span>ตั้งแต่</span>
          <input class="control" type="date" id="f-from" value="${esc(F.from)}"></label>
        <label class="sub"><span>ถึง</span>
          <input class="control" type="date" id="f-to" value="${esc(F.to)}"></label>
      </div></div>`,
  };

  return `<div class="card"><div class="card-head"><span class="card-title">รายละเอียด</span></div>
    <div class="card-body">
      ${fields.map(f => bits[f] || '').join('')}
      <div class="btn-row" style="margin-top:14px">
        <button class="btn btn-primary btn-block" id="f-apply">ค้นหา</button>
        <button class="btn" id="f-clear">ล้าง</button>
      </div>
    </div></div>`;
}

function wireFilters(rerender) {
  const map = { 'f-province': 'province', 'f-project': 'project', 'f-plan': 'plan',
                'f-emp': 'employee', 'f-cust': 'customer', 'f-from': 'from',
                'f-to': 'to' };
  const apply = $('#f-apply');
  if (apply) apply.onclick = () => {
    for (const [id, key] of Object.entries(map)) {
      const el = $('#' + id);
      if (el) S.filters[key] = el.value;
    }
    rerender();
  };
  const clear = $('#f-clear');
  if (clear) clear.onclick = () => {
    S.filters = { province: '', project: '', plan: '', employee: '',
                  customer: '', from: '', to: '' };
    rerender();
  };
  const prov = $('#f-province');
  if (prov) prov.onchange = () => {
    S.filters.province = prov.value;
    S.filters.project = ''; S.filters.plan = '';
    rerender();
  };
}

/* ------------------------------------------------------------------ pages */
const WEEKDAYS = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'];

/* Sales analysis for the team lead.
 *
 * Every panel joins two different kinds of fact: where and how long, measured
 * by UWB, against the outcome a person typed in afterwards. Wherever the
 * second half is missing the panel says so rather than quietly averaging over
 * whatever happens to be filled in -- a close rate over three visits is not a
 * close rate, and presenting it as one is how a dashboard starts lying. */
function analyticsSection(a) {
  const pct = v => (v == null ? '—' : v.toFixed(0) + '%');
  const maxFunnel = Math.max(1, ...a.funnel.map(f => f.n));
  const dbo = a.duration_by_outcome;
  const gap = (dbo.won.avg != null && dbo.lost.avg != null)
    ? dbo.won.avg - dbo.lost.avg : null;
  const maxHour = Math.max(1, ...a.by_hour.map(h => h.visits));
  const zones = a.zone_by_outcome.filter(z => z.total > 0).slice(0, 6);
  const maxZone = Math.max(1, ...zones.map(z => Math.max(z.won_avg || 0, z.lost_avg || 0)));

  const caution = a.enough_data ? '' : `
    <div class="banner"><span>
      <b>ยังสรุปเป็นแนวโน้มไม่ได้</b> — มีการเยี่ยมชมที่ระบุผลแล้วเพียง
      ${a.decided} รายการ (ควรมีอย่างน้อย ${a.min_for_trend} รายการ)
      ตัวเลขด้านล่างจึงใช้ดูโครงสร้างข้อมูลได้ แต่ยังไม่ควรใช้ตัดสินใจ
      ${a.unlabelled ? `· มี ${a.unlabelled} การเยี่ยมชมที่ยังไม่ได้ระบุผลการขาย` : ''}
    </span></div>`;

  return `
  <div class="card"><div class="card-head">
    <span class="card-title">วิเคราะห์การขาย</span>
    <span class="page-sub">เฉพาะหัวหน้าทีมและผู้ดูแลระบบ</span></div>
    <div class="card-body">
      ${caution}
      <div class="kpi">
        <div class="kpi-box"><div class="kpi-label">อัตราปิดการขาย</div>
          <div class="kpi-value">${pct(a.close_rate)}</div>
          <div class="kpi-note">ปิดได้ ${a.won} จากที่ตัดสินใจแล้ว ${a.decided}</div></div>
        <div class="kpi-box"><div class="kpi-label">เวลาเฉลี่ยที่ใช้ต่อการเยี่ยมชม</div>
          <div class="kpi-value" style="font-size:17px">${fmtDur(a.avg_duration)}</div>
          <div class="kpi-note">จากทั้งหมด ${a.n_visits} การเยี่ยมชม</div></div>
        <div class="kpi-box"><div class="kpi-label">ยังไม่ได้ระบุผลการขาย</div>
          <div class="kpi-value">${a.unlabelled}</div>
          <div class="kpi-note">${a.n_visits ? (100 * a.unlabelled / a.n_visits).toFixed(0) : 0}% ของการเยี่ยมชมทั้งหมด</div></div>
      </div>

      <div style="margin-top:18px">
        <div class="card-title" style="margin-bottom:10px">เส้นทางจากการเยี่ยมชมสู่การปิดการขาย</div>
        <div class="funnel">${a.funnel.map(f => `
          <div class="funnel-row">
            <div class="bar-label">${esc(f.label)}</div>
            <div class="funnel-track"><div class="funnel-fill" style="width:${100 * f.n / maxFunnel}%"></div></div>
            <div class="bar-value">${f.n}</div>
          </div>`).join('')}</div>
        <div class="hint" style="border:0;background:none;padding:8px 0 0">
          ช่วงที่หายไปมากที่สุดคือจุดที่ควรแก้ก่อน — ถ้าตกมากตรง "บันทึกรหัสลูกค้าแล้ว"
          แปลว่าปัญหาอยู่ที่การกรอกข้อมูล ไม่ใช่ที่การขาย</div>
      </div>

      <div style="margin-top:20px">
        <div class="card-title" style="margin-bottom:10px">เวลาที่ใช้กับผลการขาย</div>
        ${gap == null ? `<div style="color:var(--muted);padding:14px 0">
            ต้องมีทั้งดีลที่ปิดได้และปิดไม่ได้อย่างน้อยอย่างละ 1 รายการจึงจะเทียบได้
            (ตอนนี้ ปิดได้ ${dbo.won.n} · ยกเลิก ${dbo.lost.n})</div>`
        : `<div class="bars">
            <div class="bar-row"><div class="bar-label">ปิดการขาย (${dbo.won.n})</div>
              <div class="bar-track"><div class="bar-fill" style="background:var(--ok);width:${100 * dbo.won.avg / Math.max(dbo.won.avg, dbo.lost.avg)}%"></div></div>
              <div class="bar-value">${fmtDur(dbo.won.avg)}</div></div>
            <div class="bar-row"><div class="bar-label">ยกเลิกการขาย (${dbo.lost.n})</div>
              <div class="bar-track"><div class="bar-fill" style="background:var(--off);width:${100 * dbo.lost.avg / Math.max(dbo.won.avg, dbo.lost.avg)}%"></div></div>
              <div class="bar-value">${fmtDur(dbo.lost.avg)}</div></div>
          </div>
          <div class="hint" style="border:0;background:none;padding:8px 0 0">
            ${gap > 0
              ? `ลูกค้าที่ปิดการขายได้ใช้เวลาในโครงการนานกว่าเฉลี่ย <b>${fmtDur(Math.abs(gap))}</b>
                 — ใช้เป็นเกณฑ์เตือนได้ว่าถ้าลูกค้าอยู่ไม่ถึงเวลานี้ ควรหาทางพาชมเพิ่ม`
              : `ลูกค้าที่ปิดการขายได้ใช้เวลา<b>น้อยกว่า</b> ${fmtDur(Math.abs(gap))}
                 — เวลานานไม่ได้แปลว่าจะปิดได้ อาจสะท้อนความลังเลมากกว่าความสนใจ`}</div>`}
      </div>

      <div style="margin-top:20px">
        <div class="card-title" style="margin-bottom:10px">โซนที่ลูกค้าใช้เวลา เทียบระหว่างดีลที่ปิดได้กับไม่ได้</div>
        ${zones.length ? `<div class="bars">${zones.map(z => `
          <div class="bar-row">
            <div class="bar-label">${esc(z.zone)}</div>
            <div>
              <div class="bar-track" style="margin-bottom:3px">
                <div class="bar-fill" style="background:var(--ok);width:${100 * (z.won_avg || 0) / maxZone}%"></div></div>
              <div class="bar-track">
                <div class="bar-fill" style="background:var(--off);width:${100 * (z.lost_avg || 0) / maxZone}%"></div></div>
            </div>
            <div class="bar-value">${z.delta == null ? '—'
              : (z.delta > 0 ? '+' : '') + fmtDur(Math.abs(z.delta))}</div>
          </div>`).join('')}</div>
          <div class="legend"><span><i style="background:var(--ok)"></i>ดีลที่ปิดได้</span>
            <span><i style="background:var(--off)"></i>ดีลที่ยกเลิก</span></div>
          <div class="hint" style="border:0;background:none;padding:8px 0 0">
            โซนที่แถบเขียวยาวกว่าแดงชัด ๆ คือห้องที่ควรจัดให้น่าสนใจที่สุดและพาลูกค้าเข้าให้ได้
            — นี่คือกราฟที่ดีไซน์ระบุไว้ว่า "แต่ละแปลนมีอัตราการปิดดีลเท่าไหร่"</div>`
        : '<div style="color:var(--muted);padding:14px 0">ยังไม่มีข้อมูลโซน</div>'}
      </div>

      <div style="margin-top:20px">
        <div class="card-title" style="margin-bottom:10px">ผลงานรายพนักงาน</div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>พนักงาน</th><th class="num">เยี่ยมชม</th>
            <th class="num">ระบุผลแล้ว</th><th class="num">ปิดได้</th>
            <th class="num">อัตราปิด</th><th class="num">เวลาเฉลี่ย</th></tr></thead>
          <tbody>${a.by_person.length ? a.by_person.map(p => `
            <tr><td>${esc(p.name || p.employee_id)}</td>
              <td class="num">${p.visits}</td><td class="num">${p.decided}</td>
              <td class="num">${p.won}</td>
              <td class="num">${p.close_rate == null ? '<span class="dim">—</span>' : pct(p.close_rate)}</td>
              <td class="num">${fmtDur(p.avg_duration)}</td></tr>`).join('')
            : emptyRow(6, 'ยังไม่มีข้อมูล')}</tbody>
        </table></div>
      </div>

      <div style="margin-top:20px">
        <div class="card-title" style="margin-bottom:10px">ช่วงเวลาที่ลูกค้าเข้าโครงการ</div>
        ${a.by_hour.length ? `<div class="bars">${a.by_hour.map(h => `
          <div class="bar-row"><div class="bar-label">${pad(h.hour)}:00 น.</div>
            <div class="bar-track"><div class="bar-fill" style="width:${100 * h.visits / maxHour}%"></div></div>
            <div class="bar-value">${h.visits} ครั้ง</div></div>`).join('')}</div>
          <div class="hint" style="border:0;background:none;padding:8px 0 0">
            ใช้จัดกำลังพนักงานให้ตรงช่วงที่ลูกค้าเข้าจริง
            ${a.by_weekday.length ? '· วันที่มีคนเข้ามากสุดคือ ' +
              esc(WEEKDAYS[a.by_weekday.slice().sort((x, y) => y.visits - x.visits)[0].day]) : ''}</div>`
        : '<div style="color:var(--muted);padding:14px 0">ยังไม่มีข้อมูล</div>'}
      </div>
    </div>
    <div class="hint">ตำแหน่ง เวลา และโซน มาจากระบบ UWB ${srcTag('live')}
      ส่วนผลการขายมาจากที่พนักงานกรอก — ถ้ายังไม่กรอก ช่องที่เกี่ยวกับดีลจะว่าง</div>
  </div>`;
}

async function pageOverview() {
  const q = rangeQuery();
  const isLead = S.user && (S.user.role === 'sale_lead' || S.user.role === 'admin');
  const [ov, dev, live, ana, drawing] = await Promise.all([
    requestApi('/api/overview' + q), requestApi(scopedApiPath('/api/devices')), requestApi(scopedApiPath('/api/live', { since: 0 })),
    isLead ? requestApi('/api/analytics' + q).catch(() => null) : Promise.resolve(null),
    loadPlanDrawing().catch(() => ({})),
  ]);
  const tags = Object.entries(live.tags || {}).map(([id, t]) =>
    Object.assign({ tag_id: id, label: t.sale_name || id }, t));

  render(`
    <div class="page-head"><h1>ข้อมูลภาพรวม</h1>
      <span class="page-sub">ตัวเลขทั้งหมดคำนวณจากฐานข้อมูลตำแหน่ง UWB</span></div>
    <div class="tiles">
      <div class="tile"><div class="tile-label">การเยี่ยมชมทั้งหมด</div>
        <div class="tile-value">${ov.visits.toLocaleString()}</div>
        <div class="tile-foot">ตัดช่วงจากข้อมูลตำแหน่งจริง</div></div>
      <div class="tile"><div class="tile-label">Anchor ที่ออนไลน์</div>
        <div class="tile-value">${ov.anchors_on} / ${ov.anchors_total}</div>
        <div class="tile-foot">ดูจาก anchor ที่ปรากฏใน 30 วินาทีล่าสุด</div></div>
      <div class="tile"><div class="tile-label">แท็กที่ออนไลน์</div>
        <div class="tile-value">${ov.tags_on} / ${ov.tags_total}</div>
        <div class="tile-foot">มี fix ภายใน 5 วินาที</div></div>
      <div class="tile"><div class="tile-label">เวลาเฉลี่ยต่อการเยี่ยมชม</div>
        <div class="tile-value" style="font-size:18px">${fmtDur(ov.avg_duration)}</div>
        <div class="tile-foot">${ov.close_rate == null ? 'ยังไม่มีข้อมูลปิดดีล' : `อัตราปิดดีล ${ov.close_rate.toFixed(0)}%`}</div></div>
    </div>

    ${ana ? analyticsSection(ana) : ''}

    <div class="cols cols-filter-main" style="margin-top:14px">
      <div class="stack">${filterCard(['province', 'project', 'plan', 'dates'])}</div>
      <div class="stack">
        <div class="card"><div class="card-head">
          <span class="card-title">Anchor Status ${srcTag('live')}</span></div>
          <div class="card-body flush"><div class="table-wrap"><table class="data">
            <thead><tr><th>Anchor ID</th><th class="num">Axis X</th>
              <th class="num">Axis Y</th><th>Status</th><th>Battery</th></tr></thead>
            <tbody>${dev.anchors.length ? dev.anchors.map(a => `
              <tr><td>${esc(a.anchor_id)}</td><td class="num axis">${m2(a.x)}</td>
                <td class="num axis">${m2(a.y)}</td><td>${badge(a.on)}</td>
                <td>${battery(a.battery)}</td></tr>`).join('')
              : emptyRow(5, 'ไม่พบ anchor ที่ตั้งค่าไว้สำหรับโครงการนี้')}</tbody>
          </table></div></div>
          <div class="hint"><b>Battery</b> ยังไม่มีข้อมูล — เฟิร์มแวร์ไม่ได้ส่งค่าแบตเตอรี่มา
            ต้องเพิ่มการอ่าน ADC ในฝั่งอุปกรณ์ก่อนช่องนี้ถึงจะมีค่า</div>
        </div>

        <div class="card"><div class="card-head">
          <span class="card-title">Tag Status ${srcTag('live')}</span></div>
          <div class="card-body flush"><div class="table-wrap"><table class="data">
            <thead><tr><th>Tag ID</th><th>พนักงาน</th><th class="num">Axis X</th>
              <th class="num">Axis Y</th><th>Status</th><th>Battery</th></tr></thead>
            <tbody>${dev.tags.length ? dev.tags.map(t => `
              <tr><td>${esc(t.tag_id)}</td>
                <td>${t.sale_name ? esc(t.sale_name) : '<span class="dim">ยังไม่ผูกกับพนักงาน</span>'}</td>
                <td class="num axis">${m2(t.x)}</td><td class="num axis">${m2(t.y)}</td>
                <td>${badge(t.on)}</td><td>${battery(t.battery)}</td></tr>`).join('')
              : emptyRow(6, 'ยังไม่มีแท็กส่งข้อมูลเข้ามา')}</tbody>
          </table></div></div>
        </div>

        <div class="card"><div class="card-head">
          <span class="card-title">แผนผังโครงการ</span></div>
          <div class="card-body">${planSVG({ ...drawing, tags })}</div>
        </div>
      </div>
    </div>`);
  wireFilters(pageOverview);
}

async function pageProject() {
  const q = rangeQuery();
  const [live, dev, vis, drawing] = await Promise.all([
    requestApi(scopedApiPath('/api/live', { since: 0 })), requestApi(scopedApiPath('/api/devices')), requestApi('/api/visits' + q),
    loadPlanDrawing().catch(() => ({})),
  ]);
  const tags = Object.entries(live.tags || {}).map(([id, t]) =>
    Object.assign({ tag_id: id, label: t.sale_name || id }, t));
  const anchorStatus = Object.fromEntries(dev.anchors.map(a => [a.anchor_id, a.on]));

  const byTag = {};
  vis.visits.forEach(v => { (byTag[v.tag_id] = byTag[v.tag_id] || []).push(v); });
  const tagIds = Object.keys(byTag).length ? Object.keys(byTag)
                                           : dev.tags.map(t => t.tag_id);

  render(`
    <div class="page-head"><h1>ติดตามรายโครงการ</h1>
      <span class="page-sub">สถานะการเยี่ยมชมแยกตามแท็ก</span></div>
    <div class="cols cols-filter-main">
      <div class="stack">
        ${filterCard(['province', 'project', 'plan', 'dates'])}
        <div class="card"><div class="card-head">
          <span class="card-title">แผนผังโครงการ</span></div>
          <div class="card-body">${planSVG({ ...drawing, tags, anchorStatus })}</div></div>
      </div>
      <div class="stack">
        ${tagIds.length ? tagIds.map(tid => {
          const rows = (byTag[tid] || []).slice(0, 40);
          const p = (S.boot.people || []).find(x => x.tag_id === tid);
          return `<div class="card">
            <div class="card-head">
              <span class="card-title">สถานะการเยี่ยมชม ${esc(tid)}</span>
              <span class="page-sub">${p ? esc(p.first_en + ' ' + p.last_en) : 'ยังไม่ผูกกับพนักงาน'}</span>
            </div>
            <div class="card-body flush"><div class="table-wrap table-scroll">
              <table class="data">
                <thead><tr><th>Sale ID</th><th>Sale Name</th><th>Time</th>
                  <th>Location</th><th class="num">ระยะเวลา</th></tr></thead>
                <tbody>${rows.length ? rows.map(v => `
                  <tr class="clickable" data-visit="${esc(v.visit_key)}">
                    <td>${esc(v.employee_id || '—')}</td>
                    <td>${esc(v.sale_name || '—')}</td>
                    <td>${fmtHM(v.start_ts)}</td>
                    <td>${esc(v.top_zone || '—')}</td>
                    <td class="num">${fmtDur(v.duration)}</td></tr>`).join('')
                  : emptyRow(5, 'ยังไม่มีการเยี่ยมชมในช่วงเวลาที่เลือก')}</tbody>
              </table></div></div></div>`;
        }).join('') : `<div class="card"><div class="card-body">
            <div class="empty-row" style="display:block;text-align:center;color:var(--muted);padding:40px">
            ยังไม่มีแท็กในระบบ</div></div></div>`}
      </div>
    </div>`);
  wireFilters(pageProject);
  wireVisitRows();
}

async function pageSales() {
  const q = rangeQuery({ employee: S.filters.employee, customer: S.filters.customer });
  const vis = await requestApi('/api/visits' + q);
  const who = S.filters.employee
    ? (S.boot.people || []).find(p => p.employee_id === S.filters.employee)
    : S.user;

  const perZone = {};
  vis.visits.forEach(v => {
    if (v.top_zone) perZone[v.top_zone] = (perZone[v.top_zone] || 0) + 1;
  });
  const maxZone = Math.max(1, ...Object.values(perZone));

  render(`
    <div class="page-head"><h1>การติดตามสถานะพนักงานขาย</h1>
      <span class="page-sub">${vis.scope === 'sale' ? 'คุณเห็นเฉพาะข้อมูลของตัวเอง' : 'เห็นข้อมูลของทุกคน'}</span></div>
    <div class="cols cols-filter-main">
      <div class="stack">${filterCard(['employee', 'customer', 'dates'])}</div>
      <div class="stack">
        <div class="card"><div class="card-body">
          <div class="profile-top">
            <div class="profile-pic">${esc(initials(who))}</div>
            <div>
              <div class="profile-name">${esc(who ? `${who.first_th} ${who.last_th}` : '—')}</div>
              <div class="profile-role">${esc(who ? who.position : '')}</div>
            </div>
          </div>
          <div class="kv">
            <div><div class="label">รหัสพนักงาน</div><div class="val">${esc(who ? who.employee_id : '—')}</div></div>
            <div><div class="label">ตำแหน่ง</div><div class="val">${esc(who ? who.position : '—')}</div></div>
            <div><div class="label">ชื่อภาษาไทย</div><div class="val">${esc(who ? who.first_th : '—')}</div></div>
            <div><div class="label">ชื่อภาษาอังกฤษ</div><div class="val">${esc(who ? who.first_en : '—')}</div></div>
            <div><div class="label">นามสกุลภาษาไทย</div><div class="val">${esc(who ? who.last_th : '—')}</div></div>
            <div><div class="label">นามสกุลภาษาอังกฤษ</div><div class="val">${esc(who ? who.last_en : '—')}</div></div>
            <div><div class="label">Gmail</div><div class="val">${esc(who ? who.email : '—')}</div></div>
            <div><div class="label">เบอร์ติดต่อ</div><div class="val">${esc(who ? who.phone : '—')}</div></div>
          </div></div>
          <div class="hint">ข้อมูลพนักงานมาจากฐานข้อมูลผู้ใช้งานของระบบ ${srcTag('cfg')}</div>
        </div>

        <div class="card"><div class="card-head">
          <span class="card-title">บันทึกการเยี่ยมชมโครงการ</span>
          <span class="page-sub">${vis.visits.length.toLocaleString()} รายการ</span></div>
          <div class="card-body flush"><div class="table-wrap table-scroll-tall">
            <table class="data">
              <thead><tr><th>Sale Name</th><th>Tag ID</th><th>Date</th><th>Time</th>
                <th>Customer ID</th><th>Status</th></tr></thead>
              <tbody>${vis.visits.length ? vis.visits.slice(0, 200).map(v => `
                <tr class="clickable" data-visit="${esc(v.visit_key)}">
                  <td>${esc(v.sale_name || '—')}</td><td>${esc(v.tag_id)}</td>
                  <td>${fmtDate(v.start_ts)}</td><td>${fmtHM(v.start_ts)}</td>
                  <td>${v.customer_id ? esc(v.customer_id) : '<span class="dim">ยังไม่ระบุ</span>'}</td>
                  <td>${dealCell(v.deal_status)}</td></tr>`).join('')
                : emptyRow(6, 'ยังไม่มีการเยี่ยมชม — เกิดขึ้นเองเมื่อมีแท็กเดินในพื้นที่')}</tbody>
            </table></div></div>
        </div>

        <div class="card"><div class="card-head">
          <span class="card-title">จำนวนการเยี่ยมชมแยกตามโซน</span></div>
          <div class="card-body">
            ${Object.keys(perZone).length ? `<div class="bars">${
              Object.entries(perZone).sort((a, b) => b[1] - a[1]).map(([z, n]) => `
                <div class="bar-row"><div class="bar-label">${esc(z)}</div>
                  <div class="bar-track"><div class="bar-fill" style="width:${100 * n / maxZone}%"></div></div>
                  <div class="bar-value">${n} ครั้ง</div></div>`).join('')}</div>`
              : '<div style="color:var(--muted);text-align:center;padding:26px">ยังไม่มีข้อมูล</div>'}
          </div>
          <div class="hint">กราฟอัตราปิดดีลเทียบแปลนบ้านตามดีไซน์ ต้องรอข้อมูลผลการขาย
            — กรอกช่อง Customer ID และ Status ในหน้ารายละเอียดการเยี่ยมชมสะสมไว้ก่อน ${srcTag('none')}</div>
        </div>
      </div>
    </div>`);
  wireFilters(pageSales);
  wireVisitRows();
}

async function pageVisits() {
  const q = rangeQuery({ employee: S.filters.employee, customer: S.filters.customer });
  const [vis, heat] = await Promise.all([
    requestApi('/api/visits' + q), requestApi('/api/heatmap' + q),
  ]);
  const peak = heat.peak || 1;

  render(`
    <div class="page-head"><h1>บันทึกการเยี่ยมชมโครงการ</h1>
      <span class="page-sub">คลิกแถวเพื่อดูรายละเอียดและกรอกผลการขาย</span></div>
    <div class="cols cols-filter-main">
      <div class="stack">${filterCard(['province', 'project', 'employee', 'customer', 'dates'])}</div>
      <div class="stack">
        <div class="card"><div class="card-head">
          <span class="card-title">บันทึกการเยี่ยมชมโครงการ</span>
          <span class="page-sub">${vis.visits.length.toLocaleString()} รายการ</span></div>
          <div class="card-body flush"><div class="table-wrap table-scroll-tall">
            <table class="data">
              <thead><tr><th>Sale Name</th><th>Tag ID</th><th>Date</th><th>Time</th>
                <th class="num">ระยะเวลา</th><th>โซนหลัก</th>
                <th>Customer ID</th><th>Status</th><th class="num">บันทึก</th></tr></thead>
              <tbody>${vis.visits.length ? vis.visits.slice(0, 300).map(v => `
                <tr class="clickable" data-visit="${esc(v.visit_key)}">
                  <td>${esc(v.sale_name || '—')}</td><td>${esc(v.tag_id)}</td>
                  <td>${fmtDate(v.start_ts)}</td><td>${fmtHM(v.start_ts)}</td>
                  <td class="num">${fmtDur(v.duration)}</td>
                  <td>${esc(v.top_zone || '—')}</td>
                  <td>${v.customer_id ? esc(v.customer_id) : '<span class="dim">—</span>'}</td>
                  <td>${dealCell(v.deal_status)}</td>
                  <td class="num">${v.note_count || 0}</td></tr>`).join('')
                : emptyRow(9, 'ยังไม่มีการเยี่ยมชมในช่วงที่เลือก')}</tbody>
            </table></div></div>
        </div>

        <div class="card"><div class="card-head">
          <span class="card-title">heatmap โซนที่ใช้เวลามากที่สุด ${srcTag('live')}</span>
          <span class="page-sub">แกนนอนคือชั่วโมงของวัน</span></div>
          <div class="card-body">
            ${heat.rows.length ? `<div class="heat">
              ${heat.rows.map(r => `<div class="heat-row">
                <div class="bar-label">${esc(r.zone)} · ${fmtDur(r.total)}</div>
                <div class="heat-cells">${r.cells.map(c => `
                  <div class="heat-cell" style="opacity:${(0.10 + 0.90 * (c / peak)).toFixed(3)}"
                       title="${fmtDur(c)}"></div>`).join('')}</div></div>`).join('')}
              <div class="heat-row"><div></div>
                <div class="heat-axis">${heat.hours.map(h => `<span>${pad(h)}</span>`).join('')}</div></div>
            </div>
            <div class="heat-scale"><span>น้อย</span><span class="swatch"></span><span>มาก</span>
              <span style="margin-left:auto">สูงสุด ${fmtDur(heat.peak)} ต่อช่อง</span></div>`
            : '<div style="color:var(--muted);text-align:center;padding:34px">ยังไม่มีข้อมูลพอสร้าง heatmap</div>'}
          </div>
        </div>
      </div>
    </div>`);
  wireFilters(pageVisits);
  wireVisitRows();
}

async function pageVisitDetail(key) {
  const d = await requestApi('/api/visit?key=' + encodeURIComponent(key));
  if (d.error) { render(`<div class="card"><div class="card-body">${esc(d.error)}</div></div>`); return; }
  const drawing = await loadPlanDrawing(d.plan_id || selectedPlanId()).catch(() => ({}));
  /* The server decides this, not the browser -- a hidden button is not a
     permission. It is echoed back so the two can never disagree. */
  const canEdit = !!d.can_edit;
  const readOnlyWhy = d.viewer_role === 'sale'
    ? 'การเยี่ยมชมนี้เป็นของพนักงานคนอื่น'
    : 'หัวหน้าทีมและผู้ดูแลระบบดูข้อมูลได้อย่างเดียว แก้ไขและเพิ่มบันทึกได้เฉพาะพนักงานขายเจ้าของการเยี่ยมชม';

  render(`
    <div class="page-head">
      <h1>ข้อมูลการเยี่ยมชมโครงการ</h1>
      <span class="page-sub">${esc(d.sale_name || d.tag_id)} · ${fmtDate(d.start_ts)}
        ${fmtHM(d.start_ts)}–${fmtHM(d.end_ts)} · ${d.fixes.toLocaleString()} จุด</span>
    </div>
    <div class="cols cols-main-plan">
      <div class="stack">
        <div class="card"><div class="card-head">
          <span class="card-title">ข้อมูลการเยี่ยมชมโครงการ ${srcTag('live')}</span></div>
          <div class="card-body flush"><div class="table-wrap table-scroll">
            <table class="data">
              <thead><tr><th>Sale ID</th><th>Sale Name</th><th>Time</th><th>Location</th></tr></thead>
              <tbody>${d.timeline.length ? d.timeline.map(t => `
                <tr><td>${esc(d.employee_id || '—')}</td><td>${esc(d.sale_name || '—')}</td>
                  <td>${fmtTime(t.ts)}</td><td>${esc(t.zone)}</td></tr>`).join('')
                : emptyRow(4, 'ไม่มีข้อมูล')}</tbody>
            </table></div></div>
        </div>

        <div class="card"><div class="card-head">
          <span class="card-title">ระยะเวลาที่ใช้ในแต่ละโซนพื้นที่ ${srcTag('live')}</span></div>
          <div class="card-body flush"><div class="table-wrap">
            <table class="data">
              <thead><tr><th>Location</th><th>Time</th><th class="num">Total</th>
                <th class="num">สัดส่วน</th></tr></thead>
              <tbody>${d.dwell.length ? d.dwell.map(z => `
                <tr><td>${esc(z.zone)}</td><td>${fmtHM(z.first_ts)}</td>
                  <td class="num">${fmtDur(z.seconds)}</td>
                  <td class="num">${z.pct.toFixed(1)}%</td></tr>`).join('')
                : emptyRow(4, 'ไม่มีข้อมูล')}</tbody>
            </table></div></div>
          <div class="hint">ไม่นับช่วงที่ห่างเกิน 5 วินาที (รวม ${fmtDur(d.dwell_dropped)})
            เพราะนั่นคือช่วงขาดสัญญาณ ไม่ใช่การยืนนิ่ง</div>
        </div>

        <div class="card"><div class="card-head">
          <span class="card-title">ข้อมูลเพิ่มเติมจากพนักงานขาย</span>
          ${canEdit ? '<button class="btn" id="add-note">เพิ่มบันทึก</button>' : ''}</div>
          <div class="card-body">
            ${d.notes.length ? d.notes.map(n => `
              <div class="note"><div class="note-head">
                <span>${esc(n.author || n.employee_id)}</span>
                <span>${fmtDate(n.created_at)} ${fmtHM(n.created_at)}</span></div>
                <div class="note-body">${esc(n.body)}</div></div>`).join('')
            : '<div style="color:var(--muted);text-align:center;padding:26px">ยังไม่มีบันทึก</div>'}
          </div>
          <div class="hint">${canEdit
            ? 'พนักงานขายเห็นและเขียนได้เฉพาะการเยี่ยมชมของตัวเอง'
            : `<b>อ่านอย่างเดียว</b> — ${esc(readOnlyWhy)}`}</div>
        </div>
      </div>

      <div class="stack">
        <div class="card"><div class="card-head">
          <span class="card-title">ผลการขาย</span></div>
          <div class="card-body">
            <div class="field"><label class="label" for="v-cust">รหัสลูกค้า</label>
              <input class="control" id="v-cust" placeholder="SPL-PT-001"
                     value="${esc(d.customer_id || '')}" ${canEdit ? '' : 'disabled'}></div>
            <div class="field"><label class="label" for="v-deal">สถานะ</label>
              <select class="control" id="v-deal" ${canEdit ? '' : 'disabled'}>
                <option value="">ยังไม่ระบุ</option>
                ${(S.boot.deal_statuses || []).map(s => `<option ${d.deal_status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
              </select></div>
            ${canEdit ? '<button class="btn btn-primary btn-block" id="v-save">บันทึก</button>' : ''}
            <div id="v-saved" style="margin-top:10px"></div>
          </div>
          <div class="hint">${canEdit
            ? `ช่องนี้เป็นข้อมูลที่คนกรอก ${srcTag('none')} — UWB บอกได้แค่ว่าใครอยู่ตรงไหนนานแค่ไหน`
            : `<b>อ่านอย่างเดียว</b> — ${esc(readOnlyWhy)}`}</div>
        </div>
        <div class="card"><div class="card-head">
          <span class="card-title">เส้นทางการเดิน</span></div>
          <div class="card-body">${planSVG({ ...drawing, path: d.path })}</div></div>
      </div>
    </div>`);

  const save = $('#v-save');
  if (save) save.onclick = async () => {
    const r = await requestApi('/api/visit-meta', {
      method: 'POST',
      body: JSON.stringify({ visit_key: key, customer_id: $('#v-cust').value,
                             deal_status: $('#v-deal').value }),
    });
    $('#v-saved').innerHTML = r.ok
      ? '<div class="hint" style="border:0;background:none;padding:0;color:var(--ok)">บันทึกแล้ว</div>'
      : `<div class="err">${esc(r.error)}</div>`;
  };
  const add = $('#add-note');
  if (add) add.onclick = () => noteModal(key);
}

function noteModal(key) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal">
      <div class="modal-head"><span class="modal-title">เพิ่มบันทึกจากพนักงานขาย</span>
        <button class="x" id="m-x">&times;</button></div>
      <div class="modal-body">
        <div class="field"><label class="label" for="m-body">ข้อความ</label>
          <textarea class="control" id="m-body" placeholder="พิมพ์ได้ไม่จำกัดความยาว"></textarea></div>
        <div id="m-err"></div>
      </div>
      <div class="modal-foot"><button class="btn" id="m-cancel">ยกเลิก</button>
        <button class="btn btn-primary" id="m-save">บันทึก</button></div>
    </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  $('#m-x', back).onclick = close;
  $('#m-cancel', back).onclick = close;
  back.onclick = ev => { if (ev.target === back) close(); };
  $('#m-body', back).focus();
  $('#m-save', back).onclick = async () => {
    const r = await requestApi('/api/note', {
      method: 'POST',
      body: JSON.stringify({ visit_key: key, body: $('#m-body', back).value }),
    });
    if (!r.ok) { $('#m-err', back).innerHTML = `<div class="err">${esc(r.error)}</div>`; return; }
    close();
    pageVisitDetail(key);
  };
}

async function pageDevices() {
  const dev = await requestApi(scopedApiPath('/api/devices'));
  render(`
    <div class="page-head"><h1>ตั้งค่าอุปกรณ์</h1>
      <span class="page-sub">พิกัด anchor เพิ่ม/แก้ไขผ่าน API จัดการโครงการ (สิทธิ์ admin)</span></div>
    <div class="card"><div class="card-head">
      <span class="card-title">Anchor Status ${srcTag('live')}</span></div>
      <div class="card-body flush"><div class="table-wrap"><table class="data">
        <thead><tr><th>Anchor ID</th><th class="num">Axis X</th><th class="num">Axis Y</th>
          <th>Status</th><th>Battery</th><th>เห็นล่าสุด</th></tr></thead>
        <tbody>${dev.anchors.length ? dev.anchors.map(a => `
          <tr><td>${esc(a.anchor_id)}</td><td class="num axis">${m2(a.x)}</td>
            <td class="num axis">${m2(a.y)}</td><td>${badge(a.on)}</td>
            <td>${battery(a.battery)}</td>
            <td class="dim">${a.last_ts ? fmtTime(a.last_ts) : 'ยังไม่เคยเห็น'}</td></tr>`).join('')
          : emptyRow(6, 'ไม่พบ anchor')}</tbody>
      </table></div></div>
    </div>
    <div class="card"><div class="card-head">
      <span class="card-title">Tag Status ${srcTag('live')}</span></div>
      <div class="card-body flush"><div class="table-wrap"><table class="data">
        <thead><tr><th>Tag ID</th><th>พนักงาน</th><th class="num">Axis X</th>
          <th class="num">Axis Y</th><th>Status</th><th>Battery</th><th>เห็นล่าสุด</th></tr></thead>
        <tbody>${dev.tags.length ? dev.tags.map(t => `
          <tr><td>${esc(t.tag_id)}</td>
            <td>${t.sale_name ? esc(t.sale_name) : '<span class="dim">ยังไม่ผูก</span>'}</td>
            <td class="num axis">${m2(t.x)}</td><td class="num axis">${m2(t.y)}</td>
            <td>${badge(t.on)}</td><td>${battery(t.battery)}</td>
            <td class="dim">${t.last_ts ? fmtTime(t.last_ts) : 'ยังไม่เคยเห็น'}</td></tr>`).join('')
          : emptyRow(7, 'ยังไม่มีแท็ก')}</tbody>
      </table></div></div>
      <div class="hint">การผูกแท็กกับพนักงานแก้ไขผ่านฐานข้อมูลผู้ใช้งาน (คอลัมน์ <code>tag_id</code> ในตาราง users)</div>
    </div>`);
}

async function pageDeviceTracking() {
  const [dev, live, drawing] = await Promise.all([
    requestApi(scopedApiPath('/api/devices')),
    requestApi(scopedApiPath('/api/live', { since: 0 })),
    loadPlanDrawing().catch(() => ({})),
  ]);
  const tags = Object.entries(live.tags || {}).map(([id, t]) =>
    Object.assign({ tag_id: id, label: t.sale_name || id }, t));
  const anchorStatus = Object.fromEntries(dev.anchors.map(a => [a.anchor_id, a.on]));
  S.live.anchorStatus = anchorStatus;
  S.live.planDrawing = drawing;

  render(`
    <div class="page-head"><h1>ติดตามอุปกรณ์</h1>
      <span class="page-sub">PostgreSQL live ผ่าน WebSocket · fallback polling เมื่อการเชื่อมต่อขัดข้อง</span></div>
    <div class="cols cols-filter-main">
      <div class="stack">
        ${filterCard(['province', 'project', 'plan'])}
        <div class="card"><div class="card-head">
          <span class="card-title">สถานะรวม</span></div>
          <div class="card-body">
            <div class="bar-row" style="grid-template-columns:1fr auto">
              <div class="bar-label">Anchor ออนไลน์</div>
              <div class="bar-value">${dev.anchors.filter(a => a.on).length} / ${dev.anchors.length}</div></div>
            <div class="bar-row" style="grid-template-columns:1fr auto;margin-top:6px">
              <div class="bar-label">แท็กออนไลน์</div>
              <div class="bar-value">${dev.tags.filter(t => t.on).length} / ${dev.tags.length}</div></div>
          </div></div>
      </div>
      <div class="stack">
        <div class="card"><div class="card-head">
          <span class="card-title">แผนผังโครงการ</span>
          <span class="page-sub" id="live-clock"></span></div>
          <div class="card-body" id="live-plan">${planSVG({ ...drawing, tags, anchorStatus })}</div></div>
        <div class="cols cols-2">
          <div class="card"><div class="card-head"><span class="card-title">Anchor Status</span></div>
            <div class="card-body flush"><div class="table-wrap"><table class="data">
              <thead><tr><th>Anchor ID</th><th class="num">X</th><th class="num">Y</th>
                <th>Status</th><th>Battery</th></tr></thead>
              <tbody>${dev.anchors.length ? dev.anchors.map(a => `
                <tr><td>${esc(a.anchor_id)}</td><td class="num axis">${m2(a.x)}</td>
                  <td class="num axis">${m2(a.y)}</td><td>${badge(a.on)}</td>
                  <td>${battery(a.battery)}</td></tr>`).join('')
                : emptyRow(5, 'ไม่พบ anchor')}</tbody>
            </table></div></div></div>
          <div class="card"><div class="card-head"><span class="card-title">Tag Status</span></div>
            <div class="card-body flush"><div class="table-wrap"><table class="data">
              <thead><tr><th>Tag ID</th><th class="num">X</th><th class="num">Y</th>
                <th>Status</th><th>Battery</th></tr></thead>
              <tbody>${dev.tags.length ? dev.tags.map(t => `
                <tr><td>${esc(t.tag_id)}</td><td class="num axis">${m2(t.x)}</td>
                  <td class="num axis">${m2(t.y)}</td><td>${badge(t.on)}</td>
                  <td>${battery(t.battery)}</td></tr>`).join('')
                : emptyRow(5, 'ยังไม่มีแท็ก')}</tbody>
            </table></div></div></div>
        </div>
      </div>
    </div>`);
  wireFilters(pageDeviceTracking);
  startLive();
}

/* ------------------------------------------------------------------ live */
const LIVE_RECONNECT_MS = 2000;
const LIVE_POLL_MS = 1000;

function renderLiveSnapshot(live, channel) {
  if (S.live.stopped) return;
  const plan = $('#live-plan');
  if (!plan) return stopLive();
  const projectId = selectedProjectId();
  const planId = selectedPlanId();
  const tags = Object.entries(live.tags || {})
    .filter(([_id, tag]) => (!projectId || !tag.project_id || String(tag.project_id) === String(projectId))
      && (!planId || !tag.plan_id || String(tag.plan_id) === String(planId)))
    .map(([id, tag]) =>
    Object.assign({ tag_id: id, label: tag.sale_name || id }, tag));
  plan.innerHTML = planSVG({ ...(S.live.planDrawing || {}), tags, anchorStatus: S.live.anchorStatus || {} });
  const clock = $('#live-clock');
  if (clock) clock.textContent = `${channel} · อัปเดตล่าสุด ${fmtTime(live.now)}`;
}

function scheduleFallbackPoll(delay = LIVE_POLL_MS) {
  if (S.live.stopped || !S.live.fallbackActive) return;
  if (S.live.pollTimer) clearTimeout(S.live.pollTimer);
  S.live.pollTimer = setTimeout(() => {
    S.live.pollTimer = null;
    void pollLiveFallback();
  }, delay);
}

async function pollLiveFallback() {
  if (S.live.stopped || !S.live.fallbackActive) return;
  if (S.live.pollInFlight) return scheduleFallbackPoll(100);

  S.live.pollInFlight = true;
  const controller = new AbortController();
  S.live.pollAbort = controller;
  try {
    const live = await requestApi(scopedApiPath('/api/live', { rows: 0 }), { signal: controller.signal });
    if (S.live.fallbackActive && S.live.socket?.readyState !== 1) {
      renderLiveSnapshot(live, 'Polling fallback');
    }
  } catch (_error) {
    // The WebSocket reconnect loop remains active; a failed fallback request
    // should not interrupt the rest of the dashboard.
  } finally {
    if (S.live.pollAbort === controller) S.live.pollAbort = null;
    S.live.pollInFlight = false;
    scheduleFallbackPoll();
  }
}

function startFallbackPolling() {
  if (S.live.stopped || S.live.fallbackActive) return;
  S.live.fallbackActive = true;
  scheduleFallbackPoll(0);
}

function stopFallbackPolling() {
  S.live.fallbackActive = false;
  if (S.live.pollTimer) {
    clearTimeout(S.live.pollTimer);
    S.live.pollTimer = null;
  }
  if (S.live.pollAbort) {
    S.live.pollAbort.abort();
    S.live.pollAbort = null;
  }
}

function scheduleLiveReconnect() {
  if (S.live.stopped || S.live.reconnectTimer) return;
  S.live.reconnectTimer = setTimeout(() => {
    S.live.reconnectTimer = null;
    connectLiveWebSocket();
  }, LIVE_RECONNECT_MS);
}

function connectLiveWebSocket() {
  if (S.live.stopped || !S.token) return;
  if (typeof WebSocket === 'undefined') {
    startFallbackPolling();
    return;
  }
  const active = S.live.socket;
  if (active && (active.readyState === WebSocket.OPEN || active.readyState === WebSocket.CONNECTING)) return;

  let socket;
  try {
    socket = new WebSocket(websocketUrl(scopedApiPath('/ws/live')), [
      'supalai.live',
      `session.${S.token}`,
    ]);
  } catch (_error) {
    startFallbackPolling();
    scheduleLiveReconnect();
    return;
  }
  S.live.socket = socket;
  S.live.connectTimer = setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) {
      startFallbackPolling();
      socket.close();
    }
  }, LIVE_RECONNECT_MS);

  socket.onopen = () => {
    if (S.live.socket !== socket || S.live.stopped) return socket.close();
    if (S.live.connectTimer) {
      clearTimeout(S.live.connectTimer);
      S.live.connectTimer = null;
    }
    stopFallbackPolling();
  };
  socket.onmessage = event => {
    if (S.live.socket !== socket || S.live.stopped) return;
    try {
      const message = JSON.parse(event.data);
      if ((message.type === 'snapshot' || message.type === 'tags') && message.tags) {
        renderLiveSnapshot(message, 'WebSocket');
      }
    } catch (_error) { /* ignore malformed frames and keep the channel alive */ }
  };
  socket.onerror = () => {
    if (S.live.socket === socket && !S.live.stopped) startFallbackPolling();
  };
  socket.onclose = () => {
    if (S.live.socket !== socket) return;
    S.live.socket = null;
    if (S.live.connectTimer) {
      clearTimeout(S.live.connectTimer);
      S.live.connectTimer = null;
    }
    if (!S.live.stopped) {
      startFallbackPolling();
      scheduleLiveReconnect();
    }
  };
}

function startLive() {
  stopLive();
  S.live.stopped = false;
  S.live.anchorStatus = S.live.anchorStatus || {};
  S.live.fallbackActive = false;
  S.live.pollInFlight = false;
  connectLiveWebSocket();
}

function stopLive() {
  S.live.stopped = true;
  stopFallbackPolling();
  if (S.live.reconnectTimer) {
    clearTimeout(S.live.reconnectTimer);
    S.live.reconnectTimer = null;
  }
  if (S.live.connectTimer) {
    clearTimeout(S.live.connectTimer);
    S.live.connectTimer = null;
  }
  const socket = S.live.socket;
  S.live.socket = null;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Live view stopped');
}

/* --------------------------------------------------------------- plumbing */
function render(inner) {
  document.body.className = '';
  $('#app').innerHTML = shell(inner);
  const out = $('#logout');
  if (out) out.onclick = async () => {
    try { await requestApi('/api/signout', { method: 'POST' }); } catch (e) { /* going anyway */ }
    localStorage.removeItem('tw_token');
    S.token = null; S.user = null;
    location.hash = '#/signin';
  };
}

/* A row that only responds to a mouse leaves anyone on a keyboard with no way
   into the detail page at all, since nothing else links to it. */
function wireVisitRows() {
  document.querySelectorAll('tr[data-visit]').forEach(tr => {
    const go = () => {
      location.hash = '#/visit/' + encodeURIComponent(tr.dataset.visit);
    };
    tr.tabIndex = 0;
    tr.setAttribute('role', 'link');
    tr.setAttribute('aria-label', 'ดูรายละเอียดการเยี่ยมชม');
    tr.onclick = go;
    tr.onkeydown = ev => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); }
    };
  });
}

const ROUTES = {
  overview: pageOverview,
  project: pageProject,
  sales: pageSales,
  visits: pageVisits,
  devices: pageDevices,
  'device-tracking': pageDeviceTracking,
};

async function route() {
  stopLive();
  const hash = location.hash.replace(/^#\/?/, '') || 'overview';
  const [head, ...rest] = hash.split('/');

  if (!S.user) {
    if (S.token) {
      try {
        const me = await requestApi('/api/me');
        S.user = me.user;
      } catch (e) { S.user = null; }
    }
    if (!S.user) {
      S.token = null;
      localStorage.removeItem('tw_token');
      window.location.href = 'login.html';
      return;
    }
  }
  if (head === 'signin') { location.replace('login.html'); return; }
  if (!S.boot) S.boot = await requestApi('/api/bootstrap');

  S.route = head;
  try {
    if (head === 'visit') return await pageVisitDetail(decodeURIComponent(rest.join('/')));
    const fn = ROUTES[head] || pageOverview;
    await fn();
  } catch (e) {
    render(`<div class="card"><div class="card-body">
      <div class="err">โหลดหน้าไม่สำเร็จ: ${esc(e.message)}</div>
      <div class="page-sub" style="margin-top:8px">ตรวจว่า backend API ยังรันอยู่ และเชื่อมต่อฐานข้อมูลได้ปกติ</div>
    </div></div>`);
  }
}

window.addEventListener('hashchange', route);
route();
})();
