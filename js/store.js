import { api } from "./api.js";

const CART_KEY = "onby_cart_v1";
let miniCartOpener = null;
let previousBodyOverflow = "";
let inertedBackground = [];
let memoryCart = [];
let cartStorageUnavailable = false;

export function escapeHtml(value) {
  return String(value == null ? "" : value).replace(
    /[&<>"']/g,
    function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char];
    },
  );
}

export function money(paise) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format((Number(paise) || 0) / 100);
}

export function activeSale(product, now) {
  if (!product || !product.sale_active || !product.sale_price_paise) return false;
  const regular = Number(product.price_paise);
  const sale = Number(product.sale_price_paise);
  const time = now == null ? Date.now() : Number(now);
  if (!Number.isFinite(sale) || sale <= 0 || sale >= regular) return false;
  if (product.sale_start_at && Date.parse(product.sale_start_at) > time) return false;
  if (product.sale_end_at && Date.parse(product.sale_end_at) <= time) return false;
  return true;
}

export function currentPrice(product) {
  return activeSale(product) ? Number(product.sale_price_paise) : Number(product.price_paise);
}

export function isAvailableForSale(product) {
  return Boolean(product && product.availability_confirmed && product.in_stock &&
    (product.stock_quantity == null || Number(product.stock_quantity) > 0));
}

export function productPriceMarkup(product, detail) {
  if (!activeSale(product)) return '<span class="' + (detail ? "detail-price-current" : "product-price") + '">' + money(product.price_paise) + "</span>";
  const saving = Number(product.price_paise) - Number(product.sale_price_paise);
  const percent = Math.round((saving / Number(product.price_paise)) * 100);
  return '<span class="sale-price-group' + (detail ? " sale-price-detail" : "") + '"><del>' + money(product.price_paise) +
    '</del><strong class="' + (detail ? "detail-price-current" : "product-price") + '">' + money(product.sale_price_paise) +
    '</strong><span class="sale-saving">Save ' + money(saving) + ' (' + percent + '%)</span></span>';
}

export { api };

export function getCart() {
  if (cartStorageUnavailable) return memoryCart.slice();
  try {
    const parsed = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(function (item) {
        return (
          item &&
          Number.isInteger(Number(item.id)) &&
          Number(item.id) > 0 &&
          Number.isInteger(Number(item.quantity)) &&
          Number(item.quantity) > 0
        );
      })
      .map(function (item) {
        return {
          id: Number(item.id),
          quantity: Math.min(99, Number(item.quantity)),
        };
      });
  } catch (_error) {
    cartStorageUnavailable = true;
    return memoryCart.slice();
  }
}

export function saveCart(items) {
  const clean = items
    .filter(function (item) {
      return item && Number(item.quantity) > 0;
    })
    .map(function (item) {
      return {
        id: Number(item.id),
        quantity: Math.min(99, Math.max(1, Number(item.quantity))),
      };
    });
  memoryCart = clean;
  try { localStorage.setItem(CART_KEY, JSON.stringify(clean)); }
  catch (_error) { cartStorageUnavailable = true; }
  window.dispatchEvent(new CustomEvent("onby:cartchange", { detail: clean }));
  return clean;
}

export function addToCart(productId, quantity) {
  const items = getCart();
  const id = Number(productId);
  const qty = Math.max(1, Math.min(99, Number(quantity) || 1));
  const existing = items.find(function (item) {
    return item.id === id;
  });
  if (existing) existing.quantity = Math.min(99, existing.quantity + qty);
  else items.push({ id: id, quantity: qty });
  return saveCart(items);
}

export function setCartQuantity(productId, quantity) {
  const items = getCart();
  const id = Number(productId);
  if (Number(quantity) <= 0)
    return saveCart(
      items.filter(function (item) {
        return item.id !== id;
      }),
    );
  const existing = items.find(function (item) {
    return item.id === id;
  });
  if (existing) existing.quantity = Math.min(99, Math.max(1, Number(quantity)));
  return saveCart(items);
}

export function cartItemsForQuote(items) {
  return items.map(function (item) {
    return { product_id: item.id, quantity: item.quantity };
  });
}

