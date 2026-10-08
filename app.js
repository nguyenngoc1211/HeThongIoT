/**
 * FireRoute – Emergency Command Center
 * app.js — Main application
 *
 * Sections:
 * 1. Constants & Topology
 * 2. State
 * 3. Utilities
 * 4. Dijkstra
 * 5. Data normalization
 * 6. Render: System status
 * 7. Render: SVG Map (rooms, edges, nodes, particles)
 * 8. Render: Route panel
 * 9. Render: Zone detail
 * 10. Render: Sensor grid
 * 11. Render: History
 * 12. Tooltip
 * 13. Demo engine (scenarios, auto-play, gradual fire)
 * 14. Firebase
 * 15. Events & Init
 */

// ════════════════════════════════════════════════════════════
// 1. CONSTANTS & TOPOLOGY
// ════════════════════════════════════════════════════════════

const ZONES = ["A", "B", "C", "D", "E", "F"];
const EXITS = ["G1", "G2"];
const ALL_NODES = [...ZONES, ...EXITS];

const EDGES = [
  ["A", "C", 2], ["B", "C", 2], ["C", "D", 2],
  ["D", "E", 2], ["D", "F", 2], ["C", "G1", 1], ["F", "G2", 1],
  ["A", "E", 3], ["B", "F", 3], ["E", "G1", 1],
];

// SVG positions (viewBox 0 0 800 520)
const POS = {
  A:  [175, 105], B:  [540, 105], C:  [360, 200],
  D:  [360, 355], E:  [175, 440], F:  [540, 440],
  G1: [95, 200],  G2: [700, 440],
};

// Room areas for floor-plan feel
const ROOMS = [
  { id:"A", x:115, y:55,  w:120, h:100, label:"PHÒNG A" },
  { id:"B", x:480, y:55,  w:120, h:100, label:"PHÒNG B" },
  { id:"C", x:295, y:160, w:130, h:80,  label:"HÀNH LANG" },
  { id:"D", x:295, y:315, w:130, h:80,  label:"NÚT GIAO" },
  { id:"E", x:115, y:390, w:120, h:100, label:"PHÒNG E" },
  { id:"F", x:480, y:390, w:120, h:100, label:"PHÒNG F" },
];

const TEMP_WARN = 48, TEMP_FIRE = 55;
const SMOKE_WARN = 1400, SMOKE_FIRE = 1800;
const STALE_MS = 30000;

// ════════════════════════════════════════════════════════════
// 2. STATE
// ════════════════════════════════════════════════════════════

// Chỉ dùng để kiểm tra chi tiết trên dashboard, không phải điểm xuất phát của hệ thống.
let selectedZone = null;
let isMockMode = false;
let autoPlaying = false;
let autoPlayAbort = false;
let particleRAF = null;
let particles = [];
let previousValues = {};

let state = {
  current: {
    system: { status: "SAFE", lastUpdated: Date.now() },
    zones: {}, routes: {},
  },
  fireHistory: {},
};
ZONES.forEach(id => {
  const t = 28 + Math.random() * 4;
  state.current.zones[id] = { temperature: +t.toFixed(1), smoke: 100 + Math.floor(Math.random() * 40), fire: false };
});

