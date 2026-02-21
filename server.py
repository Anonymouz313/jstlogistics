import os
import sys
import json
import time
import sqlite3
import hashlib
import secrets
from typing import List, Dict, Any, Optional

import requests
from dotenv import load_dotenv

from fastapi import FastAPI, Request, Body
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware
from starlette.responses import Response, RedirectResponse


def base_dir() -> str:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return sys._MEIPASS  # type: ignore[attr-defined]
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = base_dir()
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
STATIC_DIR = os.path.join(BASE_DIR, "static")

load_dotenv(os.path.join(BASE_DIR, ".env"))

PORT = int(os.getenv("PORT", "5050"))

GOOGLE_MAPS_JS_KEY = os.getenv("GOOGLE_MAPS_JS_KEY", "").strip()
GOOGLE_MAPS_API_KEY = (
    os.getenv("GOOGLE_MAPS_API_KEY", "").strip()
    or os.getenv("GOOGLE_MAPS_SERVER_KEY", "").strip()
)

SESSION_SECRET = os.getenv("SESSION_SECRET", "").strip() or secrets.token_urlsafe(32)

HUB_ADDRESS = "1400 E 10 Mile Rd Suite 190 Hazel Park, MI 48030"
HUB_FALLBACK_LAT = float(os.getenv("HUB_FALLBACK_LAT", "42.4623"))
HUB_FALLBACK_LNG = float(os.getenv("HUB_FALLBACK_LNG", "-83.1032"))

DB_PATH = os.path.join(BASE_DIR, "routing.db")

DISPATCH_USERNAME = "Dispatch"
DISPATCH_PASSWORD = "Amazon2026!"


app = FastAPI(title="JSTL Logistics Routing")

app.add_middleware(
    SessionMiddleware,
    secret_key=SESSION_SECRET,
    same_site="lax",
)

class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response: Response = await call_next(request)
        if request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store"
        return response

app.add_middleware(NoCacheStaticMiddleware)

templates = Jinja2Templates(directory=TEMPLATES_DIR)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def table_has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    cols = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(c["name"] == column for c in cols)


