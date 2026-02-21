const $ = (id) => document.getElementById(id);

let latestAssignment = null;
let pollTimer = null;

let map = null;
let driverMarker = null;
let directionsService = null;
let directionsRenderer = null;

let watchId = null;
let lastSentAt = 0;

function escapeHtml(s){
  return String(s || "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;");
}

async function me(){
  const res = await fetch("/api/driver/me");
  if (!res.ok) return null;
  return await res.json();
}

async function logout(){
  stopPolling();
  stopLocationWatch();
  await fetch("/api/driver/logout", { method:"POST" });
  window.location.href = "/";
}

function initMapWhenReady(){
  const wait = setInterval(() => {
    if (window.google && google.maps && $("driverMap")) {
      clearInterval(wait);

      map = new google.maps.Map($("driverMap"), {
        center: { lat: 42.3314, lng: -83.0458 },
        zoom: 12,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
      });

      directionsService = new google.maps.DirectionsService();
      directionsRenderer = new google.maps.DirectionsRenderer({
        map,
        suppressMarkers: false,
        preserveViewport: false,
      });
    }
  }, 120);
}

function renderStops(route, progress){
  const boxStops = $("routeStops");
  const stops = route?.stops || [];

  if (!stops.length){
    boxStops.innerHTML = `<div class="small">(No stops)</div>`;
    return;
  }

  const completed = (progress?.completed || []).slice();
  boxStops.innerHTML = "";

  stops.forEach((s, i) => {
    const row = document.createElement("label");
    row.className = "driverStopRow";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = Boolean(completed[i]);

    cb.addEventListener("change", async () => {
      if (!latestAssignment) return;
      row.classList.toggle("done", cb.checked);

      await fetch("/api/driver/assignment/update_stop", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          assignment_id: latestAssignment.id,
          stop_index: i,
          completed: cb.checked
        })
      });

      await loadLatestRoute(false);
    });

    const num = document.createElement("span");
    num.className = "driverStopNum";
    num.textContent = String(i + 1);

    const addr = document.createElement("span");
    addr.className = "driverStopAddr";
    addr.innerHTML = escapeHtml(s);

    row.appendChild(cb);
    row.appendChild(num);
    row.appendChild(addr);

    if (cb.checked) row.classList.add("done");
    boxStops.appendChild(row);
  });
}

function drawRouteInMap(hub, stops){
  if (!directionsService || !directionsRenderer || !hub || !Array.isArray(stops)) return;
  if (stops.length === 0) return;

  // Google Directions JS max waypoints = 25 (including intermediate). Keep it safe.
  const wp = stops.slice(0, 25).map(s => ({ location: s, stopover: true }));

  directionsService.route(
    {
      origin: hub,
      destination: hub,
      waypoints: wp,
      optimizeWaypoints: true,
      travelMode: google.maps.TravelMode.DRIVING,
      drivingOptions: {
        departureTime: new Date(),
        trafficModel: google.maps.TrafficModel.BEST_GUESS,
      },
    },
    (result, status) => {
      if (status === "OK" && result) {
        directionsRenderer.setDirections(result);
      }
    }
  );
}

async function sendLocation(lat, lng, accuracy){
  const now = Date.now();
  // throttle: at most 1 post every 3s
  if (now - lastSentAt < 3000) return;
  lastSentAt = now;

  await fetch("/api/driver/location", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ lat, lng, accuracy_m: accuracy }),
  });
}

function startLocationWatch(){
  const el = $("locStatus");
  if (!navigator.geolocation){
    el.textContent = "not supported";
    return;
  }

  el.textContent = "requesting permission…";

  watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const acc = pos.coords.accuracy;

      $("locStatus").textContent = `on (${Math.round(acc)}m)`;

      // place/update driver marker
      if (map && window.google && google.maps){
        const ll = { lat, lng };
        if (!driverMarker){
          driverMarker = new google.maps.Marker({
            map,
            position: ll,
            title: "You",
            label: "You",
          });
          map.setCenter(ll);
        } else {
          driverMarker.setPosition(ll);
        }
      }

      try { await sendLocation(lat, lng, acc); } catch(e){}
    },
    (err) => {
      $("locStatus").textContent = `off (${err.message})`;
    },
    {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: 15000,
    }
  );
}

function stopLocationWatch(){
  if (watchId !== null){
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

async function loadLatestRoute(updateTop=true){
  const who = await me();
  if (!who || !who.logged_in){
    window.location.href = "/";
    return;
  }

  const displayName = who.driver?.display_name || "Driver";
  if (updateTop){
    $("whoTitle").textContent = displayName;
    $("driverStatus").textContent = `Logged in as ${displayName}.`;
  }

  const res = await fetch("/api/driver/assignment/latest");
  const data = await res.json();

  const boxMeta = $("routeMeta");

  if (!res.ok){
    boxMeta.textContent = data?.detail || "Failed to load route.";
    return;
  }

  if (!data.assignment){
    latestAssignment = null;
    boxMeta.textContent = "No assignment yet. Ask dispatch to send your route.";
    $("routeStops").innerHTML = "";
    if (directionsRenderer) directionsRenderer.setDirections({ routes: [] });
    return;
  }

  latestAssignment = data.assignment;

  const created = new Date(data.assignment.created_at * 1000).toLocaleString();
  const route = data.assignment.route || {};
  const progress = data.assignment.progress || {};
  const stops = route.stops || [];

  boxMeta.textContent =
    `Assigned: ${created} • ${progress.completed_count || 0}/${progress.total || stops.length} done • ${progress.percent || 0}% • Status: ${data.assignment.status}`;

  renderStops(route, progress);

  // draw inside app (no external Google Maps)
  drawRouteInMap(data.assignment.hub, stops);
}

function startPolling(){
  stopPolling();
  loadLatestRoute(false);
  pollTimer = setInterval(() => loadLatestRoute(false), 5000);
}

function stopPolling(){
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

document.addEventListener("DOMContentLoaded", async () => {
  $("logoutBtn").addEventListener("click", logout);
  $("refreshRouteBtn").addEventListener("click", () => loadLatestRoute(true));

  initMapWhenReady();
  await loadLatestRoute(true);
  startPolling();

  // live ping to dispatch
  startLocationWatch();
});