// ════════════════════════════════════════════════════════════
// 3. UTILITIES
// ════════════════════════════════════════════════════════════

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
function setText(s, t) { const el = $(s); if (el) el.textContent = t; }
function escapeHtml(v) { const d = document.createElement("div"); d.appendChild(document.createTextNode(String(v))); return d.innerHTML; }
function formatTime(ts) { if (!ts) return "--:--"; const d = new Date(ts); return isNaN(d) ? "--:--" : d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }); }
function formatDate(ts) { if (!ts) return "--"; const d = new Date(ts); return isNaN(d) ? "--" : d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }); }
function formatDT(ts) { return ts ? `${formatDate(ts)} ${formatTime(ts)}` : "--"; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function wait(ms) { return new Promise(r => { const id = setTimeout(r, ms); if (autoPlayAbort) { clearTimeout(id); r(); } }); }

// ════════════════════════════════════════════════════════════
// 4. DIJKSTRA
// ════════════════════════════════════════════════════════════

function computeRoutes(zones) {
  const blocked = new Set(Object.entries(zones).filter(([, d]) => d && d.fire).map(([id]) => id));
  const routes = {};
  for (const start of ZONES) {
    const dist = {}, prev = {}, pend = new Set();
    // Người ở zone cháy vẫn phải được dẫn ra. Zone cháy chỉ bị cấm khi là đích/trung gian.
    ALL_NODES.forEach(id => { dist[id] = Infinity; if (!blocked.has(id) || id === start) pend.add(id); });
    dist[start] = 0;
    while (pend.size) {
      let mn = null, md = Infinity;
      for (const id of pend) if (dist[id] < md) { md = dist[id]; mn = id; }
      if (!mn || !Number.isFinite(md)) break;
      pend.delete(mn);
      for (const [a, b, c] of EDGES) {
        const nb = a === mn ? b : b === mn ? a : null;
        if (!nb || !pend.has(nb)) continue;
        const cd = dist[mn] + c;
        if (cd < dist[nb]) { dist[nb] = cd; prev[nb] = mn; }
      }
    }
    const ex = dist.G1 <= dist.G2 ? (Number.isFinite(dist.G1) ? "G1" : Number.isFinite(dist.G2) ? "G2" : null) : (Number.isFinite(dist.G2) ? "G2" : Number.isFinite(dist.G1) ? "G1" : null);
    if (!ex || !Number.isFinite(dist[ex])) { routes[start] = { status: "NO_PATH", exit: null, cost: null, nodes: [] }; continue; }
    const path = []; let cur = ex; while (cur) { path.unshift(cur); if (cur === start) break; cur = prev[cur]; }
    routes[start] = { status: blocked.has(start) ? "FIRE" : "AVAILABLE", exit: ex, cost: dist[ex], nodes: path };
  }
  return routes;
}

// ════════════════════════════════════════════════════════════
// 5. NORMALIZE
// ════════════════════════════════════════════════════════════

function normalize(data) {
  const sys = data?.current?.system || state.current.system;
  const zones = data?.current?.zones || {};
  const routes = data?.current?.routes || {};
  const hist = data?.fireHistory || {};
  ZONES.forEach(id => { if (!zones[id]) zones[id] = { temperature: 0, smoke: 0, fire: false }; });
  const calculated = computeRoutes(zones);
  const completeRoutes = {};
  ZONES.forEach(id => {
    const incoming = routes[id];
    // Tương thích firmware cũ từng trả route rỗng cho chính zone cháy.
    completeRoutes[id] = incoming && (!zones[id].fire || incoming.nodes?.length > 1) ? incoming : calculated[id];
  });
  state = {
    current: { system: { status: sys.status || "SAFE", lastUpdated: sys.lastUpdated || Date.now() }, zones, routes: completeRoutes },
    fireHistory: hist,
  };
  render();
}

function recalcState() {
  const fz = ZONES.filter(id => state.current.zones[id]?.fire);
  state.current.system.status = fz.length ? "FIRE" : "SAFE";
  state.current.system.lastUpdated = Date.now();
  state.current.routes = computeRoutes(state.current.zones);
}

// ════════════════════════════════════════════════════════════
// 6. RENDER: SYSTEM STATUS
// ════════════════════════════════════════════════════════════

function renderStatus() {
  const { system, zones, routes } = state.current;
  const fz = ZONES.filter(id => zones[id]?.fire);
  const isFire = system.status === "FIRE" || fz.length > 0;

  // Emergency banner
  const banner = $("#emergencyBanner");
  const glow = $("#emergencyGlow");
  if (isFire) {
    banner?.classList.add("visible"); banner && (banner.hidden = false);
    glow?.classList.add("active");
    setText("#emergencyDetail", `Phát hiện tại ${fz.map(z => "Zone " + z).join(", ")}`);
  } else {
    banner?.classList.remove("visible");
    glow?.classList.remove("active");
    setTimeout(() => { if (banner && !banner.classList.contains("visible")) banner.hidden = true; }, 600);
  }

  // Health strip fire
  const hf = $("#healthFire");
  if (hf) { hf.classList.toggle("fire-active", fz.length > 0); }
  setText("#fireCount", String(fz.length));
  setText("#fireText", fz.length ? fz.map(z => z).join(", ") : "zone");

  // Exits
  const exits = new Set();
  Object.values(routes).forEach(r => { if ((r?.status === "AVAILABLE" || r?.status === "FIRE") && r?.exit) exits.add(r.exit); });
  setText("#exitCount", `${exits.size}/2`);
  setText("#exitNames", exits.size ? [...exits].join(" · ") : "—");
  setText("#updateTime", formatTime(system.lastUpdated));
  setText("#updateDate", formatDate(system.lastUpdated));
}

// ════════════════════════════════════════════════════════════
// 7. RENDER: SVG MAP
// ════════════════════════════════════════════════════════════

function renderMap() {
  const container = $("#floorMap");
  if (!container) return;

  const inspectedRoute = selectedZone ? state.current.routes[selectedZone]?.nodes || [] : [];
  const inspectedEdges = new Set();
  for (let i = 1; i < inspectedRoute.length; i++) inspectedEdges.add([inspectedRoute[i - 1], inspectedRoute[i]].sort().join("-"));
  const blocked = new Set(Object.entries(state.current.zones).filter(([, d]) => d?.fire).map(([id]) => id));
  const usedExits = new Set(Object.values(state.current.routes).filter(r => r?.nodes?.length > 1).map(r => r.exit));

  let svg = `<svg viewBox="0 0 800 520" xmlns="http://www.w3.org/2000/svg" aria-label="Sơ đồ mặt bằng">`;

  svg += `<defs>
    <filter id="glow-g" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="glow-r" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="5"/></filter>
    <filter id="glow-o" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3"/></filter>
    <marker id="guide-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L8,4 L0,8 Z" fill="#00e676"/></marker>
    <marker id="urgent-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L8,4 L0,8 Z" fill="#ff9100"/></marker>
  </defs>`;

  // Room areas
  for (const room of ROOMS) {
    const isFire = blocked.has(room.id);
    svg += `<rect class="room-area${isFire ? " room-fire" : ""}" x="${room.x}" y="${room.y}" width="${room.w}" height="${room.h}"/>`;
    svg += `<text class="room-label" x="${room.x + room.w / 2}" y="${room.y + room.h - 8}">${room.label}</text>`;
  }

  // Exit markers (door shapes)
  for (const eid of EXITS) {
    const [x, y] = POS[eid];
    svg += `<rect x="${x - 20}" y="${y - 14}" width="40" height="28" rx="4" fill="none" stroke="rgba(0,191,165,0.2)" stroke-width="1" stroke-dasharray="3 3"/>`;
  }

  for (const [a, b] of EDGES) {
    const [x1, y1] = POS[a], [x2, y2] = POS[b];
    const isBlocked = blocked.has(a) || blocked.has(b);
    let cls = "edge-line edge-draw";
    if (isBlocked) cls += " blocked";
    svg += `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }

  // Tuyến đầy đủ chỉ là lớp kiểm tra khi admin click một zone.
  for (const [a, b] of EDGES) {
    const key = [a, b].sort().join("-");
    if (!inspectedEdges.has(key)) continue;
    const [x1, y1] = POS[a], [x2, y2] = POS[b];
    const idxA = inspectedRoute.indexOf(a), idxB = inspectedRoute.indexOf(b);
    let fx, fy, tx, ty;
    if (idxA >= 0 && idxB >= 0 && idxA < idxB) { fx = x1; fy = y1; tx = x2; ty = y2; }
    else { fx = x2; fy = y2; tx = x1; ty = y1; }
    svg += `<line class="inspect-route" x1="${fx}" y1="${fy}" x2="${tx}" y2="${ty}"/>`;
  }

  // Một mũi tên next-hop cho từng zone: đây là chỉ dẫn mà LED tại zone đó thể hiện.
  for (const zone of ZONES) {
    const route = state.current.routes[zone];
    if (!route?.nodes || route.nodes.length < 2) continue;
    const next = route.nodes[1];
    const [sx, sy] = POS[zone], [tx, ty] = POS[next];
    const dx = tx - sx, dy = ty - sy, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const x1 = sx + ux * 31, y1 = sy + uy * 31;
    const x2 = tx - ux * (next.startsWith("G") ? 30 : 34), y2 = ty - uy * (next.startsWith("G") ? 30 : 34);
    const urgent = !!state.current.zones[zone]?.fire;
    svg += `<g class="zone-guidance${urgent ? " urgent" : ""}" data-guide-zone="${zone}">`;
    svg += `<line class="guidance-halo" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    svg += `<line class="guidance-arrow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#${urgent ? "urgent-arrow" : "guide-arrow"})"/>`;
    svg += `<text class="next-hop-label" x="${sx}" y="${sy + 45}">ĐI ${next} · ${route.exit}</text>`;
    svg += `</g>`;
  }

  // Nodes
  for (let i = 0; i < ALL_NODES.length; i++) {
    const id = ALL_NODES[i];
    const [x, y] = POS[id];
    const isExit = id.startsWith("G");
    const fire = state.current.zones[id]?.fire;
    const onRoute = inspectedRoute.includes(id);
    const isSel = id === selectedZone && !isExit;
    const isRouteExit = isExit && usedExits.has(id);

    const cls = ["node-group"];
    if (isExit) cls.push("exit");
    if (fire) cls.push("fire");
    if (onRoute) cls.push("on-route");
    if (isSel) cls.push("selected");

    const r = isExit ? 18 : 20;
    const delay = i * 0.08 + 0.4;

    svg += `<g class="${cls.join(" ")} node-anim" data-node="${id}" style="transition-delay:${delay}s;transform-origin:${x}px ${y}px" ${!isExit ? `role="button" tabindex="0" aria-label="Zone ${id}${fire ? " – cháy" : ""}"` : `aria-label="Cửa thoát ${id}"`}>`;

    // Outer ring
    svg += `<circle class="node-ring" cx="${x}" cy="${y}" r="${r + 8}"/>`;

    // Fire pulses
    if (fire && !isExit) {
      svg += `<circle class="fire-pulse fire-pulse-1" cx="${x}" cy="${y}" r="20"/>`;
      svg += `<circle class="fire-pulse fire-pulse-2" cx="${x}" cy="${y}" r="20"/>`;
      svg += `<circle class="fire-pulse fire-pulse-3" cx="${x}" cy="${y}" r="20"/>`;
    }

    // Exit beacon
    if (isRouteExit) {
      svg += `<circle class="exit-beacon" cx="${x}" cy="${y}" r="24"/>`;
    }

    // Main circle
    svg += `<circle class="node-bg" cx="${x}" cy="${y}" r="${r}"/>`;
    svg += `<text class="node-text" x="${x}" y="${y}">${id}</text>`;

    svg += `</g>`;
  }

  // Particle container
  svg += `<g id="particleLayer"></g>`;

  svg += `</svg>`;
  container.innerHTML = svg;

  // Event handlers
  container.querySelectorAll(".node-group[data-node]").forEach(g => {
    const nid = g.dataset.node;
    if (!ZONES.includes(nid)) return;
    g.addEventListener("click", () => selectZone(nid));
    g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectZone(nid); } });
    g.addEventListener("mouseenter", e => showTooltip(nid, e));
    g.addEventListener("mousemove", e => moveTooltip(e));
    g.addEventListener("mouseleave", hideTooltip);
  });
  // Exit tooltips
  container.querySelectorAll(".node-group.exit").forEach(g => {
    const nid = g.dataset.node;
    g.addEventListener("mouseenter", e => showExitTooltip(nid, e));
    g.addEventListener("mousemove", e => moveTooltip(e));
    g.addEventListener("mouseleave", hideTooltip);
  });

  startParticles(inspectedRoute);
}

