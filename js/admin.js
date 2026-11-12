import { api } from "./api.js";
import { activeSale, escapeHtml, isAvailableForSale, money, productVisual } from "./store.js";

const $ = (id) => document.getElementById(id);
let products = [];
let settings = {};
let discounts = {};
let activeImages = [];
let homepageImage = "";
let enquiryRows = [];
let enquiryPage = 1;
let enquiryTotal = 0;
let recoveryFromDashboard = false;

function show(node, visible) { if (node) node.classList.toggle("hidden", !visible); }
function notify(text, error = false) {
  const toast = $("admin-toast");
  toast.textContent = text;
  toast.classList.toggle("error", error);
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toast.textContent = ""; toast.classList.remove("error"); }, 5000);
}
function fieldMessage(id, text = "", error = false) {
  const node = $(id);
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("error", error);
}
function setBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) { button.dataset.oldText = button.textContent; button.textContent = label || "Saving…"; }
  else if (button.dataset.oldText) { button.textContent = button.dataset.oldText; delete button.dataset.oldText; }
}
function showLogin(message = "") {
  show($("admin-login-view"), true);
  show($("admin-app-view"), false);
  fieldMessage("login-error", message, Boolean(message));
}
function showDashboard() {
  show($("admin-login-view"), false);
  show($("admin-recovery-view"), false);
  show($("admin-first-setup-view"), false);
  show($("admin-app-view"), true);
}

function showFirstAdminSetup() {
  show($("admin-login-view"), false);
  show($("admin-recovery-view"), false);
  show($("admin-first-setup-view"), true);
  show($("admin-app-view"), false);
}
function byProductId(id) { return products.find((item) => Number(item.id) === Number(id)); }

async function loadDashboard() {
  const [loadedProducts, loadedSettings, loadedDiscounts, orders] = await Promise.all([
    api("/api/admin/products"), api("/api/admin/settings"), api("/api/discounts"),
    api("/api/admin/orders"), fetchEnquiries(),
  ]);
  products = loadedProducts;
  settings = loadedSettings;
  discounts = loadedDiscounts;
  loadSettings();
  loadDiscountSettings();
  renderProducts();
  renderOrders(orders);
  renderEnquiries();
}

