// =====================
// Dispatch App (stable)
// =====================

let map = null;
let hubMarker = null;

let stopInputs = [];
let stopMarkersByInput = new Map();

let routePolylines = [];
let vehicleColors = ["#22c55e", "#60a5fa", "#f97316", "#a78bfa", "#f43f5e", "#eab308"];
let selectedDriverIndex = null;

let lastMultiRoutes = null;

// Live driver status + live ping markers
let statusItems = [];              // from /api/dispatch/status
let statusPollTimer = null;
let driverMarkers = new Map();     // driverId -> google.maps.Marker

// Lane state
let driversState = [
  { label: "Lane 1", assignedDriverId: null, etaSeconds: 0, stopsCount: 0 },
  { label: "Lane 2", assignedDriverId: null, etaSeconds: 0, stopsCount: 0 },
];

const $ = (id) => document.getElementById(id);

function setStatus(msg) { const el = $("status"); if (el) el.textContent = msg; }
function setResult(obj) { const el = $("result"); if (!el) return; el.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2); }

function fmtTime(seconds){
  seconds = Math.max(0, Number(seconds || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function fmtLastSeen(ts){
  if (!ts) return "never";
  const diff = Math.max(0, Math.floor(Date.now()/1000 - ts));
  if (diff < 10) return "just now";
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff/60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins/60);
  return `${hrs}h ago`;
}

function isOnline(ts){
  if (!ts) return false;
  return (Date.now()/1000 - ts) < 30;
}

function clearRoutes(){
  routePolylines.forEach(r => {
    if (r.timerId) clearInterval(r.timerId);
    if (r.polyline) r.polyline.setMap(null);
  });
  routePolylines = [];
  selectedDriverIndex = null;
  lastMultiRoutes = null;
  updateSendButton();
}

function fitToAll(){
  if (!map || !window.google || !google.maps) return;
  const bounds = new google.maps.LatLngBounds();
  let any = false;

  if (hubMarker?.getPosition) { bounds.extend(hubMarker.getPosition()); any = true; }

  for (const m of stopMarkersByInput.values()){
    if (m?.getPosition) { bounds.extend(m.getPosition()); any = true; }
  }

  for (const m of driverMarkers.values()){
    if (m?.getPosition) { bounds.extend(m.getPosition()); any = true; }
  }

  if (any) map.fitBounds(bounds);
}

// ------------------- Map init -------------------
function initMapWhenReady(){
  const wait = setInterval(() => {
    if (window.google && google.maps && $("map")) {
      clearInterval(wait);

      map = new google.maps.Map($("map"), {
        center: {lat:42.3314, lng:-83.0458},
        zoom: 11,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
      });

      loadHubMarker();
    }
  }, 100);

  // If script blocked/missing, show a useful message instead of silently failing
  setTimeout(() => {
    if (!window.google || !google.maps) {
      setStatus("Google Maps did not load. Check GOOGLE_MAPS_JS_KEY and browser console (F12).");
    }
  }, 6000);
}

async function loadHubMarker(){
  try{
    const res = await fetch("/hub");
    const data = await res.json();
    if (!res.ok) return;

    const pos = { lat: data.lat, lng: data.lng };
    if (!hubMarker){
      hubMarker = new google.maps.Marker({ map, position: pos, label: "H", title: "Hub" });
    } else {
      hubMarker.setPosition(pos);
    }
    fitToAll();
  } catch(e){}
}

// ------------------- Stops UI -------------------
function rebuildStopInputs(){
  const list = $("addressList");
  if (!list) return;

  stopInputs = Array.from(list.querySelectorAll("input.stop-input"));
  stopInputs.forEach((inp, i) => inp.placeholder = `Stop ${i+1}`);

  stopInputs.forEach((inp, i) => {
    const m = stopMarkersByInput.get(inp);
    if (m) m.setLabel(String(i+1));
  });
}

function attachAutocomplete(inputEl){
  const wait = setInterval(() => {
    if (window.google && google.maps?.places?.Autocomplete) {
      clearInterval(wait);

      const ac = new google.maps.places.Autocomplete(inputEl, {
        types: ["geocode"],
        componentRestrictions: { country: "us" },
        fields: ["formatted_address", "geometry"],
      });

      ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        if (place?.formatted_address) inputEl.value = place.formatted_address;

        if (place?.geometry?.location && map){
          let marker = stopMarkersByInput.get(inputEl);
          if (!marker){
            marker = new google.maps.Marker({ map });
            stopMarkersByInput.set(inputEl, marker);
          }
          marker.setPosition(place.geometry.location);

          rebuildStopInputs();
          const idx = stopInputs.indexOf(inputEl);
          marker.setLabel(String(idx+1));
          fitToAll();
        }
      });
    }
  }, 120);
}