// ── Route particles ──
function startParticles(routeNodes) {
  stopParticles();
  if (routeNodes.length < 2) return;

  // Build path segments
  const segs = [];
  let totalLen = 0;
  for (let i = 1; i < routeNodes.length; i++) {
    const [x1, y1] = POS[routeNodes[i - 1]], [x2, y2] = POS[routeNodes[i]];
    const len = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
    segs.push({ x1, y1, x2, y2, len, cum: totalLen });
    totalLen += len;
  }
  if (totalLen < 1) return;

  const layer = document.getElementById("particleLayer");
  if (!layer) return;

  // Spawn 4 particles staggered
  const count = 4;
  for (let i = 0; i < count; i++) {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("r", "4");
    c.setAttribute("class", "route-particle");
    c.setAttribute("opacity", "0");
    layer.appendChild(c);
    particles.push({ el: c, progress: i / count });
  }

  function animate() {
    for (const p of particles) {
      p.progress += 0.004;
      if (p.progress > 1) p.progress -= 1;
      const d = p.progress * totalLen;
      let seg = segs[segs.length - 1];
      for (const s of segs) { if (s.cum + s.len >= d) { seg = s; break; } }
      const t = (d - seg.cum) / seg.len;
      const x = seg.x1 + (seg.x2 - seg.x1) * t;
      const y = seg.y1 + (seg.y2 - seg.y1) * t;
      p.el.setAttribute("cx", x);
      p.el.setAttribute("cy", y);
      const fade = Math.min(p.progress * 6, (1 - p.progress) * 6, 1);
      p.el.setAttribute("opacity", String(fade * 0.85));
    }
    particleRAF = requestAnimationFrame(animate);
  }
  particleRAF = requestAnimationFrame(animate);
}