function lineArt(category) {
  const kind = String(category || "").toLowerCase();
  if (kind.includes("sofa")) {
    return '<svg viewBox="0 0 180 150" aria-hidden="true"><path d="M42 77V55c0-9 7-16 16-16h64c9 0 16 7 16 16v22"/><path d="M42 64h-8c-7 0-12 6-12 13v31c0 7 5 12 12 12h132c7 0 12-5 12-12V77c0-7-5-13-12-13h-8"/><path d="M34 92h112M48 78v14m84-14v14M37 120v15m106-15v15M58 40v43m64-43v43"/></svg>';
  }
  if (kind.includes("table")) {
    return '<svg viewBox="0 0 180 150" aria-hidden="true"><path d="M30 51h120l-9 18H39z"/><path d="M47 69v63m86-63v63M39 132h102M55 83h70"/></svg>';
  }
  if (kind.includes("office")) {
    return '<svg viewBox="0 0 180 150" aria-hidden="true"><path d="M62 20h56v49H62zM55 34h-9v44h88V34h-9M90 69v29m0 0-31 16m31-16 31 16m-31-16v34M74 126h32"/></svg>';
  }
  if (kind.includes("chair")) {
    return '<svg viewBox="0 0 180 150" aria-hidden="true"><path d="M58 22h64v55H58zM48 76h84v22H48zM57 98l-10 34m76-34 10 34M58 77V54h64v23m-43 21v26m24-26v26"/></svg>';
  }
  return '<svg viewBox="0 0 180 150" aria-hidden="true"><path d="M38 47h104v25H38zM49 72v57m82-57v57M43 129h94"/></svg>';
}

export function productVisual(product, className, imageLoading) {
  const images = Array.isArray(product.images) ? product.images : [];
  const src = images.length ? images[0] : "";
  const outer = className ? "product-visual " + className : "product-visual";
  let visual = "";
  if (src) {
    visual =
      '<img class="product-photo" src="' +
      escapeHtml(src) +
      '" alt="' +
      escapeHtml(product.name) +
      ' furniture photograph" loading="' + (imageLoading || "lazy") + '" decoding="async">';
  } else {
    visual =
      '<div class="product-placeholder" role="img" aria-label="Product photo not available yet">' +
      '<span class="placeholder-art">' +
      lineArt(product.category) +
      "</span>" +
      '<span class="placeholder-label">Product photo coming soon</span></div>';
  }
  const badge = isAvailableForSale(product)
    ? '<span class="product-badge">Available for sale</span>'
    : product.availability_confirmed
      ? '<span class="product-badge stock-out">Currently unavailable</span>'
      : '<span class="product-badge">Check availability</span>';
  return '<div class="' + outer + '">' + visual + badge + "</div>";
}

export function productCard(product, discountRules) {
  const href = pageHref("product.html") + "?slug=" + encodeURIComponent(product.slug);
  const availability = !isAvailableForSale(product);
  const tags = [];
  if (product.new_arrival) tags.push("New arrival");
  if (product.bestseller) tags.push("Best Seller");
  if (activeSale(product)) tags.push("Special Offer");
  const offerIsActive = Boolean(discountRules && discountRules.discounts_enabled);
  const eligible = product.discount_eligible &&
    (!activeSale(product) || product.sale_stack_discounts) &&
    currentPrice(product) >= Number(discountRules ? discountRules.min_eligible_price_paise : 0);
  const offerLabel = !offerIsActive ? "" :
    (eligible ? "Bundle discount applies" : (activeSale(product) ? "Sale price only · no bundle discount" : "Not included in bundle discount"));
  return (
    '<article class="product-card">' +
    '<a class="product-card-image-link" href="' +
    href +
    '" aria-label="View ' +
    escapeHtml(product.name) +
    '">' +
    productVisual(product) +
    '</a><div class="product-info"><p class="product-category">' +
    escapeHtml(product.category) +
    (tags.length ? " <span>· " + escapeHtml(tags.join(" · ")) + "</span>" : "") +
    "</p>" +
    '<h3><a href="' +
    href +
    '">' +
    escapeHtml(product.name) +
    "</a></h3>" +
    '<div class="product-price-row">' + productPriceMarkup(product) +
    (activeSale(product) ? '<span class="sale-price-note">Sale price</span>' : '<span class="price-note-label">Guide price</span>') + '</div>' +
    (offerLabel ? '<p class="product-offer-label' + (eligible ? "" : " excluded") + '">' + escapeHtml(offerLabel) + "</p>" : "") +
    '<div class="product-card-actions"><a class="product-details-link" href="' + href + '">View details</a><button class="button button-dark product-add-button" type="button" data-add-to-cart="' +
    Number(product.id) +
    '" aria-label="Add ' +
    escapeHtml(product.name) +
    ' to cart"' +
    (availability ? ' disabled title="This furniture is not currently available for sale"' : "") +
    ">Add to Cart</button></div></div></article>"
  );
}