function addStopRow(value=""){
  const list = $("addressList");
  if (!list) return;

  const row = document.createElement("div");
  row.className = "addr-row";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "stop-input";
  input.value = value;

  const up = document.createElement("button");
  up.type = "button";
  up.className = "addr-move";
  up.textContent = "↑";

  const down = document.createElement("button");
  down.type = "button";
  down.className = "addr-move";
  down.textContent = "↓";

  const rm = document.createElement("button");
  rm.type = "button";
  rm.className = "addr-remove";
  rm.textContent = "✕";

  up.addEventListener("click", () => {
    const prev = row.previousElementSibling;
    if (prev) list.insertBefore(row, prev);
    rebuildStopInputs();
  });

  down.addEventListener("click", () => {
    const next = row.nextElementSibling;
    if (next) list.insertBefore(next, row);
    rebuildStopInputs();
  });

  rm.addEventListener("click", () => {
    const marker = stopMarkersByInput.get(input);
    if (marker) marker.setMap(null);
    stopMarkersByInput.delete(input);
    row.remove();
    rebuildStopInputs();
    fitToAll();
  });

  row.appendChild(input);
  row.appendChild(up);
  row.appendChild(down);
  row.appendChild(rm);

  list.appendChild(row);

  attachAutocomplete(input);
  rebuildStopInputs();
  return input;
}

function collectStops(){
  return stopInputs.map(i => i.value.trim()).filter(Boolean);
}

// ------------------- Lanes -------------------
function driverOptionsHtml(selectedId){
  const online = statusItems.filter(x => isOnline(x.driver?.last_seen));
  const offline = statusItems.filter(x => !isOnline(x.driver?.last_seen));

  const opts = [`<option value="">(choose driver)</option>`];

  if (online.length){
    opts.push(`<optgroup label="Online">`);
    online.forEach(item => {
      const d = item.driver;
      const sel = String(d.id) === String(selectedId) ? "selected" : "";
      opts.push(`<option value="${d.id}" ${sel}>${d.display_name}</option>`);
    });
    opts.push(`</optgroup>`);
  }

  if (offline.length){
    opts.push(`<optgroup label="Offline">`);
    offline.forEach(item => {
      const d = item.driver;
      const sel = String(d.id) === String(selectedId) ? "selected" : "";
      opts.push(`<option value="${d.id}" ${sel}>${d.display_name}</option>`);
    });
    opts.push(`</optgroup>`);
  }

  return opts.join("");
}

function renderDriversPanel(){
  const panel = $("driversPanel");
  if (!panel) return;
  panel.innerHTML = "";

  driversState.forEach((d, idx) => {
    const color = vehicleColors[idx % vehicleColors.length];

    const card = document.createElement("div");
    card.className = "driverLane";

    const top = document.createElement("div");
    top.className = "driverLaneTop";

    const dot = document.createElement("span");
    dot.className = "driverDot";
    dot.style.background = color;

    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.value = d.label;
    labelInput.className = "laneLabelInput";
    labelInput.placeholder = `Lane ${idx+1} label`;

    labelInput.addEventListener("input", () => {
      d.label = labelInput.value;
      updateSendButton();
    });

    const meta = document.createElement("div");
    meta.className = "driverMeta";
    meta.textContent = `${d.stopsCount || 0} stops • ${fmtTime(d.etaSeconds || 0)}`;

    top.appendChild(dot);
    top.appendChild(labelInput);
    top.appendChild(meta);

    const bottom = document.createElement("div");
    bottom.className = "driverLaneBottom";

    const select = document.createElement("select");
    select.className = "laneAccountSelect";
    select.innerHTML = driverOptionsHtml(d.assignedDriverId);

    select.addEventListener("change", () => {
      d.assignedDriverId = select.value ? Number(select.value) : null;
      updateSendButton();
    });

    const focusBtn = document.createElement("button");
    focusBtn.type = "button";
    focusBtn.textContent = "Focus";
    focusBtn.addEventListener("click", () => applyDriverHighlight(idx));

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "driverRemoveBtn";
    rm.textContent = "✕";
    rm.addEventListener("click", () => {
      driversState.splice(idx, 1);
      if (selectedDriverIndex === idx) applyDriverHighlight(null);
      if (selectedDriverIndex !== null && selectedDriverIndex > idx) selectedDriverIndex -= 1;
      renderDriversPanel();
      updateSendButton();
    });

    bottom.appendChild(select);
    bottom.appendChild(focusBtn);
    bottom.appendChild(rm);

    card.appendChild(top);
    card.appendChild(bottom);

    panel.appendChild(card);
  });
}

