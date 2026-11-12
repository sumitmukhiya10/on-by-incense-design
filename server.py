from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import shutil
import threading
import time
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse


ROOT = Path(__file__).resolve().parent
RAILWAY_MODE = bool(
    os.getenv("RAILWAY_PROJECT_ID")
    or os.getenv("RAILWAY_SERVICE_ID")
    or os.getenv("RAILWAY_ENVIRONMENT_NAME")
    or os.getenv("RAILWAY_VOLUME_MOUNT_PATH")
)
PRODUCTION_MODE = RAILWAY_MODE or os.getenv("APP_ENV", "").strip().lower() in {"prod", "production"}


def configured_path(variable: str, fallback: Path) -> Path:
    value = os.getenv(variable, "").strip()
    return Path(value).expanduser().resolve() if value else fallback.resolve()


volume_root = os.getenv("RAILWAY_VOLUME_MOUNT_PATH", "").strip()
STORAGE_ROOT = configured_path("STORAGE_DIR", Path(volume_root) if volume_root else ROOT)
DATA_DIR = configured_path("DATA_DIR", STORAGE_ROOT / "json")
IMAGE_DIR = configured_path("IMAGE_DIR", STORAGE_ROOT / "images")
PRODUCT_IMAGE_DIR = IMAGE_DIR / "products"
HOMEPAGE_IMAGE_DIR = IMAGE_DIR / "homepage"
SOURCE_IMAGE_DIR = ROOT / "images"
SEED_DATA_DIR = configured_path("SEED_DATA_DIR", ROOT / "seed_data")
COOKIE_NAME = "onby_admin_session"
MAX_IMAGE_BYTES = 15 * 1024 * 1024
PASSWORD_ROUNDS = 600_000
DEFAULT_WHATSAPP_NUMBER = "+91 92172 99927"
SECTIONS = ("products", "settings", "discounts", "orders", "enquiries", "admin")
SEED_SECTIONS = ("products", "settings", "discounts")
SESSION_SECRET_CONFIGURED = bool(os.getenv("SESSION_SECRET", "").strip())
SESSION_SECRET = os.getenv("SESSION_SECRET", "").strip() or secrets.token_urlsafe(48)
_store_lock = threading.RLock()
_sessions: dict[str, float] = {}
_login_attempts: dict[str, list[float]] = {}
_recovery_attempts: dict[str, list[float]] = {}
_setup_code = secrets.token_urlsafe(24)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _initial_json(name: str) -> Any:
    if name in ("orders", "enquiries"):
        return {"records": []}
    if name == "admin":
        return {"initialized": False, "password_hash": "", "recovery_hash": "", "master_password_hash": ""}
    if name == "products":
        return []
    if name in ("settings", "discounts"):
        return {}
    return {}