export function toast(message, action) {
  let element = document.querySelector(".toast");
  if (!element) {
    element = document.createElement("div");
    element.className = "toast";
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    document.body.appendChild(element);
  }
  element.replaceChildren(document.createTextNode(message));
  element.classList.toggle("has-action", Boolean(action));
  if (action) {
    const link = document.createElement("a");
    link.href = action.href;
    link.textContent = action.label;
    element.appendChild(link);
  }
  element.classList.add("show");
  clearTimeout(element._hideTimer);
  element._hideTimer = setTimeout(function () {
    element.classList.remove("show");
  }, action ? 5200 : 2600);
}

function bagIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l1 13H4L5 8Z"/><path d="M9 9V6a3 3 0 0 1 6 0v3"/></svg>';
}

function searchIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.6"/><path d="m16 16 4.5 4.5"/></svg>';
}

function cartTotalCount() {
  return getCart().reduce(function (sum, item) {
    return sum + item.quantity;
  }, 0);
}

function pageHref(fileName) {
  const page = String(fileName).replace(/^\/+/, "");
  if (window.location.protocol === "file:") return page;

  const path = window.location.pathname;
  const productRoute = path.match(/^(.*\/)product\/[^/]+\/?$/);
  let basePath;
  if (productRoute) basePath = productRoute[1];
  else if (path.endsWith("/")) basePath = path;
  else basePath = path.slice(0, path.lastIndexOf("/") + 1);

  return basePath + page;
}