function addLane(){
  const n = driversState.length + 1;
  driversState.push({ label: `Lane ${n}`, assignedDriverId: null, etaSeconds: 0, stopsCount: 0 });
  renderDriversPanel();
  updateSendButton();
}

function collectLaneLabels(){
  return driversState.map(d => (d.label || "").trim()).filter(Boolean);
}

function allAssignedForMulti(routesCount){
  for (let i = 0; i < routesCount; i++){
    if (!driversState[i] || !driversState[i].assignedDriverId) return false;
  }
  return true;
}

// ------------------- Route drawing -------------------
function buildFullPathFromLegs(rawLegs){
  if (!google.maps?.geometry?.encoding) return [];
  const fullPath = [];
  rawLegs.forEach(leg => {
    (leg.steps || []).forEach(step => {
      const pts = step?.polyline?.points;
      if (pts){
        const decoded = google.maps.geometry.encoding.decodePath(pts);
        decoded.forEach(p => fullPath.push(p));
      }
    });
  });
  return fullPath;
}

function drawAnimatedRouteFromLegs(rawLegs, color, driverIndex){
  if (!map || !google.maps?.geometry?.encoding) return;

  const fullPath = buildFullPathFromLegs(rawLegs);
  if (!fullPath.length) return;

  const poly = new google.maps.Polyline({
    map,
    path: [],
    geodesic: true,
    strokeOpacity: 0.95,
    strokeWeight: 5,
    strokeColor: color,
    zIndex: 10,
  });

  let i = 0;
  const stepSize = Math.max(2, Math.floor(fullPath.length / 150));

  const timerId = setInterval(() => {
    i += stepSize;
    poly.setPath(fullPath.slice(0, Math.min(i, fullPath.length)));
    if (i >= fullPath.length) clearInterval(timerId);
  }, 16);

  routePolylines.push({ polyline: poly, timerId, driverIndex, color });
}

function applyDriverHighlight(driverIndex){
  selectedDriverIndex = driverIndex;

  routePolylines.forEach(r => {
    if (!r.polyline) return;
    const isSelected = (driverIndex === null || r.driverIndex === driverIndex);
    r.polyline.setOptions({
      strokeOpacity: isSelected ? 0.95 : 0.18,
      strokeWeight: isSelected ? 6 : 4,
      zIndex: isSelected ? 20 : 5,
    });
  });
}

// ------------------- ETA + Summary -------------------
function setETA(totalSeconds, breakdownLines){
  const totalEl = $("etaTotal");
  if (totalEl) totalEl.textContent = totalSeconds ? fmtTime(totalSeconds) : "—";

  const box = $("etaBreakdown");
  if (!box) return;
  box.innerHTML = "";
  (breakdownLines || []).forEach(line => {
    const div = document.createElement("div");
    div.className = "etaLine";
    div.innerHTML = `<span>${line.left}</span><span>${line.right}</span>`;
    box.appendChild(div);
  });
}

function setSummary(text){
  const el = $("summaryText");
  if (el) el.textContent = text || "No route yet.";
}