function stopParticles() {
  if (particleRAF) { cancelAnimationFrame(particleRAF); particleRAF = null; }
  particles.forEach(p => p.el?.remove());
  particles = [];
}

// ════════════════════════════════════════════════════════════
// 8. RENDER: ROUTE PANEL
// ════════════════════════════════════════════════════════════

function renderRoute() {
  const c = $("#routeDetail");
  if (!c) return;
  setText("#routeTitle", selectedZone ? `Đang kiểm tra Zone ${selectedZone}` : "Tất cả khu vực");

  let h = `<p class="all-route-note">Hệ thống đang tính đồng thời cho cả 6 zone. Chọn một dòng để xem toàn bộ tuyến trên bản đồ.</p><div class="all-routes">`;
  for (const zone of ZONES) {
    const route = state.current.routes[zone];
    const fire = !!state.current.zones[zone]?.fire;
    const hasPath = route?.nodes?.length > 1 && route?.exit;
    const next = hasPath ? route.nodes[1] : null;
    const statusClass = !hasPath ? "no-path" : fire ? "evacuate" : "available";
    const statusText = !hasPath ? "KHÔNG CÓ ĐƯỜNG" : fire ? "RỜI ĐI NGAY" : "AN TOÀN";
    h += `<button class="all-route-row ${statusClass}${selectedZone === zone ? " selected" : ""}" data-route-zone="${zone}" type="button" aria-label="Xem tuyến từ Zone ${zone}">`;
    h += `<span class="arr-zone">${zone}</span>`;
    h += `<span class="arr-direction">${hasPath ? `đi <strong>${escapeHtml(next)}</strong> <i>→</i> ${escapeHtml(route.exit)}` : "Chờ cứu hộ"}</span>`;
    h += `<span class="arr-status">${statusText}</span></button>`;
  }
  h += `</div>`;

  if (selectedZone) {
    const route = state.current.routes[selectedZone];
    h += `<div class="inspected-route"><div class="inspected-head"><span>TOÀN BỘ TUYẾN ${selectedZone}</span><button id="clearInspection" type="button">Hiện toàn tầng</button></div>`;
    if (route?.nodes?.length > 1) {
      h += `<div class="route-path">${route.nodes.map((n, i) => `${i ? `<span class="route-arrow">→</span>` : ""}<span class="route-node${n.startsWith("G") ? " exit-n" : ""}">${escapeHtml(n)}</span>`).join("")}</div>`;
    } else {
      h += `<div class="route-warn"><p>Không còn tuyến an toàn từ Zone ${selectedZone}. Hãy đóng cửa và chờ cứu hộ.</p></div>`;
    }
    h += `</div>`;
  }
  c.innerHTML = h;
  c.querySelectorAll("[data-route-zone]").forEach(row => row.addEventListener("click", () => selectZone(row.dataset.routeZone)));
  $("#clearInspection")?.addEventListener("click", () => { selectedZone = null; render(); });
}