function updateNavSettings(settings) {
  const host = document.getElementById("site-header");
  if (!host) return;
  const brandName = escapeHtml(settings.business_name || "ON BY INCENSE DESIGN");
  const announcement = String(settings.announcement || "Furniture for your home and workspace · Visit our Kirti Nagar showroom")
    .replace(/\bdemo prices?\b/gi, "prices for guidance")
    .replace(/\bdemo\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const brandLink = host.querySelector(".brand");
  const brandElement = host.querySelector(".brand-name");
  const taglineElement = host.querySelector(".brand-copy small");
  const announcementElement = host.querySelector("#announcement-bar");
  if (brandElement) brandElement.innerHTML = brandName.replace(/ INCENSE DESIGN$/, " <span>INCENSE DESIGN</span>");
  if (brandLink) brandLink.setAttribute("aria-label", (settings.business_name || "ON BY INCENSE DESIGN") + " homepage");
  if (taglineElement) taglineElement.textContent = settings.tagline || "Imported & Indian Furniture | Interior Design Studio";
  if (announcementElement) announcementElement.textContent = announcement;
  const navHrefs = { home: "index.html", shop: "shop.html", about: "about.html", contact: "contact.html", cart: "cart.html" };
  host.querySelectorAll("[data-nav-page]").forEach(function (link) {
    const page = link.getAttribute("data-nav-page");
    if (navHrefs[page]) link.href = pageHref(navHrefs[page]);
    if (page === document.body.dataset.page) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const itemCount = String(cartTotalCount());
  const cartCount = host.querySelector("#cart-count");
  const navCount = host.querySelector("#nav-cart-count");
  if (cartCount) cartCount.textContent = itemCount;
  if (navCount) navCount.textContent = itemCount;
}

function renderNav(settings) {
  const host = document.getElementById("site-header");
  if (!host) return;
  const current = document.body.dataset.page;
  const brandName = escapeHtml(
    settings.business_name || "ON BY INCENSE DESIGN",
  );
  const tagline = escapeHtml(
    settings.tagline || "Imported & Indian Furniture | Interior Design Studio",
  );
  const announcement = String(
    settings.announcement ||
      "Furniture for your home and workspace · Visit our Kirti Nagar showroom",
  )
    .replace(/\bdemo prices?\b/gi, "prices for guidance")
    .replace(/\bdemo\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const navItems = [
    ["Home", "index.html", "home"],
    ["Shop Furniture", "shop.html", "shop"],
    ["About Us", "about.html", "about"],
    ["Contact", "contact.html", "contact"],
    ["Cart", "cart.html", "cart"],
  ];
  const links = navItems
    .map(function (entry) {
      const active = current === entry[2] ? ' aria-current="page"' : "";
      const cartCount = entry[2] === "cart"
        ? '<span class="nav-cart-count" id="nav-cart-count">' + cartTotalCount() + "</span>"
        : "";
      return '<a data-nav-page="' + entry[2] + '" href="' + pageHref(entry[1]) + '"' + active + ">" + entry[0] + cartCount + "</a>";
    })
    .join("");
  if (!host.querySelector(".site-header")) host.innerHTML =
    '<div class="announcement-bar" id="announcement-bar">' +
    escapeHtml(announcement) +
    "</div>" +
    '<header class="site-header"><div class="nav-shell">' +
    '<a class="brand" href="' + pageHref("index.html") + '" aria-label="' +
    brandName +
    ' homepage"><img src="/assets/logos/ON_BY_INCENSE_DESIGN_Logo.svg" alt="" width="42" height="42"><span class="brand-copy"><strong class="brand-name">' +
    brandName.replace(/ INCENSE DESIGN$/, " <span>INCENSE DESIGN</span>") +
    "</strong><small>" +
    tagline +
    "</small></span></a>" +
    '<nav class="main-nav" id="main-nav" aria-label="Main navigation">' +
    links +
    "</nav>" +
    '<div class="nav-actions"><form class="nav-search" id="nav-search" role="search"><label class="visually-hidden" for="nav-search-input">Search furniture</label><input id="nav-search-input" type="search" placeholder="Find your piece"><button type="submit" aria-label="Search">' +
    searchIcon() +
    "</button></form>" +
    '<button class="nav-icon" id="cart-open" type="button" aria-label="Open shopping bag"><span class="cart-count" id="cart-count">' +
    cartTotalCount() +
    "</span>" +
    bagIcon() +
    "</button>" +
    '<button class="menu-toggle" id="menu-toggle" type="button" aria-label="Open navigation menu" aria-expanded="false" aria-controls="main-nav"><span></span><span></span></button></div></div></header>';
  updateNavSettings(settings);
  createMiniCart(settings);

  const menu = document.getElementById("main-nav");
  const toggle = document.getElementById("menu-toggle");
  const mobileNav = window.matchMedia("(max-width: 800px)");
  function setMenuOpen(open, restoreFocus = false) {
    menu.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
    menu.inert = mobileNav.matches && !open;
    if (!open && restoreFocus) toggle.focus();
  }
  menu.inert = mobileNav.matches;
  toggle.addEventListener("click", function () {
    setMenuOpen(!menu.classList.contains("open"));
  });
  host.querySelectorAll(".main-nav a").forEach(function (link) {
    link.addEventListener("click", function () {
      setMenuOpen(false);
    });
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && host.querySelector("#nav-search").classList.contains("search-open")) {
      host.querySelector("#nav-search").classList.remove("search-open");
      updateSearchControl();
      searchButton.focus();
    }
    if (event.key === "Escape" && menu.classList.contains("open")) setMenuOpen(false, true);
  });
  const updateNavMode = function () {
    if (!mobileNav.matches) setMenuOpen(false);
    else menu.inert = !menu.classList.contains("open");
  };
  if (mobileNav.addEventListener) mobileNav.addEventListener("change", updateNavMode);
  else if (mobileNav.addListener) mobileNav.addListener(updateNavMode);
  const searchInput = document.getElementById("nav-search-input");
  const searchForm = document.getElementById("nav-search");
  const searchButton = host.querySelector("#nav-search button");
  const compactSearch = window.matchMedia("(max-width: 460px)");
  function updateSearchControl() {
    if (!compactSearch.matches) searchForm.classList.remove("search-open");
    const compactClosed = compactSearch.matches && !searchForm.classList.contains("search-open");
    searchInput.disabled = compactClosed;
    searchInput.setAttribute("aria-hidden", String(compactClosed));
    searchButton.setAttribute("aria-label", compactClosed ? "Open furniture search" : "Search furniture");
  }
  updateSearchControl();
  if (compactSearch.addEventListener) compactSearch.addEventListener("change", updateSearchControl);
  searchButton.addEventListener("click", function (event) {
    if (!compactSearch.matches || searchForm.classList.contains("search-open")) return;
    event.preventDefault();
    searchForm.classList.add("search-open");
    updateSearchControl();
    searchInput.focus();
  });
  searchForm.addEventListener("submit", function (event) {
      event.preventDefault();
      const term = document.getElementById("nav-search-input").value.trim();
      searchForm.classList.remove("search-open");
      window.location.href =
        pageHref("shop.html") + (term ? "?search=" + encodeURIComponent(term) : "");
    });
  document.getElementById("cart-open").addEventListener("click", openMiniCart);
}

function renderFooter(settings) {
  const host = document.getElementById("site-footer");
  if (!host) return;
  const business = escapeHtml(settings.business_name || "ON BY INCENSE DESIGN");
  const address = escapeHtml(settings.address || "");
  const whatsapp = String(settings.whatsapp_number || "+91 92172 99927").replace(/\D/g, "");
  const emailValue = String(settings.email || "").trim();
  const email = escapeHtml(emailValue);
  const emailLink = emailValue && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue)
    ? '<a href="mailto:' + encodeURIComponent(emailValue) + '">' + email + '</a>'
    : "";
  host.innerHTML =
    '<footer class="site-footer"><div class="footer-main"><div><a class="footer-brand" href="' + pageHref("index.html") + '"><img src="/assets/logos/ON_BY_INCENSE_DESIGN_Logo.svg" alt="" width="40"><strong>' +
    business.replace(/ INCENSE DESIGN$/, " <span>INCENSE DESIGN</span>") +
    '</strong></a><p class="footer-intro">' +
    escapeHtml(
      settings.tagline ||
        "Imported & Indian Furniture | Interior Design Studio",
    ) +
    "</p></div>" +
    '<div class="footer-column"><h2>Explore</h2><a href="' + pageHref("shop.html") + '">All furniture</a><a href="' + pageHref("shop.html") + '?category=Chairs">Chairs</a><a href="' + pageHref("shop.html") + '?category=Sofas">Sofas</a><a href="' + pageHref("shop.html") + '?category=Tables">Tables</a></div>' +
    '<div class="footer-column"><h2>The studio</h2><a href="' + pageHref("about.html") + '">About us</a><a href="' + pageHref("contact.html") + '">Visit the showroom</a><a href="' + pageHref("contact.html") + '">Interior design</a></div>' +
    '<div class="footer-column"><h2>Come by</h2><p>' +
    address +
    '</p><a data-whatsapp href="https://wa.me/' + whatsapp + '">Chat on WhatsApp</a>' + emailLink + '<p>Open every day · ' +
    escapeHtml(settings.business_hours || "9:00 AM – 9:00 PM") +
    "</p></div></div>" +
    '<div class="footer-bottom"><span>© ' +
    new Date().getFullYear() +
    " " +
    business +
    '</span><span>Listed prices are guides. <a href="' + pageHref("contact.html") + '">Confirm current prices and delivery with the showroom.</a></span></div></footer>';
}

function createMiniCart(settings) {
  if (document.getElementById("mini-cart")) return;
  const drawer = document.createElement("aside");
  drawer.className = "mini-cart";
  drawer.id = "mini-cart";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  drawer.setAttribute("aria-label", "Shopping bag");
  drawer.setAttribute("aria-hidden", "true");
  drawer.innerHTML =
    '<div class="drawer-head"><div><p class="eyebrow">YOUR SELECTION</p><h2>Your bag</h2></div><button class="drawer-close" id="drawer-close" aria-label="Close shopping bag" type="button">×</button></div>' +
    '<div class="drawer-content"><div class="drawer-items" id="drawer-items"></div></div><div class="drawer-footer" id="drawer-footer"></div>';
  const scrim = document.createElement("div");
  scrim.className = "drawer-scrim";
  scrim.id = "drawer-scrim";
  drawer.inert = true;
  document.body.append(drawer, scrim);
  document
    .getElementById("drawer-close")
    .addEventListener("click", closeMiniCart);
  scrim.addEventListener("click", closeMiniCart);
  document.addEventListener("keydown", function (event) {
    const panel = document.getElementById("mini-cart");
    if (!panel || !panel.classList.contains("open")) return;
    if (event.key === "Escape") {
      closeMiniCart();
      return;
    }
    if (event.key === "Tab") {
      const focusable = Array.from(panel.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  window.addEventListener("onby:cartchange", function () {
    renderMiniCart();
  });
}

function openMiniCart() {
  const drawer = document.getElementById("mini-cart");
  const scrim = document.getElementById("drawer-scrim");
  if (!drawer || !scrim) return;
  renderMiniCart();
  miniCartOpener = document.activeElement;
  previousBodyOverflow = document.body.style.overflow;
  inertedBackground = Array.from(document.body.children)
    .filter((element) => element !== drawer && element !== scrim)
    .map((element) => ({ element, wasInert: element.inert }));
  inertedBackground.forEach(({ element }) => { element.inert = true; });
  drawer.inert = false;
  drawer.classList.add("open");
  scrim.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  document.getElementById("drawer-close").focus();
}

function closeMiniCart() {
  const drawer = document.getElementById("mini-cart");
  const scrim = document.getElementById("drawer-scrim");
  if (!drawer || !scrim) return;
  drawer.classList.remove("open");
  scrim.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  drawer.inert = true;
  inertedBackground.forEach(({ element, wasInert }) => { element.inert = wasInert; });
  inertedBackground = [];
  document.body.style.overflow = previousBodyOverflow;
  if (miniCartOpener && typeof miniCartOpener.focus === "function") miniCartOpener.focus();
  miniCartOpener = null;
}

async function renderMiniCart() {
  const count = document.getElementById("cart-count");
  const list = document.getElementById("drawer-items");
  const footer = document.getElementById("drawer-footer");
  if (count) count.textContent = String(cartTotalCount());
  if (!list || !footer) return;
  const cart = getCart();
  if (!cart.length) {
    list.innerHTML =
      '<div class="cart-empty"><h2>Your cart is empty.</h2><p>Browse furniture and add a piece to get started.</p><a class="button button-dark" href="' + pageHref("shop.html") + '">Browse furniture</a></div>';
    footer.innerHTML = "";
    return;
  }
  try {
    const products = await api("/api/products");
    const byId = new Map(
      products.map(function (product) {
        return [product.id, product];
      }),
    );
    const valid = cart.filter(function (item) {
      return byId.has(item.id);
    });
    if (valid.length !== cart.length) saveCart(valid);
    let subtotal = 0;
    list.innerHTML = valid
      .map(function (item) {
        const product = byId.get(item.id);
        subtotal += currentPrice(product) * item.quantity;
        return (
          '<div class="drawer-line">' +
          productVisual(product) +
          "<div><h3>" +
          escapeHtml(product.name) +
          "</h3><p>" +
          item.quantity +
          " × " +
          money(currentPrice(product)) +
          '</p></div><button type="button" data-drawer-remove="' +
          product.id +
          '" aria-label="Remove ' +
          escapeHtml(product.name) +
          '">×</button></div>'
        );
      })
      .join("");
    footer.innerHTML =
      '<p class="drawer-subtotal"><span>Estimated subtotal</span><strong>' +
      money(subtotal) +
      '</strong></p><p class="drawer-note">Listed prices and bundle savings are estimates. The showroom will confirm your final price.</p><a class="button button-dark button-wide" href="' + pageHref("cart.html") + '">Review cart <span aria-hidden="true">→</span></a><a class="drawer-continue" href="' + pageHref("shop.html") + '">Continue shopping</a>';
    list.querySelectorAll("[data-drawer-remove]").forEach(function (button) {
      button.addEventListener("click", function () {
        saveCart(
          getCart().filter(function (item) {
            return item.id !== Number(button.dataset.drawerRemove);
          }),
        );
      });
    });
  } catch (_error) {
    list.innerHTML =
      '<p class="summary-note">Your bag is saved on this device. Reconnect to refresh prices.</p>';
    footer.innerHTML =
      '<a class="button button-dark button-wide" href="' + pageHref("cart.html") + '">Open your bag</a>';
  }
}

export async function bootChrome() {
  let settings = {};
  renderNav(settings);
  renderFooter(settings);
  window.addEventListener("onby:cartchange", function () {
    const count = document.getElementById("cart-count");
    if (count) count.textContent = String(cartTotalCount());
    const navCount = document.getElementById("nav-cart-count");
    if (navCount) navCount.textContent = String(cartTotalCount());
  });
  try {
    settings = { ...settings, ...(await api("/api/settings")) };
    updateNavSettings(settings);
    renderFooter(settings);
  } catch (_error) {}
  return settings;
}