// ------------------- Live driver markers (pings) -------------------
function updateDriverMarkersFromStatus(){
  if (!map || !window.google || !google.maps) return;

  const seen = new Set();

  statusItems.forEach(item => {
    const d = item.driver;
    if (!d) return;

    const id = d.id;
    const lat = d.last_lat;
    const lng = d.last_lng;

    const online = d.last_seen && ((Date.now()/1000 - d.last_seen) < 60);
    const recentLoc = d.last_loc_at && ((Date.now()/1000 - d.last_loc_at) < 60);

    if (!online || !recentLoc || lat == null || lng == null) return;

    seen.add(id);

    const pos = { lat: Number(lat), lng: Number(lng) };
    let marker = driverMarkers.get(id);

    const label = (d.display_name || "").trim();
    const shortLabel = label.length > 3 ? label.slice(0,3) : label;

    if (!marker){
      marker = new google.maps.Marker({
        map,
        position: pos,
        title: d.display_name,
        label: shortLabel || "D",
      });
      driverMarkers.set(id, marker);
    } else {
      marker.setPosition(pos);
    }
  });

  for (const [id, marker] of driverMarkers.entries()){
    if (!seen.has(id)){
      marker.setMap(null);
      driverMarkers.delete(id);
    }
  }
}

// ------------------- Dispatch status list -------------------
async function refreshStatusList(){
  const box = $("driverStatusList");
  if (!box) return;

  try{
    const res = await fetch("/api/dispatch/status");
    const data = await res.json();
    if (!res.ok) throw new Error(data?.detail || "Failed to load status.");

    statusItems = data.items || [];

    // update dropdowns + map markers
    renderDriversPanel();
    updateSendButton();
    updateDriverMarkersFromStatus();

    box.innerHTML = "";
    statusItems.forEach(item => {
      const d = item.driver;
      const a = item.assignment;
      const online = isOnline(d.last_seen);

      const row = document.createElement("div");
      row.className = "statusRow";

      const left = document.createElement("div");
      left.className = "statusLeft";
      left.innerHTML = `
        <div class="statusName">
          <span class="statusDot ${online ? "on" : "off"}"></span>
          ${d.display_name}
          <span class="statusSub">(@${d.username})</span>
        </div>
        <div class="statusSub">Last seen: ${fmtLastSeen(d.last_seen)}</div>
      `;

      const right = document.createElement("div");
      right.className = "statusRight";

      if (!a){
        right.innerHTML = `<div class="statusPct">—</div><div class="statusSub">No route</div>`;
      } else {
        const p = a.progress || {percent:0, completed_count:0, total:0};
        right.innerHTML = `
          <div class="statusPct">${p.percent || 0}%</div>
          <div class="statusSub">${p.completed_count || 0}/${p.total || 0} stops • ${a.status}</div>
        `;
      }

      row.appendChild(left);
      row.appendChild(right);
      box.appendChild(row);
    });

  } catch(e){
    box.innerHTML = `<div class="small">Status error: ${String(e)}</div>`;
  }
}

function startStatusPolling(){
  if (statusPollTimer) clearInterval(statusPollTimer);
  refreshStatusList();
  statusPollTimer = setInterval(refreshStatusList, 5000);
}

// ------------------- Solve + Send -------------------
function updateSendButton(){
  const btn = $("sendRoutesBtn");
  const hint = $("sendRoutesHint");
  if (!btn) return;

  const haveRoutes = Array.isArray(lastMultiRoutes) && lastMultiRoutes.length > 0;
  const assigned = haveRoutes ? allAssignedForMulti(lastMultiRoutes.length) : false;

  btn.disabled = !(haveRoutes && assigned);

  if (hint) {
    if (!haveRoutes) hint.textContent = "Solve Multi first, then send.";
    else if (!assigned) hint.textContent = "Assign every lane to a driver before sending.";
    else hint.textContent = "Ready to send. This will push the ordered routes to drivers.";
  }
}

async function sendRoutesToDrivers(){
  if (!Array.isArray(lastMultiRoutes) || !lastMultiRoutes.length){
    setStatus("Solve Multi first.");
    return;
  }
  if (!allAssignedForMulti(lastMultiRoutes.length)){
    setStatus("Assign each lane to a driver before sending.");
    return;
  }

  try{
    setStatus("Sending routes to drivers...");

    const payloadRoutes = lastMultiRoutes.map((r, idx) => ({
      ...r,
      driver_id: driversState[idx].assignedDriverId,
      driver_label: (driversState[idx].label || r.driver || `Lane ${idx+1}`).trim(),
    }));

    const res = await fetch("/api/dispatch/send_routes", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ routes: payloadRoutes }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.detail || "Send failed.");

    setStatus(`Sent ${data.sent?.length || 0} route(s).`);
    await refreshStatusList();
  } catch(e){
    setStatus(`Send failed: ${String(e)}`);
  }
}