def initialize_storage() -> None:
    if PRODUCTION_MODE:
        mounted_volume = os.getenv("RAILWAY_VOLUME_MOUNT_PATH", "").strip()
        if RAILWAY_MODE:
            if not mounted_volume:
                raise RuntimeError("Attach a Railway volume before starting the production service.")
            mount_path = Path(mounted_volume).resolve()
            for label, configured in (("STORAGE_DIR", STORAGE_ROOT), ("DATA_DIR", DATA_DIR), ("IMAGE_DIR", IMAGE_DIR)):
                if not configured.is_relative_to(mount_path):
                    raise RuntimeError(f"{label} must be inside the Railway volume mounted at {mount_path}.")
        elif not (os.getenv("STORAGE_DIR", "").strip() or mounted_volume):
            raise RuntimeError("Production needs persistent storage. Set STORAGE_DIR or attach a Railway volume.")
        if not SESSION_SECRET_CONFIGURED or len(SESSION_SECRET) < 32:
            raise RuntimeError("Production needs SESSION_SECRET with at least 32 characters.")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    PRODUCT_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    HOMEPAGE_IMAGE_DIR.mkdir(parents=True, exist_ok=True)

    copy_starting_images()
    for name in SECTIONS:
        path = DATA_DIR / f"{name}.json"
        if not path.exists():
            seed_path = SEED_DATA_DIR / f"{name}.json"
            if name in SEED_SECTIONS and seed_path.is_file():
                try:
                    initial_value = json.loads(seed_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as exc:
                    raise RuntimeError(f"Starting {name} data could not be read safely.") from exc
            elif name in SEED_SECTIONS and PRODUCTION_MODE:
                raise RuntimeError(f"Missing safe starting data file: {seed_path.name}")
            else:
                initial_value = _initial_json(name)
            write_json(name, initial_value, keep_backup=False)
    image_index = DATA_DIR / "images.json"
    if not image_index.exists():
        write_json("images", {"records": []}, keep_backup=False)

    initialize_admin_from_environment()


def copy_starting_images() -> None:
    """Copy bundled product images to persistent storage without replacing existing files."""
    source_root = SOURCE_IMAGE_DIR.resolve()
    destination_root = IMAGE_DIR.resolve()
    if source_root == destination_root or not source_root.is_dir():
        return
    for source in source_root.rglob("*"):
        if not source.is_file():
            continue
        relative = source.relative_to(source_root)
        destination = destination_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            continue
        try:
            with source.open("rb") as source_file, destination.open("xb") as destination_file:
                shutil.copyfileobj(source_file, destination_file)
        except FileExistsError:
            # Another initializer may have copied this file first; never overwrite it.
            continue


def initialize_admin_from_environment() -> None:
    """Bootstrap a new admin, or apply one explicitly requested reset once."""
    data = admin_data()
    reset_requested = os.getenv("RESET_ADMIN_FROM_ENV", "").strip().lower() in {"true", "1", "yes"}

    if not reset_requested:
        if data.pop("environment_reset_applied", False):
            write_json("admin", data)
        if data.get("initialized"):
            return

    password = os.getenv("INITIAL_ADMIN_PASSWORD", "")
    master_password = os.getenv("INITIAL_MASTER_PASSWORD", "")
    if reset_requested and data.get("initialized") and data.get("environment_reset_applied"):
        return
    if not password and not master_password:
        if PRODUCTION_MODE:
            if reset_requested:
                raise RuntimeError("Set INITIAL_ADMIN_PASSWORD and INITIAL_MASTER_PASSWORD to reset production admin access.")
            raise RuntimeError("Set INITIAL_ADMIN_PASSWORD and INITIAL_MASTER_PASSWORD for first production startup.")
        return
    if not password or not master_password:
        raise RuntimeError("Set both INITIAL_ADMIN_PASSWORD and INITIAL_MASTER_PASSWORD.")
    try:
        password = validate_password(password)
        master_password = validate_password(master_password)
    except HTTPException as exc:
        raise RuntimeError("Production admin passwords must be 12+ characters with upper/lowercase, a number, and a symbol.") from exc
    if hmac.compare_digest(password, master_password):
        raise RuntimeError("INITIAL_ADMIN_PASSWORD and INITIAL_MASTER_PASSWORD must be different.")
    data.update({
        "initialized": True,
        "password_hash": password_hash(password),
        "master_password_hash": password_hash(master_password),
        "updated_at": now_iso(),
    })
    if reset_requested:
        data["environment_reset_applied"] = True
    else:
        data.setdefault("recovery_hash", "")
    write_json("admin", data)
    if reset_requested:
        _sessions.clear()
        _login_attempts.clear()
        _recovery_attempts.clear()


def session_key(token: str) -> str:
    return hmac.new(SESSION_SECRET.encode("utf-8"), token.encode("utf-8"), hashlib.sha256).hexdigest()


def client_address(request: Request) -> str:
    if RAILWAY_MODE:
        railway_ip = request.headers.get("x-real-ip", "").strip()
        try:
            return str(ipaddress.ip_address(railway_ip))
        except ValueError:
            pass
    return request.client.host if request.client else "unknown"


@contextmanager
def _file_lock():
    """Serialize read-modify-write operations across threads and server processes."""
    lock_path = DATA_DIR / ".store.lock"
    lock_path.parent.mkdir(exist_ok=True)
    with _store_lock, lock_path.open("a+b") as handle:
        if os.name == "nt":
            import msvcrt
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def read_json(name: str) -> Any:
    if name not in (*SECTIONS, "images"):
        raise ValueError("Unknown data file")
    with _file_lock():
        return _read_json_unlocked(name)


def _read_json_unlocked(name: str) -> Any:
    path = DATA_DIR / f"{name}.json"
    if not path.exists():
        return _initial_json(name)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        backup = path.with_suffix(path.suffix + ".bak")
        if backup.exists():
            try:
                return json.loads(backup.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                pass
        raise HTTPException(500, f"Saved {name} data could not be read safely.") from exc


def write_json(name: str, value: Any, keep_backup: bool = True) -> None:
    if name not in (*SECTIONS, "images"):
        raise ValueError("Unknown data file")
    with _file_lock():
        _write_json_unlocked(name, value, keep_backup)


def _write_json_unlocked(name: str, value: Any, keep_backup: bool = True) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    path = DATA_DIR / f"{name}.json"
    temp = DATA_DIR / f".{name}.{uuid.uuid4().hex}.tmp"
    encoded = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if keep_backup and path.exists():
        backup_temp = path.with_suffix(path.suffix + ".bak.tmp")
        shutil.copyfile(path, backup_temp)
        os.replace(backup_temp, path.with_suffix(path.suffix + ".bak"))
    try:
        temp.write_text(encoded, encoding="utf-8")
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def update_json(name: str, update):
    """Apply a read/modify/write operation while holding the shared data lock."""
    if name not in (*SECTIONS, "images"):
        raise ValueError("Unknown data file")
    with _file_lock():
        value = _read_json_unlocked(name)
        result = update(value)
        _write_json_unlocked(name, value)
        return result


def product_rows() -> list[dict[str, Any]]:
    return _rows_from_product_data(read_json("products"))


def _rows_from_product_data(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("value"), list):
        return data["value"]
    if isinstance(data, dict) and isinstance(data.get("products"), list):
        return data["products"]
    return []


def mutate_product_rows(change):
    def apply(data):
        rows = _rows_from_product_data(data)
        result = change(rows)
        if isinstance(data, dict) and "value" in data:
            data["value"] = rows
            data["Count"] = len(rows)
        elif isinstance(data, dict) and "products" in data:
            data["products"] = rows
        else:
            data = rows
        return result, data
    result_box = {}
    def update(data):
        result, updated_data = apply(data)
        result_box["value"] = result
        return updated_data
    update_json("products", update)
    return result_box.get("value")


def save_product_rows(rows: list[dict[str, Any]]) -> None:
    def replace(old):
        if isinstance(old, dict) and "value" in old:
            old["value"] = rows
            old["Count"] = len(rows)
        elif isinstance(old, dict) and "products" in old:
            old["products"] = rows
        else:
            old = rows
        return old
    update_json("products", replace)


def password_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ROUNDS)
    return f"pbkdf2_sha256${PASSWORD_ROUNDS}${salt.hex()}${digest.hex()}"


def verify_hash(value: str, encoded: str) -> bool:
    try:
        algorithm, rounds, salt, expected = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac("sha256", value.encode("utf-8"), bytes.fromhex(salt), int(rounds)).hex()
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def validate_password(value: Any) -> str:
    password = str(value or "")
    if len(password) < 12 or len(password) > 256 or not any(c.islower() for c in password) or not any(c.isupper() for c in password) or not any(c.isdigit() for c in password) or not any(not c.isalnum() for c in password):
        raise HTTPException(400, "Use at least 12 characters with upper and lower case letters, a number, and a symbol.")
    return password


def admin_data() -> dict[str, Any]:
    data = read_json("admin")
    return data if isinstance(data, dict) else {"initialized": False, "password_hash": "", "recovery_hash": "", "master_password_hash": ""}


def require_admin(request: Request) -> str:
    token = request.cookies.get(COOKIE_NAME, "")
    key = session_key(token) if token else ""
    expiry = _sessions.get(key)
    if not expiry or expiry <= time.time():
        _sessions.pop(key, None)
        raise HTTPException(401, "Please log in to continue.")
    return token


def require_same_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin:
        parsed = urlsplit(origin)
        host = request.headers.get("host", "")
        if parsed.scheme not in ("http", "https") or parsed.netloc.lower() != host.lower():
            raise HTTPException(403, "This request could not be verified.")


def safe_text(value: Any, label: str, limit: int, required: bool = False) -> str:
    text = str(value or "").strip()
    if required and not text:
        raise HTTPException(400, f"{label} is required.")
    if len(text) > limit:
        raise HTTPException(400, f"{label} is too long.")
    return text


def make_slug(name: str) -> str:
    normalized = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", normalized)).strip("-") or "furniture-item"


def normalize_product(body: dict[str, Any], old: dict[str, Any] | None = None, rows: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    old = old or {}
    rows = rows or []
    name = safe_text(body.get("name"), "Furniture name", 160, True)
    slug = make_slug(name)
    if any(row.get("slug") == slug and row.get("id") != old.get("id") for row in rows):
        raise HTTPException(400, "Another product already uses this name.")
    try:
        price = int(body.get("price_paise"))
        sale = body.get("sale_price_paise")
        sale = int(sale) if sale not in (None, "") else None
    except (ValueError, TypeError):
        raise HTTPException(400, "Enter a valid product price.")
    if price <= 0 or price > 100_000_000_000:
        raise HTTPException(400, "Enter a valid product price.")
    if sale is not None and (sale <= 0 or sale >= price):
        raise HTTPException(400, "Sale price must be lower than the regular price.")
    images = body.get("images", old.get("images", []))
    if not isinstance(images, list) or len(images) > 12 or any(not valid_image_reference(p) for p in images):
        raise HTTPException(400, "Choose valid product photos.")
    if not images:
        raise HTTPException(400, "Choose at least one product photo.")
    product_id = int(old.get("id") or max((int(row.get("id", 0)) for row in rows), default=0) + 1)
    product = {
        **old,
        "id": product_id, "slug": slug, "name": name,
        "category": safe_text(body.get("category"), "Furniture type", 80, True),
        "price_paise": price, "sale_price_paise": sale,
        "sale_active": bool(body.get("sale_active")) and sale is not None,
        "sale_start_at": body.get("sale_start_at") or None,
        "sale_end_at": body.get("sale_end_at") or None,
        "sale_stack_discounts": bool(body.get("sale_stack_discounts")),
        "description": safe_text(body.get("description"), "Description", 2000),
        "images": images,
        "in_stock": bool(body.get("in_stock", body.get("availability_confirmed", True))),
        "availability_confirmed": bool(body.get("availability_confirmed", True)),
        "stock_quantity": body.get("stock_quantity"),
        "featured": bool(body.get("featured")), "bestseller": bool(body.get("bestseller")),
        "new_arrival": bool(body.get("new_arrival")), "discount_eligible": bool(body.get("discount_eligible", True)),
        "active": bool(body.get("active", True)), "is_demo": bool(body.get("is_demo", False)),
        "demo_approved": bool(body.get("demo_approved", False)),
        "created_at": old.get("created_at") or now_iso(), "updated_at": now_iso(),
    }
    return product


def valid_image_path(value: Any) -> bool:
    if not isinstance(value, str) or not value.startswith("/images/"):
        return False
    relative = value[len("/images/"):].split("?", 1)[0]
    candidate = (IMAGE_DIR / relative).resolve()
    try:
        candidate.relative_to(IMAGE_DIR.resolve())
        return candidate.is_file()
    except ValueError:
        return False


def valid_image_reference(value: Any) -> bool:
    if valid_image_path(value):
        return True
    if not isinstance(value, str) or len(value) > 2048:
        return False
    try:
        parsed = urlsplit(value)
        return parsed.scheme == "https" and bool(parsed.hostname) and parsed.username is None and parsed.password is None
    except ValueError:
        return False


def active_sale(product: dict[str, Any]) -> bool:
    if not product.get("sale_active") or not product.get("sale_price_paise"):
        return False
    now = datetime.now(timezone.utc)
    for key, op in (("sale_start_at", "start"), ("sale_end_at", "end")):
        value = product.get(key)
        if value:
            try:
                date = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
                if date.tzinfo is None:
                    date = date.replace(tzinfo=timezone.utc)
                if op == "start" and date > now or op == "end" and date <= now:
                    return False
            except ValueError:
                return False
    return True


def create_quote(items: Any) -> dict[str, Any]:
    if not isinstance(items, list) or not items or len(items) > 100:
        raise HTTPException(400, "Your cart is empty or contains too many items.")
    products = product_rows()
    discounts = read_json("discounts")
    by_id = {int(item.get("id", 0)): item for item in products}
    lines, subtotal, eligible_subtotal, eligible_units = [], 0, 0, 0
    for raw in items:
        try:
            item_id, quantity = int(raw.get("product_id")), int(raw.get("quantity"))
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(400, "A cart item is invalid.")
        product = by_id.get(item_id)
        if not product or not product.get("active", True) or (product.get("is_demo") and not product.get("demo_approved")):
            raise HTTPException(400, "A product in your cart is no longer available.")
        if not product.get("availability_confirmed") or not product.get("in_stock") or product.get("stock_quantity") is not None and int(product["stock_quantity"]) <= 0:
            raise HTTPException(400, f"{product.get('name', 'This item')} is currently unavailable for sale.")
        if quantity < 1 or quantity > 99:
            raise HTTPException(400, "Choose a quantity between 1 and 99.")
        if product.get("stock_quantity") is not None and quantity > int(product["stock_quantity"]):
            raise HTTPException(400, f"Only {product['stock_quantity']} of {product['name']} are available.")
        on_sale = active_sale(product)
        price = int(product.get("sale_price_paise") if on_sale else product.get("price_paise", 0))
        line_total = price * quantity
        eligible = bool(product.get("discount_eligible", True)) and (not on_sale or product.get("sale_stack_discounts")) and price >= int(discounts.get("min_eligible_price_paise", 0))
        subtotal += line_total
        if eligible:
            eligible_units += quantity
            eligible_subtotal += line_total
        lines.append({"product_id": item_id, "name": product["name"], "slug": product.get("slug", ""), "quantity": quantity, "price_paise": price, "line_total_paise": line_total, "image": (product.get("images") or [""])[0], "on_sale": on_sale, "discount_eligible": eligible})
    tiers = discounts.get("tiers") if isinstance(discounts.get("tiers"), list) else []
    percent = max((float(t.get("percent", 0)) for t in tiers if eligible_units >= int(t.get("min_items", 0))), default=0) if discounts.get("discounts_enabled", True) else 0
    percent = min(percent, float(discounts.get("max_discount_percent", 15)), 100)
    saving = round(eligible_subtotal * percent / 100)
    cap = int(discounts.get("max_discount_paise", 0))
    if cap > 0:
        saving = min(saving, cap)
    saving = min(saving, eligible_subtotal, subtotal)
    next_tier = next((tier for tier in sorted(tiers, key=lambda t: int(t.get("min_items", 0))) if int(tier.get("min_items", 0)) > eligible_units), None)
    return {"lines": lines, "subtotal_paise": subtotal, "eligible_subtotal_paise": eligible_subtotal, "eligible_units": eligible_units, "discount_percent": percent, "discount_paise": saving, "total_paise": subtotal - saving, "free_delivery": bool(discounts.get("free_delivery_enabled")), "discounts_enabled": discounts.get("discounts_enabled", True), "delivery_note": "Delivery charges and availability will be confirmed by the showroom.", "tiers": tiers, "next_tier": next_tier}


app = FastAPI(title="ON BY INCENSE DESIGN", docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def prevent_api_caching(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, private"
    return response


@app.on_event("startup")
def startup() -> None:
    initialize_storage()
    if not admin_data().get("initialized"):
        print("\nON BY INCENSE DESIGN first-time admin setup")
        print("Open /admin.html locally and create separate Admin and master recovery passwords. For non-local setup, use /admin-setup.html with this one-time code:")
        print(_setup_code, "\n")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/products")
def public_products() -> list[dict[str, Any]]:
    return [row for row in product_rows() if row.get("active", True) and (not row.get("is_demo") or row.get("demo_approved"))]


@app.get("/api/products/{identifier}")
def public_product(identifier: str) -> dict[str, Any]:
    rows = public_products()
    item = next((row for row in rows if str(row.get("slug")) == identifier or str(row.get("id")) == identifier), None)
    if not item:
        raise HTTPException(404, "That product could not be found.")
    return item


@app.get("/api/settings")
def public_settings() -> dict[str, Any]:
    settings = read_json("settings")
    settings["discounts"] = read_json("discounts")
    return settings


@app.get("/api/discounts")
def public_discounts() -> dict[str, Any]:
    return read_json("discounts")


@app.post("/api/cart/quote")
async def cart_quote(request: Request) -> dict[str, Any]:
    body = await request.json()
    return create_quote(body.get("items"))


@app.post("/api/orders")
async def create_order(request: Request) -> dict[str, Any]:
    body = await request.json()
    customer = body.get("customer") or {}
    name = safe_text(customer.get("name"), "Your name", 120, True)
    phone = safe_text(customer.get("phone"), "Phone number", 40, True)
    address = safe_text(customer.get("address"), "Address", 500, True)
    city = safe_text(customer.get("city"), "City", 120, True)
    state = safe_text(customer.get("state"), "State", 120, True)
    quote_data = create_quote(body.get("items"))
    settings = read_json("settings")
    order_id = uuid.uuid4().hex[:12].upper()
    record = {"id": order_id, "created_at": now_iso(), "status": "Pending showroom confirmation", "customer_name": name, "phone": phone, "address": address, "city": city, "state": state, "lines": quote_data["lines"], "subtotal_paise": quote_data["subtotal_paise"], "discount_paise": quote_data["discount_paise"], "total_paise": quote_data["total_paise"]}
    def save_order(orders):
        if not isinstance(orders, dict):
            orders = {"records": []}
        orders.setdefault("records", []).insert(0, record)
        return orders
    update_json("orders", save_order)
    wa = re.sub(r"\D", "", str(settings.get("whatsapp_number") or DEFAULT_WHATSAPP_NUMBER))
    lines = [f"{line['name']} x {line['quantity']} - INR {line['line_total_paise'] / 100:,.2f}" for line in quote_data["lines"]]
    message = "\n".join([f"Hello {settings.get('business_name', 'ON BY INCENSE DESIGN')},", f"Order request {order_id}:", *lines, f"Estimated total: INR {quote_data['total_paise'] / 100:,.2f}", f"Name: {name}", f"Phone: {phone}", f"Address: {address}, {city}, {state}", "Please confirm availability, delivery, and the final price. This is not confirmed until the showroom replies."])
    return {"id": order_id, "whatsapp_url": f"https://wa.me/{wa}?text={quote(message)}", "quote": quote_data}


@app.post("/api/enquiries")
async def create_enquiry(request: Request) -> dict[str, Any]:
    body = await request.json()
    if body.get("website"):
        return {"id": "", "whatsapp_url": "https://wa.me/"}
    name = safe_text(body.get("name"), "Your name", 120, True)
    phone = safe_text(body.get("phone"), "Phone number", 40, True)
    email = safe_text(body.get("email"), "Email address", 254)
    subject = safe_text(body.get("subject"), "Subject", 160)
    message = safe_text(body.get("message"), "Message", 5000, True)
    if email and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise HTTPException(400, "Enter a valid email address.")
    record = {"id": uuid.uuid4().hex[:12].upper(), "created_at": now_iso(), "status": "New", "archived": False, "name": name, "phone": phone, "email": email, "subject": subject, "message": message}
    def save_enquiry(data):
        if not isinstance(data, dict):
            data = {"records": []}
        data.setdefault("records", []).insert(0, record)
        return data
    update_json("enquiries", save_enquiry)
    settings = read_json("settings")
    wa = re.sub(r"\D", "", str(settings.get("whatsapp_number") or DEFAULT_WHATSAPP_NUMBER))
    text = "\n".join([f"Hello {settings.get('business_name', 'ON BY INCENSE DESIGN')},", f"Enquiry {record['id']}", f"Name: {name}", f"Phone: {phone}", f"Email: {email or 'Not provided'}", f"About: {subject or 'General enquiry'}", f"Message: {message}"])
    return {"id": record["id"], "whatsapp_url": f"https://wa.me/{wa}?text={quote(text)}"}


@app.get("/api/admin/status")
def admin_status(request: Request) -> dict[str, bool]:
    data = admin_data()
    token = request.cookies.get(COOKIE_NAME, "")
    return {"initialized": bool(data.get("initialized")), "authenticated": bool(token and _sessions.get(session_key(token), 0) > time.time())}


@app.post("/api/admin/setup")
async def admin_setup(request: Request) -> dict[str, str]:
    require_same_origin(request)
    body = await request.json()
    current = admin_data()
    if current.get("initialized"):
        raise HTTPException(409, "Admin setup has already been completed.")
    supplied_code = str(body.get("setup_code", ""))
    client_ip = client_address(request)
    try:
        is_loopback_client = ipaddress.ip_address(client_ip.strip("[]")).is_loopback
    except ValueError:
        is_loopback_client = False
    local_host = request.url.hostname in ("localhost", "127.0.0.1", "::1")
    local_first_setup = not supplied_code and is_loopback_client and local_host
    if not local_first_setup and not hmac.compare_digest(supplied_code, _setup_code):
        raise HTTPException(403, "The one-time setup code is incorrect. Start the setup from the local server window.")
    password = validate_password(body.get("password"))
    master_password = validate_password(body.get("master_password"))
    if hmac.compare_digest(password, master_password):
        raise HTTPException(400, "Choose a different password for Admin access and account recovery.")
    recovery = secrets.token_urlsafe(24)
    write_json("admin", {"initialized": True, "password_hash": password_hash(password), "master_password_hash": password_hash(master_password), "recovery_hash": password_hash(recovery), "updated_at": now_iso()})
    token = secrets.token_urlsafe(32)
    _sessions[session_key(token)] = time.time() + 12 * 60 * 60
    response = JSONResponse({"ok": True, "recovery_code": recovery, "message": "Admin password saved. Copy and store the recovery code now; it is shown only once."})
    response.set_cookie(COOKIE_NAME, token, httponly=True, secure=PRODUCTION_MODE or request.url.scheme == "https", samesite="strict", max_age=12 * 60 * 60, path="/")
    return response


@app.post("/api/admin/login")
async def admin_login(request: Request) -> JSONResponse:
    require_same_origin(request)
    host = client_address(request)
    recent = [at for at in _login_attempts.get(host, []) if time.time() - at < 900]
    if len(recent) >= 8:
        raise HTTPException(429, "Too many login attempts. Wait 15 minutes and try again.")
    body = await request.json()
    data = admin_data()
    if not data.get("initialized") or not verify_hash(str(body.get("password", "")), str(data.get("password_hash", ""))):
        recent.append(time.time())
        _login_attempts[host] = recent
        raise HTTPException(401, "The password is incorrect.")
    _login_attempts.pop(host, None)
    token = secrets.token_urlsafe(32)
    _sessions[session_key(token)] = time.time() + 12 * 60 * 60
    response = JSONResponse({"ok": True})
    response.set_cookie(COOKIE_NAME, token, httponly=True, secure=PRODUCTION_MODE or request.url.scheme == "https", samesite="strict", max_age=12 * 60 * 60, path="/")
    return response


@app.post("/api/admin/logout")
def admin_logout(request: Request) -> JSONResponse:
    require_same_origin(request)
    token = request.cookies.get(COOKIE_NAME, "")
    _sessions.pop(session_key(token) if token else "", None)
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE_NAME, path="/")
    return response


@app.post("/api/admin/change-password")
async def change_password(request: Request) -> dict[str, bool]:
    require_same_origin(request)
    require_admin(request)
    body = await request.json()
    data = admin_data()
    if not verify_hash(str(body.get("current_password", "")), str(data.get("password_hash", ""))):
        raise HTTPException(400, "Current password is incorrect.")
    password = validate_password(body.get("new_password"))
    if hmac.compare_digest(password, str(body.get("current_password", ""))):
        raise HTTPException(400, "Choose a different password.")
    data["password_hash"] = password_hash(password)
    data["updated_at"] = now_iso()
    write_json("admin", data)
    return {"ok": True}


@app.post("/api/admin/recovery-password")
async def change_recovery_password(request: Request) -> dict[str, bool]:
    require_same_origin(request)
    require_admin(request)
    body = await request.json()
    data = admin_data()
    if not verify_hash(str(body.get("current_password", "")), str(data.get("password_hash", ""))):
        raise HTTPException(400, "Current Admin password is incorrect.")
    master_password = validate_password(body.get("master_password"))
    if hmac.compare_digest(master_password, str(body.get("current_password", ""))):
        raise HTTPException(400, "Choose a different password for account recovery.")
    old_master_hash = str(data.get("master_password_hash", ""))
    if old_master_hash and verify_hash(master_password, old_master_hash):
        raise HTTPException(400, "Choose a different master recovery password.")
    data["master_password_hash"] = password_hash(master_password)
    data["updated_at"] = now_iso()
    write_json("admin", data)
    return {"ok": True}


@app.post("/api/admin/recover")
async def recover_password(request: Request) -> JSONResponse:
    require_same_origin(request)
    body = await request.json()
    data = admin_data()
    host = client_address(request)
    recent = [at for at in _recovery_attempts.get(host, []) if time.time() - at < 900]
    if len(recent) >= 8:
        raise HTTPException(429, "Too many recovery attempts. Wait 15 minutes and try again.")
    secret = str(body.get("recovery_password", body.get("recovery_code", "")))
    master_hash = str(data.get("master_password_hash", ""))
    master_matches = bool(master_hash and verify_hash(secret, master_hash))
    legacy_code_matches = not master_matches and bool(data.get("initialized")) and verify_hash(secret, str(data.get("recovery_hash", "")))
    if not data.get("initialized") or not (master_matches or legacy_code_matches):
        recent.append(time.time())
        _recovery_attempts[host] = recent
        raise HTTPException(400, "The master recovery password or one-time recovery code is incorrect.")
    password = validate_password(body.get("new_password"))
    if hmac.compare_digest(password, secret):
        raise HTTPException(400, "Choose a new Admin password that is different from the recovery password.")
    replacement = secrets.token_urlsafe(24) if legacy_code_matches else ""
    data.update({"password_hash": password_hash(password), "updated_at": now_iso()})
    if legacy_code_matches:
        data["recovery_hash"] = password_hash(replacement)
    write_json("admin", data)
    _recovery_attempts.pop(host, None)
    _sessions.clear()
    token = secrets.token_urlsafe(32)
    _sessions[session_key(token)] = time.time() + 12 * 60 * 60
    message = "Admin password reset. Your master recovery password remains active." if master_matches else "Password changed. Save your new recovery code; the old code has been used."
    response = JSONResponse({"ok": True, "recovery_code": replacement, "recovered_with_master_password": master_matches, "message": message})
    response.set_cookie(COOKIE_NAME, token, httponly=True, secure=PRODUCTION_MODE or request.url.scheme == "https", samesite="strict", max_age=12 * 60 * 60, path="/")
    return response


@app.get("/api/admin/products")
def admin_products(request: Request) -> list[dict[str, Any]]:
    require_admin(request)
    return product_rows()


@app.post("/api/admin/products")
async def add_product(request: Request) -> dict[str, Any]:
    require_same_origin(request)
    require_admin(request)
    body = await request.json()
    return mutate_product_rows(lambda rows: _add_product_row(body, rows))


def _add_product_row(body, rows):
    item = normalize_product(body, rows=rows)
    rows.insert(0, item)
    return item


@app.put("/api/admin/products/{product_id}")
async def edit_product(product_id: int, request: Request) -> dict[str, Any]:
    require_same_origin(request)
    require_admin(request)
    body = await request.json()
    return mutate_product_rows(lambda rows: _edit_product_row(product_id, body, rows))


def _edit_product_row(product_id, body, rows):
    old = next((row for row in rows if int(row.get("id", 0)) == product_id), None)
    if not old:
        raise HTTPException(404, "Furniture could not be found.")
    item = normalize_product(body, old=old, rows=rows)
    rows[rows.index(old)] = item
    return item


@app.delete("/api/admin/products/{product_id}")
def delete_product(product_id: int, request: Request) -> dict[str, bool]:
    require_same_origin(request)
    require_admin(request)
    return mutate_product_rows(lambda rows: _delete_product_row(product_id, rows))


def _delete_product_row(product_id, rows):
    remaining = [row for row in rows if int(row.get("id", 0)) != product_id]
    if len(remaining) == len(rows):
        raise HTTPException(404, "Furniture could not be found.")
    rows[:] = remaining
    return {"ok": True}


async def save_upload(upload: UploadFile, folder: Path) -> str:
    suffix = Path(upload.filename or "").suffix.lower()
    allowed = {".jpg": ("image/jpeg", b"\xff\xd8\xff"), ".jpeg": ("image/jpeg", b"\xff\xd8\xff"), ".png": ("image/png", b"\x89PNG\r\n\x1a\n"), ".webp": ("image/webp", b"RIFF")}
    if suffix not in allowed or upload.content_type != allowed[suffix][0]:
        raise HTTPException(400, "Choose a JPG, PNG, or WebP image.")
    content = await upload.read(MAX_IMAGE_BYTES + 1)
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "This photo is over the 15 MB limit.")
    if len(content) < 12 or not content.startswith(allowed[suffix][1]) or suffix == ".webp" and content[8:12] != b"WEBP":
        raise HTTPException(400, "This file does not appear to be a valid image.")
    folder.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}{suffix}"
    target = folder / filename
    target.write_bytes(content)
    relative = "/images/" + target.relative_to(IMAGE_DIR).as_posix()
    def index_image(images):
        if isinstance(images, list):
            images.append(relative)
        else:
            if not isinstance(images, dict):
                images = {"records": []}
            images.setdefault("records", []).append({"path": relative, "uploaded_at": now_iso(), "size": len(content)})
        return images
    update_json("images", index_image)
    return f"{relative}?v={int(time.time())}"


@app.post("/api/admin/upload-image")
async def upload_image(request: Request, file: UploadFile = File(...), kind: str = Form("product")) -> dict[str, str]:
    require_same_origin(request)
    require_admin(request)
    if kind not in ("product", "homepage"):
        raise HTTPException(400, "Choose a valid image location.")
    path = await save_upload(file, PRODUCT_IMAGE_DIR if kind == "product" else HOMEPAGE_IMAGE_DIR)
    return {"url": path}


@app.get("/api/admin/settings")
def admin_settings(request: Request) -> dict[str, Any]:
    require_admin(request)
    return read_json("settings")


@app.put("/api/admin/settings")
async def update_settings(request: Request) -> dict[str, Any]:
    require_same_origin(request)
    require_admin(request)
    body = await request.json()
    def apply(current):
        allowed = set(current.keys()) | {"business_name", "whatsapp_number", "email", "business_hours", "address", "announcement", "homepage_heading", "hero_description", "hero_image", "hero_cta_text", "hero_cta_url", "promotional_heading", "special_offers_enabled", "new_arrivals_enabled", "featured_products"}
        updated = {**current}
        for key in allowed:
            if key in body:
                updated[key] = body[key]
        for key, limit in (("business_name", 120), ("whatsapp_number", 30), ("email", 254), ("business_hours", 200), ("address", 500), ("announcement", 180), ("homepage_heading", 120), ("hero_description", 500), ("hero_cta_text", 40), ("promotional_heading", 100)):
            if key in updated:
                updated[key] = safe_text(updated[key], key.replace("_", " "), limit)
        if updated.get("email") and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", updated["email"]):
            raise HTTPException(400, "Enter a valid contact email or leave it blank.")
        if "hero_image" in body and not valid_image_path(str(body["hero_image"]).split("?", 1)[0]):
            raise HTTPException(400, "Upload a valid homepage image before saving.")
        updated["hero_cta_url"] = "/shop.html"
        if "featured_products" in updated and not isinstance(updated["featured_products"], list):
            raise HTTPException(400, "Featured products must be a list.")
        current.clear()
        current.update(updated)
        return current
    return update_json("settings", apply)


@app.put("/api/admin/discounts")
async def update_discounts(request: Request) -> dict[str, Any]:
    require_same_origin(request)
    require_admin(request)
    body = await request.json()
    tiers = body.get("tiers")
    maximum = float(body.get("max_discount_percent", 15))
    if not isinstance(tiers, list) or not tiers or len(tiers) > 20 or not 0 <= maximum <= 80:
        raise HTTPException(400, "Check the discount steps and maximum discount.")
    normalized = []
    previous_count, previous_percent = 0, -1
    for tier in sorted(tiers, key=lambda row: int(row.get("min_items", 0))):
        count, percent = int(tier.get("min_items", 0)), float(tier.get("percent", -1))
        if count <= previous_count or not 0 <= percent <= maximum or percent < previous_percent:
            raise HTTPException(400, "Item counts must be unique and discounts must stay within the maximum.")
        normalized.append({"min_items": count, "percent": percent})
        previous_count, previous_percent = count, percent
    result = {"tiers": normalized, "max_discount_percent": maximum, "min_eligible_price_paise": max(0, int(body.get("min_eligible_price_paise", 0))), "max_discount_paise": max(0, int(body.get("max_discount_paise", 0))), "discounts_enabled": bool(body.get("discounts_enabled")), "free_delivery_enabled": bool(body.get("free_delivery_enabled"))}
    write_json("discounts", result)
    return result


@app.get("/api/admin/orders")
def admin_orders(request: Request) -> list[dict[str, Any]]:
    require_admin(request)
    data = read_json("orders")
    return data.get("records", []) if isinstance(data, dict) else []


@app.get("/api/admin/enquiries")
def admin_enquiries(request: Request) -> list[dict[str, Any]]:
    require_admin(request)
    data = read_json("enquiries")
    return data.get("records", []) if isinstance(data, dict) else []


@app.get("/api/admin/enquiries/page")
def admin_enquiries_page(request: Request, page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=50), archived: bool | None = None, q: str = "", status: str = "", date_range: str = "") -> dict[str, Any]:
    require_admin(request)
    data = read_json("enquiries")
    rows = data.get("records", []) if isinstance(data, dict) else []
    needle = q.strip().casefold()
    cutoff_days = {"7": 7, "30": 30}.get(date_range)
    matching = []
    for row in rows:
        if (archived is not None and bool(row.get("archived")) != archived) or (status and row.get("status", "New") != status):
            continue
        searchable = " ".join(str(row.get(key, "")) for key in ("name", "email", "phone", "subject", "message")).casefold()
        if needle and needle not in searchable:
            continue
        if date_range in ("7", "30", "older"):
            try:
                created = datetime.fromisoformat(str(row.get("created_at", "")).replace("Z", "+00:00"))
                if created.tzinfo is None:
                    created = created.replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            age_days = (datetime.now(timezone.utc) - created).total_seconds() / 86400
            if cutoff_days and age_days > cutoff_days or date_range == "older" and age_days <= 30:
                continue
        matching.append(row)
    matching.sort(key=lambda row: str(row.get("created_at", "")), reverse=True)
    start = (page - 1) * per_page
    return {"records": matching[start:start + per_page], "total": len(matching), "page": page, "per_page": per_page}