// ════════════════════════════════════════════════════════════
// 9. RENDER: ZONE DETAIL
// ════════════════════════════════════════════════════════════

function renderZoneDetail() {
  const c = $("#zoneDetail");
  if (!c) return;
  if (!selectedZone) {
    setText("#zoneDetailTitle", "Cách đọc chỉ dẫn");
    c.innerHTML = `<div class="overview-help"><span class="help-arrow">→</span><p><strong>Không cần chọn nơi xuất phát.</strong><br/>Ở mỗi khu vực, hãy đi theo mũi tên xanh tại khu vực đó. Mũi tên cam yêu cầu rời zone cháy ngay lập tức.</p></div>`;
    return;
  }
  setText("#zoneDetailTitle", `Zone ${selectedZone}`);

  const d = state.current.zones[selectedZone] || { temperature: 0, smoke: 0, fire: false };
  const temp = Number(d.temperature) || 0;
  const smoke = Number(d.smoke) || 0;
  const fire = !!d.fire;
  const hiT = temp >= TEMP_WARN, hiS = smoke >= SMOKE_WARN;

  const tPct = clamp(temp / 100 * 100, 0, 100);
  const sPct = clamp(smoke / 3000 * 100, 0, 100);
  const tCls = fire || temp >= TEMP_FIRE ? "danger" : hiT ? "warn" : "safe";
  const sCls = fire || smoke >= SMOKE_FIRE ? "danger" : hiS ? "warn" : "safe";

  let statusCls, statusText;
  if (fire) { statusCls = "fire"; statusText = "CHÁY"; }
  else if (hiT || hiS) { statusCls = "warn"; statusText = "CẢNH BÁO"; }
  else { statusCls = "safe"; statusText = "AN TOÀN"; }

  c.innerHTML = `
    <div class="zd-row"><span class="zd-label"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 14.76V3.5a2.5 2.5 0 00-5 0v11.26a4.5 4.5 0 105 0z"/></svg>Nhiệt độ</span><span class="zd-value${hiT || fire ? " high" : ""} mono">${temp.toFixed(1)}°C</span></div>
    <div class="zd-gauge"><div class="zd-gauge-fill ${tCls}" style="width:${tPct}%"></div></div>
    <div class="zd-row"><span class="zd-label"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M8 9s1.5 2 4 2 4-2 4-2"/><path d="M8 19s1.5 2 4 2 4-2 4-2"/></svg>ADC Khói</span><span class="zd-value${hiS || fire ? " high" : ""} mono">${smoke}</span></div>
    <div class="zd-gauge"><div class="zd-gauge-fill ${sCls}" style="width:${sPct}%"></div></div>
    <div style="margin-top:8px"><span class="zd-status ${statusCls}">${statusText}</span></div>
  `;
}