function renderProducts() {
  const host = $("admin-products-list");
  if (!host) return;
  const query = $("admin-product-search").value.trim().toLowerCase();
  const filter = $("admin-product-filter").value;
  const rows = products.filter((item) => {
    const available = isAvailableForSale(item);
    const found = `${item.name} ${item.category} ${item.slug}`.toLowerCase().includes(query);
    if (!found) return false;
    if (filter === "available") return available;
    if (filter === "unavailable") return !available;
    if (filter === "hidden") return !item.active;
    if (filter === "sale") return activeSale(item);
    return true;
  });
  $("product-count").textContent = `${rows.length} shown · ${products.length} total furniture items`;
  if (!rows.length) { host.innerHTML = '<div class="empty-state"><h2>No matching furniture</h2><p>Try another search or add a product.</p></div>'; return; }
  host.innerHTML = '<div class="admin-products-grid">' + rows.map((item) => {
    const status = !item.active ? "Hidden from website" : isAvailableForSale(item) ? "Available for sale" : "Currently unavailable";
    const flags = [item.is_demo && "Draft sample", item.featured && "Homepage", item.bestseller && "Best Seller", item.new_arrival && "New Arrival", activeSale(item) && "On Sale"].filter(Boolean).join(" · ");
    return `<article class="admin-product-row">${productVisual(item)}<div class="admin-product-copy"><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.category)} · ${money(item.price_paise)}${item.sale_price_paise ? ` · Sale ${money(item.sale_price_paise)}` : ""}<br>${escapeHtml(status)}<br><small>${escapeHtml(flags)}</small></p></div><div class="admin-product-actions"><button class="button button-outline-dark" type="button" data-available="${Number(item.id)}" ${item.is_demo ? "disabled title=\"Edit this draft before publishing.\"" : ""}>${item.is_demo ? "Draft sample" : isAvailableForSale(item) ? "Mark unavailable" : "Mark available"}</button><button class="button button-outline-dark" type="button" data-publish="${Number(item.id)}" ${item.is_demo ? "disabled title=\"Edit this draft before publishing.\"" : ""}>${item.is_demo ? "Edit before publishing" : item.active ? "Hide from shop" : "Show in shop"}</button><button class="button button-outline-dark" type="button" data-edit="${Number(item.id)}">Edit Furniture</button><button class="button button-outline-dark admin-delete" type="button" data-delete="${Number(item.id)}">Delete Furniture</button></div></article>`;
  }).join("") + "</div>";
  host.querySelectorAll("[data-edit]").forEach((button) => {
    const item = byProductId(button.dataset.edit);
    if (item) {
      const link = document.createElement("a");
      link.className = "button button-outline-dark";
      link.href = "/product.html?slug=" + encodeURIComponent(item.slug);
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "View in Shop";
      button.parentElement.prepend(link);
    }
    button.addEventListener("click", () => openProduct(button.dataset.edit));
  });
  host.querySelectorAll("[data-available]").forEach((button) => button.addEventListener("click", () => patchProduct(button.dataset.available, (item) => ({ ...item, availability_confirmed: true, in_stock: !isAvailableForSale(item), stock_quantity: !isAvailableForSale(item) && Number(item.stock_quantity) === 0 ? null : item.stock_quantity }))));
  host.querySelectorAll("[data-publish]").forEach((button) => button.addEventListener("click", () => patchProduct(button.dataset.publish, (item) => ({ ...item, active: !item.active }))));
  host.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", async () => {
    const item = byProductId(button.dataset.delete);
    if (!item || !confirm(`Remove ${item.name} from the shop? Its photo files will be kept.`)) return;
    try { await api(`/api/admin/products/${item.id}`, { method: "DELETE" }); products = products.filter((row) => row.id !== item.id); renderProducts(); notify("Furniture removed from the shop."); }
    catch (error) { notify(error.message, true); }
  }));
}

async function patchProduct(id, makeBody) {
  const item = byProductId(id);
  if (!item) return;
  try {
    const saved = await api(`/api/admin/products/${item.id}`, { method: "PUT", body: makeBody(item) });
    products[products.findIndex((row) => row.id === saved.id)] = saved;
    renderProducts();
    notify("Furniture updated.");
  } catch (error) { notify(error.message, true); }
}

function googleDriveImageId(value) {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "drive.google.com") return "";
    return url.pathname.match(/^\/file\/d\/([^/]+)/)?.[1] || url.searchParams.get("id") || "";
  } catch { return ""; }
}

function renderImagePreview() {
  const host = $("product-image-list");
  host.replaceChildren();
  activeImages.forEach((src, index) => {
    const chip = document.createElement("span"); chip.className = "image-chip";
    const image = document.createElement("img"); image.alt = "Furniture photo"; image.loading = "eager"; image.decoding = "async";
    const driveId = googleDriveImageId(src);
    if (driveId) {
      image.src = `https://drive.google.com/thumbnail?id=${encodeURIComponent(driveId)}&sz=w1200`;
      image.dataset.fallbackSrc = `https://drive.google.com/uc?export=view&id=${encodeURIComponent(driveId)}`;
    } else image.src = src;
    const caption = document.createElement("span"); caption.textContent = `Photo ${index + 1}`;
    image.addEventListener("load", () => { caption.textContent = `Photo ${index + 1}`; chip.classList.remove("image-chip-unavailable"); });
    image.addEventListener("error", () => {
      if (image.dataset.fallbackSrc) { const fallback = image.dataset.fallbackSrc; delete image.dataset.fallbackSrc; image.src = fallback; return; }
      image.hidden = true; chip.classList.add("image-chip-unavailable");
      caption.textContent = `Photo ${index + 1} could not load. Make the link public or upload the image file.`;
    });
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "\u00D7"; remove.setAttribute("aria-label", "Remove photo");
    remove.addEventListener("click", () => { activeImages.splice(index, 1); renderImagePreview(); });
    chip.append(image, caption, remove); host.append(chip);
  });
}