@app.put("/api/admin/orders/{order_id}")
async def update_order(order_id: str, request: Request) -> dict[str, Any]:
    require_same_origin(request)
    require_admin(request)
    body = await request.json()
    def apply(data):
        row = next((item for item in data.get("records", []) if item.get("id") == order_id), None)
        if not row:
            raise HTTPException(404, "Order could not be found.")
        row["status"] = safe_text(body.get("status"), "Order status", 60, True)
        return row
    return update_json("orders", apply)


@app.delete("/api/admin/orders/{order_id}")
def delete_order(order_id: str, request: Request) -> dict[str, bool]:
    require_same_origin(request)
    require_admin(request)
    def apply(data):
        records = data.get("records", [])
        remaining = [row for row in records if row.get("id") != order_id]
        if len(remaining) == len(records):
            raise HTTPException(404, "Order could not be found.")
        data["records"] = remaining
        return {"ok": True}
    return update_json("orders", apply)


@app.put("/api/admin/enquiries/{enquiry_id}")
async def update_enquiry(enquiry_id: str, request: Request) -> dict[str, Any]:
    require_same_origin(request)
    require_admin(request)
    body = await request.json()
    def apply(data):
        row = next((item for item in data.get("records", []) if item.get("id") == enquiry_id), None)
        if not row:
            raise HTTPException(404, "Message could not be found.")
        action = body.get("action")
        if action == "archive":
            row["archived"] = True
        elif action == "restore":
            row["archived"] = False
        elif action in ("Pending", "Replied", "New"):
            row["status"] = action
        else:
            raise HTTPException(400, "Choose a valid message action.")
        return row
    return update_json("enquiries", apply)