// ════════════════════════════════════════════════════════════
// 10. RENDER: SENSOR GRID
// ════════════════════════════════════════════════════════════

function renderSensors() {
  const c = $("#sensorGrid");
  if (!c) return;
  const zones = state.current.zones;
  const sortDanger = $("#sortDanger")?.checked || false;

  let ids = [...ZONES];
  if (sortDanger) ids.sort((a, b) => {
    const fa = zones[a]?.fire ? 2 : (zones[a]?.temperature >= TEMP_WARN || zones[a]?.smoke >= SMOKE_WARN) ? 1 : 0;
    const fb = zones[b]?.fire ? 2 : (zones[b]?.temperature >= TEMP_WARN || zones[b]?.smoke >= SMOKE_WARN) ? 1 : 0;
    return fb - fa;
  });

  let h = "";
  for (const id of ids) {
    const d = zones[id] || { temperature: 0, smoke: 0, fire: false };
    const temp = Number(d.temperature) || 0, smoke = Number(d.smoke) || 0, fire = !!d.fire;
    const hiT = temp >= TEMP_WARN, hiS = smoke >= SMOKE_WARN, isWarn = (hiT || hiS) && !fire;

    let cardCls = "sensor-card", badgeCls = "sb-safe", badgeText = "AN TOÀN";
    if (fire) { cardCls += " s-fire"; badgeCls = "sb-fire"; badgeText = "CHÁY"; }
    else if (isWarn) { cardCls += " s-warn"; badgeCls = "sb-warn"; badgeText = "CẢNH BÁO"; }

    h += `<article class="${cardCls}" role="listitem" data-zone="${id}" aria-label="Zone ${id} – ${badgeText}">
      <span class="sensor-id">${escapeHtml(id)}</span>
      <span class="sensor-val${hiT || fire ? " val-high" : ""}">${temp.toFixed(1)}°C</span>
      <span class="sensor-val${hiS || fire ? " val-high" : ""}">Khói ${smoke}</span>
      <span class="sensor-badge ${badgeCls}">${badgeText}</span>
    </article>`;
  }
  c.innerHTML = h;

  // Click to select zone
  c.querySelectorAll(".sensor-card[data-zone]").forEach(card => {
    card.addEventListener("click", () => selectZone(card.dataset.zone));
  });
}

// ════════════════════════════════════════════════════════════
// 11. RENDER: HISTORY
// ════════════════════════════════════════════════════════════

function renderHistory() {
  const c = $("#historyContent");
  if (!c) return;

  const entries = Object.entries(state.fireHistory || {}).filter(([, i]) => i && i.zone).sort(([, a], [, b]) => (b.time_start || 0) - (a.time_start || 0));

  if (!entries.length) {
    c.innerHTML = `<div class="empty-state"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg><p>Chưa có sự cố nào được ghi nhận.</p></div>`;
    return;
  }

  let h = "";
  for (const [, item] of entries) {
    const active = !item.time_end;
    h += `<article class="history-row">
      <span class="h-icon ${active ? "h-active" : "h-done"}">${active ? "!" : "✓"}</span>
      <div class="h-content">
        <strong>Cảnh báo tại Zone ${escapeHtml(item.zone || "?")}</strong>
        <small>${formatDT(item.time_start)} ${active ? `<span class="h-badge h-live">Đang diễn ra</span>` : `<span class="h-badge h-resolved">Kết thúc</span> ${formatDT(item.time_end)}`}</small>
      </div>
    </article>`;
  }
  c.innerHTML = h;
}

// ════════════════════════════════════════════════════════════
// MASTER RENDER
// ════════════════════════════════════════════════════════════

function render() {
  renderStatus();
  renderMap();
  renderRoute();
  renderZoneDetail();
  renderSensors();
  renderHistory();
  if (isMockMode) renderDemoZones();
}

function selectZone(id) {
  if (!ZONES.includes(id)) return;
  selectedZone = id;
  render();
}

// ════════════════════════════════════════════════════════════
// 12. TOOLTIP
// ════════════════════════════════════════════════════════════

function showTooltip(zoneId, event) {
  const tip = $("#tooltip");
  if (!tip) return;
  const d = state.current.zones[zoneId] || {};
  const temp = Number(d.temperature) || 0, smoke = Number(d.smoke) || 0, fire = !!d.fire;
  const status = fire ? "CHÁY" : (temp >= TEMP_WARN || smoke >= SMOKE_WARN) ? "CẢNH BÁO" : "AN TOÀN";
  const statusCls = fire ? "tt-fire" : (temp >= TEMP_WARN || smoke >= SMOKE_WARN) ? "tt-fire" : "tt-safe";

  tip.innerHTML = `<div class="tt-zone">Zone ${escapeHtml(zoneId)}</div>
    <div class="tt-row"><span>Nhiệt độ</span><strong>${temp.toFixed(1)}°C</strong></div>
    <div class="tt-row"><span>ADC Khói</span><strong>${smoke}</strong></div>
    <div class="tt-status ${statusCls}">${status}</div>`;
  tip.hidden = false;
  moveTooltip(event);
  requestAnimationFrame(() => tip.classList.add("visible"));
}