function setHomepagePreview(src, caption) {
  const host = $("home-hero-image-preview");
  host.replaceChildren();
  if (!src) return;
  const image = document.createElement("img"); image.src = src; image.alt = caption; image.className = "homepage-image-preview";
  const label = document.createElement("small"); label.textContent = caption;
  host.append(image, label);
}
function clearProductForm() {
  $("product-form").reset(); $("product-id").value = "";
  $("product-active").checked = true; $("product-availability").checked = true; $("product-discount").checked = true;
  activeImages = []; fieldMessage("product-image-link-error"); $("product-form-title").textContent = "Add new product";
  fieldMessage("product-error"); fieldMessage("product-save-feedback"); renderImagePreview();
}
function openProduct(id = null) {
  clearProductForm();
  const item = id == null ? null : byProductId(id);
  if (item) {
    $("product-id").value = item.id; $("product-name").value = item.name || "";
    $("product-category").value = item.category || "Chairs";
    $("product-price").value = (Number(item.price_paise || 0) / 100).toFixed(2);
    $("product-sale-price").value = item.sale_price_paise ? (Number(item.sale_price_paise) / 100).toFixed(2) : "";
    $("product-description").value = item.description || ""; activeImages = [...(item.images || [])];
    $("product-active").checked = item.active !== false; $("product-availability").checked = isAvailableForSale(item);
    $("product-featured").checked = Boolean(item.featured); $("product-best").checked = Boolean(item.bestseller);
    $("product-new").checked = Boolean(item.new_arrival); $("product-discount").checked = item.discount_eligible !== false;
    $("product-sale-stack").checked = Boolean(item.sale_stack_discounts); $("product-sale-active").checked = Boolean(item.sale_active);
    $("product-sale-start").value = item.sale_start_at ? new Date(item.sale_start_at).toISOString().slice(0, 16) : "";
    $("product-sale-end").value = item.sale_end_at ? new Date(item.sale_end_at).toISOString().slice(0, 16) : "";
    $("product-form-title").textContent = "Edit furniture";
  }
  renderImagePreview(); show($("product-form"), true); $("product-form").scrollIntoView({ behavior: "smooth", block: "start" });
}
function updateSalePreview() {
  const regular = Number($("product-price").value || 0), sale = Number($("product-sale-price").value || 0);
  if (!sale) { $("product-sale-active").checked = false; fieldMessage("sale-preview", "No sale is set. Customers see the regular price."); }
  else if (!regular || sale >= regular) { $("product-sale-active").checked = false; fieldMessage("sale-preview", "Sale price must be lower than the regular price.", true); }
  else { $("product-sale-active").checked = true; fieldMessage("sale-preview", `Customers save ${money(Math.round((regular - sale) * 100))} on this item.`); }
}
async function uploadPhoto(file, kind) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Choose a JPG, PNG, or WebP photo.");
  if (file.size > 15 * 1024 * 1024) throw new Error("Choose a photo smaller than 15 MB.");
  const form = new FormData(); form.append("file", file); form.append("kind", kind);
  const result = await api("/api/admin/upload-image", { method: "POST", body: form });
  return result.url;
}
function normalizeProductImageLink(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error("Paste a valid public image link."); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Use a public HTTPS image link.");
  if (url.hostname.toLowerCase() === "drive.google.com") {
    const fileId = googleDriveImageId(url.href);
    if (!fileId || !/^[A-Za-z0-9_-]{5,}$/.test(fileId)) throw new Error("Use a Google Drive link to one image file, not a folder.");
    return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1200`;
  }
  return url.href;
}
async function saveProduct(event) {
  event.preventDefault();
  const button = $("save-product"); setBusy(button, true, "Saving furniture…");
  try {
    const old = $("product-id").value ? byProductId($("product-id").value) : null;
    const regular = Number($("product-price").value), saleInput = $("product-sale-price").value;
    const sale = saleInput ? Number(saleInput) : null;
    if (sale !== null && (!Number.isFinite(sale) || sale <= 0 || sale >= regular)) throw new Error("Sale price must be lower than the regular price.");
    if (!activeImages.length) throw new Error("Add at least one furniture photo or image link.");
    const start = $("product-sale-start").value, end = $("product-sale-end").value;
    if (start && end && new Date(start) >= new Date(end)) throw new Error("Sale end must be after its start.");
    const body = {
      name: $("product-name").value.trim(), category: $("product-category").value,
      price_paise: Math.round(regular * 100), sale_price_paise: sale === null ? null : Math.round(sale * 100),
      sale_active: Boolean(sale && $("product-sale-active").checked), sale_start_at: start ? new Date(start).toISOString() : null,
      sale_end_at: end ? new Date(end).toISOString() : null, sale_stack_discounts: $("product-sale-stack").checked,
      description: $("product-description").value.trim(), images: activeImages,
      availability_confirmed: true, in_stock: $("product-availability").checked,
      stock_quantity: old?.stock_quantity ?? null, featured: $("product-featured").checked,
      bestseller: $("product-best").checked, new_arrival: $("product-new").checked,
      discount_eligible: $("product-discount").checked, active: $("product-active").checked,
      is_demo: false, demo_approved: false,
    };
    const saved = await api(old ? `/api/admin/products/${old.id}` : "/api/admin/products", { method: old ? "PUT" : "POST", body });
    if (old) products[products.findIndex((row) => row.id === old.id)] = saved; else products.unshift(saved);
    renderProducts(); $("product-images").value = ""; show($("product-form"), false);
    notify(old ? "Furniture updated and saved." : "Furniture added and saved.");
  } catch (error) { fieldMessage("product-error", error.message || "Furniture could not be saved. Please try again.", true); }
  finally { setBusy(button, false); }
}

function loadSettings() {
  $("home-heading").value = settings.homepage_heading || "";
  $("home-description").value = settings.hero_description || "";
  $("home-cta-text").value = settings.hero_cta_text || "Shop Furniture";
  $("home-hero-image").value = ""; homepageImage = settings.hero_image || "";
  setHomepagePreview(homepageImage, "Current homepage photo");
  $("home-promo-heading-setting").value = settings.promotional_heading || "Buy More. Save More.";
  $("home-new-enabled").checked = settings.new_arrivals_enabled !== false;
  $("home-offers-enabled").checked = settings.special_offers_enabled !== false;
  $("setting-name").value = settings.business_name || "";
  $("setting-whatsapp").value = settings.whatsapp_number || "+91 92172 99927";
  $("setting-email").value = settings.email || "";
  $("setting-hours").value = settings.business_hours || "";
  $("setting-address").value = settings.address || "";
  $("setting-announcement").value = settings.announcement || "";
}
function addTierRow(tier = { min_items: "", percent: "" }) {
  const row = document.createElement("div"); row.className = "discount-tier-row";
  row.innerHTML = `<label>Buy <input class="input tier-items" type="number" min="1" max="999" value="${escapeHtml(tier.min_items ?? "")}" required aria-label="Number of eligible items"> items</label><label>Save <input class="input tier-percent" type="number" min="0" max="80" step="0.1" value="${escapeHtml(tier.percent ?? "")}" required aria-label="Discount percentage"> %</label><button class="button button-outline-dark admin-delete tier-remove" type="button">Remove</button>`;
  row.querySelector(".tier-remove").addEventListener("click", () => row.remove()); $("discount-tiers").append(row);
}
function loadDiscountSettings() {
  $("discount-tiers").replaceChildren(); (discounts.tiers || []).forEach(addTierRow);
  $("max-discount").value = discounts.max_discount_percent ?? 15;
  $("minimum-price").value = (Number(discounts.min_eligible_price_paise || 0) / 100).toFixed(2);
  $("maximum-savings").value = (Number(discounts.max_discount_paise || 0) / 100).toFixed(2);
  $("free-delivery").checked = Boolean(discounts.free_delivery_enabled); $("discounts-active").checked = discounts.discounts_enabled !== false;
}

function renderOrders(rows) {
  const status = $("orders-filter").value;
  const shown = rows.filter((row) => !status || row.status === status);
  $("orders-error").textContent = "";
  $("admin-orders-list").innerHTML = shown.length ? shown.map((row) => `<article class="admin-inbox-item"><h3>${escapeHtml(row.customer_name)} · ${escapeHtml(row.id)}</h3><p>${escapeHtml(row.phone)} · ${escapeHtml(row.address)}, ${escapeHtml(row.city)}, ${escapeHtml(row.state)}</p><p>${(row.lines || []).map((line) => `${escapeHtml(line.name)} × ${line.quantity}`).join("<br>")}</p><strong>${money(row.total_paise)}</strong><label class="field-label">Order status<select class="input" data-order-status="${escapeHtml(row.id)}">${["Pending showroom confirmation", "Confirmed", "Processing", "Delivered", "Cancelled"].map((item) => `<option${row.status === item ? " selected" : ""}>${item}</option>`).join("")}</select></label><small>${escapeHtml(row.created_at || "")}</small></article>`).join("") : '<div class="empty-state"><h2>No saved orders</h2><p>Orders sent through checkout will appear here.</p></div>';
  shown.forEach((row, index) => {
    const card = $("admin-orders-list").children[index];
    if (!card) return;
    const actions = document.createElement("div"); actions.className = "admin-product-actions";
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "button button-outline-dark admin-delete";
    remove.textContent = "Delete Order"; remove.dataset.deleteOrder = row.id;
    actions.append(remove); card.append(actions);
  });
  $("admin-orders-list").querySelectorAll("[data-delete-order]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("Delete this order? This cannot be undone.")) return;
    setBusy(button, true, "Deleting...");
    try {
      await api(`/api/admin/orders/${encodeURIComponent(button.dataset.deleteOrder)}`, { method: "DELETE" });
      renderOrders(await api("/api/admin/orders"));
      notify("Order deleted.");
    } catch (error) { notify(error.message, true); }
    finally { setBusy(button, false); }
  }));
  $("admin-orders-list").querySelectorAll("[data-order-status]").forEach((select) => select.addEventListener("change", async () => {
    try { await api(`/api/admin/orders/${encodeURIComponent(select.dataset.orderStatus)}`, { method: "PUT", body: { status: select.value } }); notify("Order status saved."); }
    catch (error) { notify(error.message, true); }
  }));
}
async function fetchEnquiries() {
  const params = new URLSearchParams({ page: String(enquiryPage), per_page: "20" });
  const result = await api(`/api/admin/enquiries/page?${params}`);
  enquiryRows = result.records;
  enquiryTotal = result.total;
  return result;
}

function renderEnquiries() {
  const pageCount = Math.max(1, Math.ceil(enquiryTotal / 20));
  $("enquiries-count").textContent = `${enquiryTotal} ${enquiryTotal === 1 ? "message" : "messages"}`;
  $("enquiries-page-label").textContent = `Page ${enquiryPage} of ${pageCount}`;
  $("enquiries-previous").disabled = enquiryPage <= 1;
  $("enquiries-next").disabled = enquiryPage >= pageCount;
  $("enquiries-error").textContent = "";
  $("admin-enquiries-list").innerHTML = enquiryRows.length ? enquiryRows.map((row) => {
    let digits = String(row.phone || "").replace(/\D/g, "");
    if (digits.length === 10) digits = `91${digits}`;
    else if (digits.startsWith("0") && digits.length === 11) digits = `91${digits.slice(1)}`;
    const message = `Hello ${row.name || "there"}, about your enquiry${row.subject ? ` on ${row.subject}` : ""}. How can we help?`;
    const whatsapp = `https://wa.me/${encodeURIComponent(digits)}?text=${encodeURIComponent(message)}`;
    return `<article class="admin-inbox-item"><h3>${escapeHtml(row.name || "Customer")}</h3><p>${escapeHtml(row.phone || "No phone number")}</p><p>${escapeHtml(row.message || "")}</p><small>${escapeHtml(row.created_at || "")}</small><div class="admin-product-actions"><a class="button button-outline-dark" href="${whatsapp}" target="_blank" rel="noopener">WhatsApp Reply</a><button class="button button-outline-dark admin-delete" type="button" data-delete-enquiry="${escapeHtml(row.id)}">Delete Message</button></div></article>`;
  }).join("") : '<div class="empty-state"><h2>No customer messages</h2><p>New website messages will appear here.</p></div>';
  $("admin-enquiries-list").querySelectorAll("[data-delete-enquiry]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("Delete this customer message? This cannot be undone.")) return;
    setBusy(button, true, "Deleting...");
    try {
      await api(`/api/admin/enquiries/${encodeURIComponent(button.dataset.deleteEnquiry)}`, { method: "DELETE" });
      await refreshEnquiries();
      renderEnquiries();
      notify("Customer message deleted.");
    } catch (error) { notify(error.message, true); }
    finally { setBusy(button, false); }
  }));
}