def init_db() -> None:
    conn = db()
    cur = conn.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS drivers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        route_json TEXT NOT NULL,
        FOREIGN KEY(driver_id) REFERENCES drivers(id)
    )
    """)

    if not table_has_column(conn, "assignments", "progress_json"):
        cur.execute("ALTER TABLE assignments ADD COLUMN progress_json TEXT")
    if not table_has_column(conn, "assignments", "updated_at"):
        cur.execute("ALTER TABLE assignments ADD COLUMN updated_at INTEGER")

    # NEW: live driver location columns
    if not table_has_column(conn, "drivers", "last_lat"):
        cur.execute("ALTER TABLE drivers ADD COLUMN last_lat REAL")
    if not table_has_column(conn, "drivers", "last_lng"):
        cur.execute("ALTER TABLE drivers ADD COLUMN last_lng REAL")
    if not table_has_column(conn, "drivers", "last_loc_at"):
        cur.execute("ALTER TABLE drivers ADD COLUMN last_loc_at INTEGER")
    if not table_has_column(conn, "drivers", "last_loc_accuracy_m"):
        cur.execute("ALTER TABLE drivers ADD COLUMN last_loc_accuracy_m REAL")

    conn.commit()
    conn.close()


@app.on_event("startup")
def _startup():
    init_db()


def pbkdf2_hash_password(password: str, salt_hex: Optional[str] = None) -> str:
    password = password or ""
    if salt_hex is None:
        salt = os.urandom(16)
        salt_hex = salt.hex()
    else:
        salt = bytes.fromhex(salt_hex)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return f"pbkdf2_sha256$200000${salt_hex}${dk.hex()}"


def get_logged_in_driver_id(request: Request) -> Optional[int]:
    try:
        did = request.session.get("driver_id")
        return int(did) if did else None
    except Exception:
        return None


def is_dispatch_logged_in(request: Request) -> bool:
    return bool(request.session.get("dispatch_logged_in") is True)


def require_dispatch(request: Request):
    if not is_dispatch_logged_in(request):
        return JSONResponse({"detail": "Dispatch login required."}, status_code=401)
    return None


def touch_last_seen(driver_id: int) -> None:
    conn = db()
    conn.execute("UPDATE drivers SET last_seen=? WHERE id=?", (int(time.time()), driver_id))
    conn.commit()
    conn.close()


def _require_server_key() -> None:
    if not GOOGLE_MAPS_API_KEY:
        raise RuntimeError("GOOGLE_MAPS_API_KEY is not set (server key).")


def google_geocode(address: str) -> Dict[str, Any]:
    _require_server_key()
    url = "https://maps.googleapis.com/maps/api/geocode/json"
    r = requests.get(url, params={"address": address, "key": GOOGLE_MAPS_API_KEY}, timeout=20)
    data = r.json()
    if data.get("status") != "OK" or not data.get("results"):
        return {"ok": False, "status": data.get("status"), "error_message": data.get("error_message")}
    loc = data["results"][0]["geometry"]["location"]
    return {
        "ok": True,
        "lat": float(loc["lat"]),
        "lng": float(loc["lng"]),
        "formatted_address": data["results"][0].get("formatted_address")
    }


def google_directions(origin: str, destination: str, waypoints: Optional[List[str]] = None, optimize: bool = True) -> Dict[str, Any]:
    """
    Traffic-aware directions:
      - departure_time=now
      - traffic_model=best_guess
    """
    _require_server_key()
    url = "https://maps.googleapis.com/maps/api/directions/json"

    params: Dict[str, Any] = {
        "origin": origin,
        "destination": destination,
        "key": GOOGLE_MAPS_API_KEY,
        "departure_time": "now",
        "traffic_model": "best_guess",
    }

    if waypoints and len(waypoints) > 0:
        wp = "|".join(waypoints)
        if optimize:
            wp = "optimize:true|" + wp
        params["waypoints"] = wp

    r = requests.get(url, params=params, timeout=30)
    data = r.json()

    if data.get("status") != "OK" or not data.get("routes"):
        return {
            "ok": False,
            "status": data.get("status"),
            "error_message": data.get("error_message"),
            "raw": data,
        }

    route = data["routes"][0]
    legs = route.get("legs", [])
    waypoint_order = route.get("waypoint_order", [])

    total_distance_m = 0
    total_duration_s = 0
    total_duration_in_traffic_s = 0

    raw_legs = []
    for leg in legs:
        total_distance_m += int(leg.get("distance", {}).get("value", 0))
        total_duration_s += int(leg.get("duration", {}).get("value", 0))

        dit = leg.get("duration_in_traffic", {}).get("value")
        if dit is not None:
            total_duration_in_traffic_s += int(dit)

        raw_legs.append({
            "start_address": leg.get("start_address"),
            "end_address": leg.get("end_address"),
            "distance": leg.get("distance"),
            "duration": leg.get("duration"),
            "duration_in_traffic": leg.get("duration_in_traffic"),
            "steps": leg.get("steps", []),
        })

    return {
        "ok": True,
        "waypoint_order": waypoint_order,
        "totals": {
            "distance_meters": total_distance_m,
            "duration_seconds": total_duration_s,
            "duration_in_traffic_seconds": total_duration_in_traffic_s if total_duration_in_traffic_s else None,
        },
        "raw_legs": raw_legs,
    }


def split_round_robin(stops: List[str], k: int) -> List[List[str]]:
    if k <= 0:
        return [stops]
    groups = [[] for _ in range(k)]
    for i, s in enumerate(stops):
        groups[i % k].append(s)
    return groups


def default_progress_for_route(route_obj: Dict[str, Any]) -> Dict[str, Any]:
    stops = route_obj.get("stops") or []
    return {
        "completed": [False for _ in stops],
        "completed_count": 0,
        "total": len(stops),
        "percent": 0,
    }


def compute_progress(progress: Dict[str, Any]) -> Dict[str, Any]:
    completed = progress.get("completed") or []
    total = len(completed)
    done = sum(1 for x in completed if x)
    percent = int(round((done / total) * 100)) if total else 0
    progress["completed_count"] = done
    progress["total"] = total
    progress["percent"] = percent
    return progress


def normalize_driver_username(name: str) -> str:
    n = (name or "").strip()
    n = " ".join(n.split())
    return n.lower()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
def main_portal(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/dispatch", response_class=HTMLResponse)
def dispatch_page(request: Request):
    if not is_dispatch_logged_in(request):
        return RedirectResponse(url="/", status_code=302)

    return templates.TemplateResponse(
        "dispatch.html",
        {
            "request": request,
            "hub_address": HUB_ADDRESS,
            "maps_js_key": GOOGLE_MAPS_JS_KEY,
        },
    )


@app.get("/driver", response_class=HTMLResponse)
def driver_portal(request: Request):
    if not get_logged_in_driver_id(request):
        return RedirectResponse(url="/", status_code=302)

    # NEW: driver page needs maps_js_key for embedded map
    return templates.TemplateResponse(
        "driver.html",
        {
            "request": request,
            "hub_address": HUB_ADDRESS,
            "maps_js_key": GOOGLE_MAPS_JS_KEY,
        },
    )


@app.post("/api/dispatch/login")
def dispatch_login(request: Request, payload: Dict[str, Any] = Body(...)):
    username = (payload.get("username") or "").strip()
    password = (payload.get("password") or "").strip()

    if username == DISPATCH_USERNAME and password == DISPATCH_PASSWORD:
        request.session["dispatch_logged_in"] = True
        return {"ok": True}

    return JSONResponse({"detail": "Invalid dispatch login."}, status_code=401)


@app.post("/api/dispatch/logout")
def dispatch_logout(request: Request):
    request.session.pop("dispatch_logged_in", None)
    return {"ok": True}


@app.post("/api/driver/login_simple")
def driver_login_simple(request: Request, payload: Dict[str, Any] = Body(...)):
    name = (payload.get("name") or "").strip()
    name = " ".join(name.split())

    if not name:
        return JSONResponse({"detail": "Name required."}, status_code=400)
    if len(name) > 40:
        return JSONResponse({"detail": "Name too long."}, status_code=400)

    username = normalize_driver_username(name)
    now = int(time.time())

    conn = db()
    cur = conn.cursor()

    row = cur.execute("SELECT id FROM drivers WHERE username=?", (username,)).fetchone()
    if row:
        driver_id = int(row["id"])
        cur.execute("UPDATE drivers SET display_name=?, last_seen=? WHERE id=?", (name, now, driver_id))
    else:
        ph = pbkdf2_hash_password(secrets.token_urlsafe(18))
        cur.execute(
            "INSERT INTO drivers (username, display_name, password_hash, created_at, last_seen) VALUES (?,?,?,?,?)",
            (username, name, ph, now, now),
        )
        driver_id = int(cur.lastrowid)

    conn.commit()
    conn.close()

    request.session["driver_id"] = driver_id
    return {"ok": True, "display_name": name, "driver_id": driver_id}


@app.post("/api/driver/logout")
def driver_logout(request: Request):
    request.session.pop("driver_id", None)
    return {"ok": True}


@app.get("/api/driver/me")
def driver_me(request: Request):
    did = get_logged_in_driver_id(request)
    if not did:
        return JSONResponse({"logged_in": False}, status_code=401)

    conn = db()
    row = conn.execute("SELECT id, username, display_name, last_seen FROM drivers WHERE id=?", (did,)).fetchone()
    conn.close()
    if not row:
        request.session.pop("driver_id", None)
        return JSONResponse({"logged_in": False}, status_code=401)

    touch_last_seen(did)
    return {
        "logged_in": True,
        "driver": {
            "id": row["id"],
            "username": row["username"],
            "display_name": row["display_name"],
            "last_seen": row["last_seen"],
        }
    }


# -----------------------------
# DISPATCH-only endpoints
# -----------------------------
@app.get("/hub")
def hub(request: Request):
    err = require_dispatch(request)
    if err: return err

    if GOOGLE_MAPS_API_KEY:
        g = google_geocode(HUB_ADDRESS)
        if g.get("ok"):
            return {"address": HUB_ADDRESS, "lat": g["lat"], "lng": g["lng"]}
    return {"address": HUB_ADDRESS, "lat": HUB_FALLBACK_LAT, "lng": HUB_FALLBACK_LNG}


@app.post("/solve/route")
def solve_route(request: Request, payload: Dict[str, Any] = Body(...)):
    err = require_dispatch(request)
    if err: return err

    stops = payload.get("stops") or []
    stops = [s.strip() for s in stops if isinstance(s, str) and s.strip()]
    if not stops:
        return JSONResponse({"detail": "Add at least one stop."}, status_code=400)

    if not GOOGLE_MAPS_API_KEY:
        return JSONResponse({"detail": "GOOGLE_MAPS_API_KEY is missing (server key)."}, status_code=400)

    d = google_directions(origin=HUB_ADDRESS, destination=HUB_ADDRESS, waypoints=stops, optimize=True)
    if not d.get("ok"):
        return JSONResponse({"detail": "Directions API error.", "status": d.get("status"), "error_message": d.get("error_message")}, status_code=400)

    order = d["waypoint_order"]
    optimized = [stops[i] for i in order] if order else stops

    return {
        "status": "success",
        "hub": HUB_ADDRESS,
        "stops_input": stops,
        "waypoint_order": order,
        "stops_optimized": optimized,
        "totals": d["totals"],
        "raw_legs": d["raw_legs"],
    }


@app.post("/solve/multi")
def solve_multi(request: Request, payload: Dict[str, Any] = Body(...)):
    err = require_dispatch(request)
    if err: return err

    stops = payload.get("stops") or []
    driver_names = payload.get("driver_names") or []

    stops = [s.strip() for s in stops if isinstance(s, str) and s.strip()]
    driver_names = [d.strip() for d in driver_names if isinstance(d, str) and d.strip()]

    if not stops:
        return JSONResponse({"detail": "Add at least one stop."}, status_code=400)
    if not driver_names:
        driver_names = ["Lane 1", "Lane 2"]

    if not GOOGLE_MAPS_API_KEY:
        return JSONResponse({"detail": "GOOGLE_MAPS_API_KEY is missing (server key)."}, status_code=400)

    groups = split_round_robin(stops, len(driver_names))

    routes_out = []
    total_duration = 0
    total_traffic = 0

    for i, drv in enumerate(driver_names):
        my_stops = groups[i]
        if not my_stops:
            routes_out.append({"driver": drv, "stops": [], "duration_seconds": 0, "raw_legs": []})
            continue

        d = google_directions(origin=HUB_ADDRESS, destination=HUB_ADDRESS, waypoints=my_stops, optimize=True)
        if not d.get("ok"):
            routes_out.append({"driver": drv, "stops": my_stops, "duration_seconds": 0, "raw_legs": [], "error": {"status": d.get("status"), "error_message": d.get("error_message")}})
            continue

        order = d["waypoint_order"]
        optimized = [my_stops[idx] for idx in order] if order else my_stops

        dur = int(d["totals"]["duration_seconds"] or 0)
        total_duration += dur

        dit = d["totals"].get("duration_in_traffic_seconds")
        if dit:
            total_traffic += int(dit)

        routes_out.append({
            "driver": drv,
            "stops": optimized,
            "duration_seconds": dur,
            "duration_in_traffic_seconds": dit,
            "raw_legs": d["raw_legs"],
        })

    return {
        "status": "success",
        "hub": HUB_ADDRESS,
        "routes": routes_out,
        "total_duration_seconds": total_duration,
        "total_duration_in_traffic_seconds": total_traffic if total_traffic else None,
    }


@app.post("/api/dispatch/send_routes")
def dispatch_send_routes(request: Request, payload: Dict[str, Any] = Body(...)):
    err = require_dispatch(request)
    if err: return err

    routes = payload.get("routes") or []
    if not isinstance(routes, list):
        return JSONResponse({"detail": "routes must be a list."}, status_code=400)

    conn = db()
    cur = conn.cursor()
    now = int(time.time())

    sent = []
    missing = []

    for r in routes:
        driver_id = r.get("driver_id")
        if driver_id is None:
            continue
        try:
            driver_id = int(driver_id)
        except Exception:
            continue

        drv = cur.execute("SELECT id, display_name FROM drivers WHERE id=?", (driver_id,)).fetchone()
        if not drv:
            missing.append(str(driver_id))
            continue

        r["driver"] = (r.get("driver_label") or r.get("driver") or drv["display_name"])
        progress = compute_progress(default_progress_for_route(r))

        cur.execute(
            "INSERT INTO assignments (driver_id, created_at, status, route_json, progress_json, updated_at) VALUES (?,?,?,?,?,?)",
            (driver_id, now, "sent", json.dumps(r), json.dumps(progress), now),
        )
        sent.append({"driver_id": driver_id, "display_name": drv["display_name"], "label": r["driver"]})

    conn.commit()
    conn.close()
    return {"ok": True, "sent": sent, "missing": missing}


@app.get("/api/dispatch/status")
def dispatch_status(request: Request):
    err = require_dispatch(request)
    if err: return err

    conn = db()
    drivers = conn.execute("""
        SELECT id, username, display_name, last_seen, last_lat, last_lng, last_loc_at, last_loc_accuracy_m
        FROM drivers
        ORDER BY id DESC
    """).fetchall()

    out = []
    for d in drivers:
        a = conn.execute(
            "SELECT id, created_at, status, progress_json, route_json, updated_at FROM assignments WHERE driver_id=? ORDER BY id DESC LIMIT 1",
            (d["id"],),
        ).fetchone()

        assignment_out = None
        if a:
            try:
                progress = json.loads(a["progress_json"] or "{}")
            except Exception:
                progress = {}
            try:
                route = json.loads(a["route_json"] or "{}")
            except Exception:
                route = {}

            assignment_out = {
                "id": a["id"],
                "created_at": a["created_at"],
                "updated_at": a["updated_at"],
                "status": a["status"],
                "progress": compute_progress(progress) if progress else {"percent": 0, "completed_count": 0, "total": 0},
                "label": route.get("driver"),
                "stops_count": len(route.get("stops") or []),
            }

        out.append({
            "driver": {
                "id": d["id"],
                "username": d["username"],
                "display_name": d["display_name"],
                "last_seen": d["last_seen"],
                "last_lat": d["last_lat"],
                "last_lng": d["last_lng"],
                "last_loc_at": d["last_loc_at"],
                "last_loc_accuracy_m": d["last_loc_accuracy_m"],
            },
            "assignment": assignment_out
        })

    conn.close()
    return {"items": out}


# -----------------------------
# DRIVER location + assignments
# -----------------------------
@app.post("/api/driver/location")
def driver_location(request: Request, payload: Dict[str, Any] = Body(...)):
    did = get_logged_in_driver_id(request)
    if not did:
        return JSONResponse({"detail": "Not logged in."}, status_code=401)

    try:
        lat = float(payload.get("lat"))
        lng = float(payload.get("lng"))
        acc = payload.get("accuracy_m")
        acc = float(acc) if acc is not None else None
    except Exception:
        return JSONResponse({"detail": "Invalid lat/lng."}, status_code=400)

    now = int(time.time())
    conn = db()
    conn.execute(
        "UPDATE drivers SET last_seen=?, last_lat=?, last_lng=?, last_loc_at=?, last_loc_accuracy_m=? WHERE id=?",
        (now, lat, lng, now, acc, did),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/driver/assignment/latest")
def driver_latest_assignment(request: Request):
    did = get_logged_in_driver_id(request)
    if not did:
        return JSONResponse({"detail": "Not logged in."}, status_code=401)

    touch_last_seen(did)

    conn = db()
    row = conn.execute(
        "SELECT id, created_at, status, route_json, progress_json, updated_at FROM assignments WHERE driver_id=? ORDER BY id DESC LIMIT 1",
        (did,),
    ).fetchone()
    conn.close()

    if not row:
        return {"ok": True, "assignment": None}

    route = json.loads(row["route_json"])
    try:
        progress = json.loads(row["progress_json"] or "{}")
    except Exception:
        progress = default_progress_for_route(route)

    progress = compute_progress(progress)

    return {
        "ok": True,
        "assignment": {
            "id": row["id"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "status": row["status"],
            "route": route,
            "progress": progress,
            "hub": HUB_ADDRESS,
        }
    }


@app.post("/api/driver/assignment/update_stop")
def driver_update_stop(request: Request, payload: Dict[str, Any] = Body(...)):
    did = get_logged_in_driver_id(request)
    if not did:
        return JSONResponse({"detail": "Not logged in."}, status_code=401)

    assignment_id = payload.get("assignment_id")
    stop_index = payload.get("stop_index")
    completed = payload.get("completed")

    try:
        assignment_id = int(assignment_id)
        stop_index = int(stop_index)
        completed = bool(completed)
    except Exception:
        return JSONResponse({"detail": "Invalid payload."}, status_code=400)

    conn = db()
    row = conn.execute(
        "SELECT id, driver_id, route_json, progress_json FROM assignments WHERE id=?",
        (assignment_id,),
    ).fetchone()

    if not row:
        conn.close()
        return JSONResponse({"detail": "Assignment not found."}, status_code=404)

    if int(row["driver_id"]) != int(did):
        conn.close()
        return JSONResponse({"detail": "Forbidden."}, status_code=403)

    route = json.loads(row["route_json"] or "{}")
    stops = route.get("stops") or []

    try:
        progress = json.loads(row["progress_json"] or "{}")
    except Exception:
        progress = default_progress_for_route(route)

    if not isinstance(progress.get("completed"), list) or len(progress["completed"]) != len(stops):
        progress = default_progress_for_route(route)

    if stop_index < 0 or stop_index >= len(stops):
        conn.close()
        return JSONResponse({"detail": "stop_index out of range."}, status_code=400)

    progress["completed"][stop_index] = completed
    progress = compute_progress(progress)

    status = "sent"
    if progress["total"] > 0 and progress["completed_count"] == progress["total"]:
        status = "completed"

    now = int(time.time())
    conn.execute(
        "UPDATE assignments SET progress_json=?, status=?, updated_at=? WHERE id=?",
        (json.dumps(progress), status, now, assignment_id),
    )
    conn.commit()
    conn.close()

    touch_last_seen(did)
    return {"ok": True, "progress": progress, "status": status}