function showExitTooltip(exitId, event) {
  const tip = $("#tooltip");
  if (!tip) return;
  const routesUsingExit = Object.entries(state.current.routes).filter(([, r]) => r?.exit === exitId && r?.status === "AVAILABLE").map(([id]) => id);
  tip.innerHTML = `<div class="tt-zone">Cửa thoát ${escapeHtml(exitId)}</div>
    <div class="tt-row"><span>Tuyến đến đây</span><strong>${routesUsingExit.length ? routesUsingExit.join(", ") : "—"}</strong></div>`;
  tip.hidden = false;
  moveTooltip(event);
  requestAnimationFrame(() => tip.classList.add("visible"));
}

function moveTooltip(e) {
  const tip = $("#tooltip");
  if (!tip) return;
  tip.style.left = (e.clientX + 14) + "px";
  tip.style.top = (e.clientY - 10) + "px";
}

function hideTooltip() {
  const tip = $("#tooltip");
  if (!tip) return;
  tip.classList.remove("visible");
  setTimeout(() => { tip.hidden = true; }, 150);
}

// ════════════════════════════════════════════════════════════
// 13. DEMO ENGINE
// ════════════════════════════════════════════════════════════

function initMockMode() {
  isMockMode = true;
  const dot = $("#connectionDot");
  if (dot) dot.className = "conn-dot mock";
  setText("#connectionText", "Demo Mode");
  const dp = $("#demoPanel");
  if (dp) { dp.hidden = false; renderDemoZones(); }
  state.current.system.lastUpdated = Date.now();
  state.current.routes = computeRoutes(state.current.zones);
  render();
}

function renderDemoZones() {
  const c = $("#demoZones");
  if (!c) return;
  let h = "";
  for (const id of ZONES) {
    const fire = !!state.current.zones[id]?.fire;
    h += `<button class="demo-btn demo-zone${fire ? " active" : ""}" data-zone="${id}" type="button" aria-label="Toggle cháy Zone ${id}" aria-pressed="${fire}"><span class="dz-dot"></span>Zone ${id}</button>`;
  }
  c.innerHTML = h;
  c.querySelectorAll(".demo-zone").forEach(btn => btn.addEventListener("click", () => toggleFire(btn.dataset.zone)));
}

function toggleFire(zoneId) {
  const z = state.current.zones[zoneId];
  if (!z) return;
  z.fire = !z.fire;
  if (z.fire) {
    z.temperature = 60 + Math.random() * 25;
    z.smoke = 2000 + Math.floor(Math.random() * 1000);
    state.fireHistory[`-mock${Date.now()}`] = { zone: zoneId, time_start: Date.now(), time_end: null };
  } else {
    z.temperature = 28 + Math.random() * 4;
    z.smoke = 100 + Math.floor(Math.random() * 40);
    Object.values(state.fireHistory).forEach(e => { if (e.zone === zoneId && !e.time_end) e.time_end = Date.now(); });
  }
  recalcState();
  render();
}

function clearAllFires() {
  ZONES.forEach(id => {
    const z = state.current.zones[id];
    if (z?.fire) {
      z.fire = false; z.temperature = 28 + Math.random() * 4; z.smoke = 100 + Math.floor(Math.random() * 40);
      Object.values(state.fireHistory).forEach(e => { if (e.zone === id && !e.time_end) e.time_end = Date.now(); });
    }
  });
  recalcState();
  render();
}

// ── Gradual fire simulation ──
async function gradualFire(zoneId, duration = 2500) {
  const z = state.current.zones[zoneId];
  if (!z || z.fire) return;
  const startT = z.temperature, startS = z.smoke;
  const targetT = 58 + Math.random() * 25, targetS = 1900 + Math.random() * 1100;
  const t0 = performance.now();
  let fired = false;

  return new Promise(resolve => {
    function step() {
      if (autoPlayAbort) { resolve(); return; }
      const p = clamp((performance.now() - t0) / duration, 0, 1);
      const e = p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2;
      z.temperature = startT + (targetT - startT) * e;
      z.smoke = Math.round(startS + (targetS - startS) * e);
      if (p >= 0.65 && !fired) {
        fired = true;
        z.fire = true;
        state.fireHistory[`-mock${Date.now()}`] = { zone: zoneId, time_start: Date.now(), time_end: null };
        recalcState();
      }
      render();
      if (p < 1) requestAnimationFrame(step); else resolve();
    }
    requestAnimationFrame(step);
  });
}