async function solveSingle(){
  try{
    setStatus("Solving (single)...");
    setResult("");
    clearRoutes();

    const stops = collectStops();
    if (!stops.length) throw new Error("Add at least 1 stop.");

    const res = await fetch("/solve/route", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ stops }),
    });

    const data = await res.json();
    if (!res.ok){
      setStatus("Solve failed.");
      setResult(data);
      return;
    }

    setStatus("Solved.");
    setResult(data);

    if (Array.isArray(data.raw_legs) && data.raw_legs.length && window.google){
      drawAnimatedRouteFromLegs(data.raw_legs, vehicleColors[0], 0);
      applyDriverHighlight(null);
    }

    const totalSec = data?.totals?.duration_in_traffic_seconds ?? data?.totals?.duration_seconds ?? 0;
    setETA(totalSec, [{ left: "Single route", right: fmtTime(totalSec) }]);
    setSummary(`Single route solved. Total ETA: ${fmtTime(totalSec)}.`);
    fitToAll();

  } catch(e){
    setStatus("Error.");
    setResult(String(e));
  }
}

async function solveMulti(){
  try{
    setStatus("Solving (multi)...");
    setResult("");
    clearRoutes();

    const stops = collectStops();
    if (!stops.length) throw new Error("Add at least 1 stop.");

    const labels = collectLaneLabels();
    if (!labels.length) throw new Error("Add at least 1 lane.");

    const res = await fetch("/solve/multi", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ driver_names: labels, stops }),
    });

    const data = await res.json();
    if (!res.ok){
      setStatus("Solve failed.");
      setResult(data);
      return;
    }

    setStatus("Solved (multi).");
    setResult(data);

    const routes = data.routes || [];
    const breakdown = [];
    const total = data.total_duration_in_traffic_seconds ?? data.total_duration_seconds ?? 0;

    routes.forEach((r, idx) => {
      if (!driversState[idx]) return;
      const secs = r.duration_in_traffic_seconds ?? r.duration_seconds ?? 0;
      driversState[idx].etaSeconds = secs;
      driversState[idx].stopsCount = (r.stops || []).length;
    });
    renderDriversPanel();

    routes.forEach((r, idx) => {
      const color = vehicleColors[idx % vehicleColors.length];
      const secs = r.duration_in_traffic_seconds ?? r.duration_seconds ?? 0;
      breakdown.push({ left: r.driver || `Lane ${idx+1}`, right: fmtTime(secs) });

      if (Array.isArray(r.raw_legs) && r.raw_legs.length && window.google){
        drawAnimatedRouteFromLegs(r.raw_legs, color, idx);
      }
    });

    setETA(total, breakdown);
    setSummary(`Multi routes created for ${routes.length} lanes. Combined ETA: ${fmtTime(total)}.`);
    fitToAll();

    lastMultiRoutes = routes;
    updateSendButton();

  } catch(e){
    setStatus("Error.");
    setResult(String(e));
  }
}

// ------------------- Boot -------------------
document.addEventListener("DOMContentLoaded", async () => {
  try{
    initMapWhenReady();

    $("addAddressBtn")?.addEventListener("click", () => addStopRow(""));
    $("addDriverBtn")?.addEventListener("click", () => addLane());
    $("solveSingleBtn")?.addEventListener("click", solveSingle);
    $("solveMultiBtn")?.addEventListener("click", solveMulti);
    $("sendRoutesBtn")?.addEventListener("click", sendRoutesToDrivers);

    // Always create default rows (even if maps fails)
    addStopRow("");
    addStopRow("");
    addStopRow("");

    renderDriversPanel();

    setStatus("Ready.");
    setETA(0, []);
    setSummary("No route yet.");
    updateSendButton();

    startStatusPolling();
  } catch (e){
    setStatus("Dispatch JS crashed. Open console (F12) to see the error.");
    setResult(String(e));
  }
});