async function refreshEnquiries() {
  await fetchEnquiries();
  if (!enquiryRows.length && enquiryPage > 1) { enquiryPage--; await fetchEnquiries(); }
}

async function initialize() {
  $("admin-login-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const button = $("login-button"); setBusy(button, true, "Checking…");
    try {
      await api("/api/admin/login", { method: "POST", body: { password: $("admin-password").value } });
      $("admin-password").value = ""; await loadDashboard(); showDashboard(); notify("You are signed in. Changes are saved to the website.");
    } catch (error) { fieldMessage("login-error", error.message, true); }
    finally { setBusy(button, false); }
  });
  $("toggle-admin-password").addEventListener("click", () => {
    const input = $("admin-password"); input.type = input.type === "password" ? "text" : "password";
    $("toggle-admin-password").textContent = input.type === "password" ? "Show" : "Hide";
  });
  $("admin-logout").addEventListener("click", async () => { try { await api("/api/admin/logout", { method: "POST" }); } finally { showLogin("You are signed out."); } });
  $("product-form").addEventListener("submit", saveProduct);
  $("add-product").addEventListener("click", () => openProduct());
  $("cancel-product").addEventListener("click", () => show($("product-form"), false));
  $("close-product-form").addEventListener("click", () => show($("product-form"), false));
  $("product-images").addEventListener("change", async (event) => {
    const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = "";
    const button = $("save-product"); setBusy(button, true, "Uploading photos…");
    try { for (const file of files) activeImages.push(await uploadPhoto(file, "product")); renderImagePreview(); fieldMessage("product-error"); }
    catch (error) { fieldMessage("product-error", error.message, true); }
    finally { setBusy(button, false); }
  });
  $("add-product-image-link").addEventListener("click", () => {
    try {
      const source = normalizeProductImageLink($("product-image-url").value);
      if (activeImages.includes(source)) throw new Error("This image is already added.");
      if (activeImages.length >= 12) throw new Error("A product can have up to 12 photos.");
      activeImages.push(source);
      $("product-image-url").value = "";
      renderImagePreview();
      fieldMessage("product-image-link-error");
      fieldMessage("product-error");
    } catch (error) { fieldMessage("product-image-link-error", error.message, true); }
  });
  $("home-hero-image").addEventListener("change", async (event) => {
    const file = event.currentTarget.files?.[0]; if (!file) return;
    fieldMessage("homepage-error", "Uploading homepage photo…");
    try { homepageImage = await uploadPhoto(file, "homepage"); setHomepagePreview(homepageImage, "New homepage photo"); fieldMessage("homepage-error"); }
    catch (error) { fieldMessage("homepage-error", error.message, true); }
  });
  ["product-price", "product-sale-price"].forEach((id) => $(id).addEventListener("input", updateSalePreview));
  $("admin-product-search").addEventListener("input", renderProducts); $("admin-product-filter").addEventListener("change", renderProducts);
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-view]").forEach((tab) => { tab.classList.toggle("active", tab === button); tab.setAttribute("aria-selected", String(tab === button)); });
    document.querySelectorAll("[data-panel]").forEach((panel) => show(panel, panel.dataset.panel === button.dataset.view));
  }));
  document.querySelectorAll("[data-quick]").forEach((button) => button.addEventListener("click", () => {
    const task = button.dataset.quick; document.querySelector(`[data-view="${task === "add" ? "products" : task}"]`)?.click(); if (task === "add") openProduct();
  }));
  $("homepage-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const button = $("save-homepage"); setBusy(button, true, "Saving homepage…");
    try {
      const body = { homepage_heading: $("home-heading").value.trim(), hero_description: $("home-description").value.trim(), hero_cta_text: $("home-cta-text").value.trim(), hero_cta_url: "/shop.html", hero_image: homepageImage.split("?", 1)[0], promotional_heading: $("home-promo-heading-setting").value.trim(), new_arrivals_enabled: $("home-new-enabled").checked, special_offers_enabled: $("home-offers-enabled").checked };
      settings = await api("/api/admin/settings", { method: "PUT", body }); homepageImage = settings.hero_image + `?v=${Date.now()}`; setHomepagePreview(homepageImage, "Saved homepage photo"); fieldMessage("homepage-error"); notify("Homepage changes saved.");
    } catch (error) { fieldMessage("homepage-error", error.message, true); }
    finally { setBusy(button, false); }
  });
  $("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const button = $("save-settings"); setBusy(button, true, "Saving store details…");
    try {
      settings = await api("/api/admin/settings", { method: "PUT", body: { business_name: $("setting-name").value.trim(), whatsapp_number: $("setting-whatsapp").value.replace(/\D/g, ""), phone: $("setting-whatsapp").value.trim(), email: $("setting-email").value.trim(), business_hours: $("setting-hours").value.trim(), address: $("setting-address").value.trim(), announcement: $("setting-announcement").value.trim() } });
      fieldMessage("settings-error"); notify("Store details saved.");
    } catch (error) { fieldMessage("settings-error", error.message, true); }
    finally { setBusy(button, false); }
  });
  $("discount-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const button = event.submitter || $("discount-form").querySelector("[type=submit]"); setBusy(button, true, "Saving offers…");
    try {
      const tiers = Array.from(document.querySelectorAll(".discount-tier-row")).map((row) => ({ min_items: Number(row.querySelector(".tier-items").value), percent: Number(row.querySelector(".tier-percent").value) }));
      discounts = await api("/api/admin/discounts", { method: "PUT", body: { tiers, max_discount_percent: Number($("max-discount").value), min_eligible_price_paise: Math.round(Number($("minimum-price").value || 0) * 100), max_discount_paise: Math.round(Number($("maximum-savings").value || 0) * 100), free_delivery_enabled: $("free-delivery").checked, discounts_enabled: $("discounts-active").checked } });
      fieldMessage("discount-error"); notify("Offers saved.");
    } catch (error) { fieldMessage("discount-error", error.message, true); }
    finally { setBusy(button, false); }
  });
  $("add-tier").addEventListener("click", () => addTierRow());
  $("password-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const next = $("new-password").value;
    if (next !== $("confirm-password").value) return fieldMessage("password-error", "The new passwords do not match.", true);
    const button = $("save-password"); setBusy(button, true, "Updating password…");
    try { await api("/api/admin/change-password", { method: "POST", body: { current_password: $("current-password").value, new_password: next } }); $("password-form").reset(); fieldMessage("password-error"); notify("Password changed successfully."); }
    catch (error) { fieldMessage("password-error", error.message, true); }
    finally { setBusy(button, false); }
  });
  $("use-master-recovery").addEventListener("click", () => {
    recoveryFromDashboard = true;
    show($("admin-app-view"), false);
    show($("admin-recovery-view"), true);
    $("recovery-form").reset(); fieldMessage("recovery-error");
  });
  $("orders-refresh")?.addEventListener("click", async () => { try { renderOrders(await api("/api/admin/orders")); } catch (e) { fieldMessage("orders-error", e.message, true); } });
  $("orders-filter")?.addEventListener("change", async () => { try { renderOrders(await api("/api/admin/orders")); } catch (e) { fieldMessage("orders-error", e.message, true); } });
  $("enquiries-refresh")?.addEventListener("click", async () => { try { enquiryPage = 1; await fetchEnquiries(); renderEnquiries(); } catch (error) { fieldMessage("enquiries-error", error.message, true); } });
  $("enquiries-previous")?.addEventListener("click", async () => { if (enquiryPage > 1) { enquiryPage--; await fetchEnquiries(); renderEnquiries(); } });
  $("enquiries-next")?.addEventListener("click", async () => { if (enquiryPage * 20 < enquiryTotal) { enquiryPage++; await fetchEnquiries(); renderEnquiries(); } });
  $("show-recovery").addEventListener("click", () => { recoveryFromDashboard = false; show($("admin-login-view"), false); show($("admin-recovery-view"), true); });
  $("cancel-recovery").addEventListener("click", () => {
    show($("admin-recovery-view"), false);
    if (recoveryFromDashboard) { recoveryFromDashboard = false; showDashboard(); }
    else show($("admin-login-view"), true);
  });
  $("recovery-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if ($("recovery-new-password").value !== $("recovery-confirm-password").value) return fieldMessage("recovery-error", "The new passwords do not match.", true);
    const button = $("recovery-submit"); setBusy(button, true, "Changing password…");
    try {
      const result = await api("/api/admin/recover", { method: "POST", body: { recovery_password: $("recovery-secret").value.trim(), new_password: $("recovery-new-password").value } });
      $("recovery-form").reset(); recoveryFromDashboard = false; showDashboard(); await loadDashboard();
      if (result.recovery_code) alert(`Password changed. Save this replacement recovery code now; it will only be shown once:\n\n${result.recovery_code}`);
      notify(result.recovered_with_master_password ? "Admin password reset. Your master recovery password is still active." : "Password changed. Your replacement recovery code was shown once.");
    } catch (error) { fieldMessage("recovery-error", error.message, true); }
    finally { setBusy(button, false); }
  });

  $("admin-first-setup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = $("first-admin-password").value;
    if (password !== $("first-admin-confirm").value) return fieldMessage("first-admin-error", "The passwords do not match.", true);
    const masterPassword = $("first-admin-master-password").value;
    if (masterPassword !== $("first-admin-master-confirm").value) return fieldMessage("first-admin-error", "The master recovery passwords do not match.", true);
    if (password === masterPassword) return fieldMessage("first-admin-error", "Choose different Admin and master recovery passwords.", true);
    const button = $("first-admin-submit"); setBusy(button, true, "Saving password…");
    try {
      const result = await api("/api/admin/setup", { method: "POST", body: { password, master_password: masterPassword } });
      $("admin-first-setup-form").reset();
      await loadDashboard(); showDashboard();
      alert(`Admin and master recovery passwords saved. Store this one-time backup code somewhere private. It is shown only once:\n\n${result.recovery_code}`);
      notify("Admin setup is complete.");
    } catch (error) { fieldMessage("first-admin-error", error.message, true); }
    finally { setBusy(button, false); }
  });

  try {
    const status = await api("/api/admin/status");
    if (!status.initialized) showFirstAdminSetup();
    else if (status.authenticated) { await loadDashboard(); showDashboard(); }
  } catch (error) { fieldMessage("login-error", error.message || "The store server is not reachable. Run start-server.bat and open http://127.0.0.1:8000/admin.html.", true); }
}

initialize().catch((error) => { console.error(error); showLogin("The admin page could not connect to the store server. Start the FastAPI server and refresh."); });