// ── Scenarios ──
async function runScenario(num) {
  if (autoPlaying) return;
  clearAllFires();
  await wait(400);
  if (num === 1) {
    selectZone("B");
    await gradualFire("B", 2500);
  } else if (num === 2) {
    selectZone("A");
    await gradualFire("C", 2500);
    await wait(500);
    selectZone("A");
    render();
  } else if (num === 3) {
    selectZone("A");
    await gradualFire("B", 2000);
    await wait(600);
    await gradualFire("D", 2000);
    await wait(600);
    selectZone("E");
    render();
  }
}

// ── Auto-play demo ──
async function autoPlayDemo() {
  if (autoPlaying) { autoPlayAbort = true; return; }
  autoPlaying = true;
  autoPlayAbort = false;
  const btn = $("#demoAutoBtn");
  if (btn) { btn.classList.add("running"); btn.querySelector("svg + *")?.remove(); }

  const check = () => !autoPlayAbort;

  // Step 1: All safe
  clearAllFires(); selectZone("A"); render();
  if (check()) await wait(2000);

  // Step 2: Fire at B gradually
  if (check()) { selectZone("B"); await gradualFire("B", 3000); }
  if (check()) await wait(2000);

  // Step 3: Select A to show rerouting
  if (check()) { selectZone("A"); render(); }
  if (check()) await wait(2500);

  // Step 4: Also fire at C
  if (check()) { await gradualFire("C", 2500); }
  if (check()) await wait(1500);

  // Step 5: Select E, show rerouting
  if (check()) { selectZone("E"); render(); }
  if (check()) await wait(2500);

  // Step 6: Clear all
  if (check()) { clearAllFires(); selectZone("A"); render(); }
  if (check()) await wait(1500);

  autoPlaying = false;
  autoPlayAbort = false;
  if (btn) btn.classList.remove("running");
}

// ════════════════════════════════════════════════════════════
// 14. FIREBASE
// ════════════════════════════════════════════════════════════

async function connectFirebase() {
  if (!window.FIREBASE_CONFIG) { initMockMode(); return; }
  try {
    const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js");
    const { getDatabase, ref, onValue } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js");
    const db = getDatabase(initializeApp(window.FIREBASE_CONFIG));
    const dot = $("#connectionDot");
    if (dot) dot.className = "conn-dot connected";
    setText("#connectionText", "Đã kết nối Firebase");
    onValue(ref(db), snap => normalize(snap.val()), err => {
      console.error("Firebase error:", err);
      if (dot) dot.className = "conn-dot error";
      setText("#connectionText", "Lỗi kết nối");
      if (!Object.keys(state.current.routes).length) initMockMode();
    });
  } catch (err) {
    console.error("Firebase init failed:", err);
    const dot = $("#connectionDot");
    if (dot) dot.className = "conn-dot error";
    setText("#connectionText", "Lỗi – chế độ demo");
    initMockMode();
  }
}

// ════════════════════════════════════════════════════════════
// 15. EVENTS & INIT
// ════════════════════════════════════════════════════════════

function updateClock() {
  const now = new Date();
  setText("#realtimeClock", now.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
}

function checkStale() {
  const el = $("#staleWarning");
  if (!el) return;
  const age = Date.now() - (state.current.system.lastUpdated || 0);
  el.hidden = age <= STALE_MS;
}

function initEvents() {
  // Sort toggle
  $("#sortDanger")?.addEventListener("change", () => renderSensors());

  // History toggle
  $("#historyToggle")?.addEventListener("click", () => {
    const body = $("#historyContent");
    const btn = $("#historyToggle");
    if (!body || !btn) return;
    const collapsed = !body.classList.contains("collapsed");
    body.classList.toggle("collapsed", collapsed);
    btn.setAttribute("aria-expanded", String(!collapsed));
  });

  // Demo buttons
  $("#demoClearBtn")?.addEventListener("click", clearAllFires);
  $("#demoAutoBtn")?.addEventListener("click", autoPlayDemo);
  $$(".demo-btn.scenario").forEach(btn => {
    btn.addEventListener("click", () => runScenario(Number(btn.dataset.scenario)));
  });

  // Clocks & stale checks
  updateClock();
  setInterval(updateClock, 1000);
  setInterval(checkStale, 5000);
}

function init() {
  initEvents();
  state.current.routes = computeRoutes(state.current.zones);

  // Page load animation
  requestAnimationFrame(() => {
    document.body.classList.add("loaded");
  });

  connectFirebase();
}

init();