@app.delete("/api/admin/enquiries/{enquiry_id}")
def delete_enquiry(enquiry_id: str, request: Request) -> dict[str, bool]:
    require_same_origin(request)
    require_admin(request)
    def apply(data):
        records = data.get("records", [])
        remaining = [row for row in records if row.get("id") != enquiry_id]
        if len(remaining) == len(records):
            raise HTTPException(404, "Message could not be found.")
        data["records"] = remaining
        return {"ok": True}
    return update_json("enquiries", apply)


@app.exception_handler(HTTPException)
async def http_error(_request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)


STATIC_FILES = {"robots.txt", "sitemap.xml", "favicon.ico"}
STATIC_DIRS = {"assets", "css", "images", "js"}
HTML_PAGES = {"index.html", "shop.html", "product.html", "cart.html", "checkout.html", "confirmation.html", "about.html", "contact.html", "admin.html", "admin-setup.html"}


@app.get("/{requested:path}")
def static_file(requested: str):
    requested = requested or "index.html"
    first = requested.split("/", 1)[0]
    if requested not in HTML_PAGES | STATIC_FILES and first not in STATIC_DIRS:
        raise HTTPException(404, "Not found.")
    if first == "images":
        target = (IMAGE_DIR / Path(*requested.split("/")[1:])).resolve()
        allowed_root = IMAGE_DIR.resolve()
    else:
        target = (ROOT / requested).resolve()
        allowed_root = ROOT
    try:
        target.relative_to(allowed_root)
    except ValueError:
        raise HTTPException(404, "Not found.")
    if not target.is_file():
        raise HTTPException(404, "Not found.")
    media = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return FileResponse(target, media_type=media)


initialize_storage()
