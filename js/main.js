import {
  addToCart,
  activeSale,
  api,
  currentPrice,
  bootChrome,
  cartItemsForQuote,
  escapeHtml,
  getCart,
  isAvailableForSale,
  money,
  productCard,
  productPriceMarkup,
  productVisual,
  saveCart,
  setCartQuantity,
  toast,
} from "./store.js";
import { initScrollReveals } from "./motion.js";

let settings = {};
let productCache = [];
let productLoadError = "";

function byId(id) {
  return document.getElementById(id);
}

function setMeta(name, value) {
  let meta = document.querySelector('meta[name="' + name + '"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.appendChild(meta);
  }
  meta.content = value;
}

function setBusinessJsonLd() {
  const schema = {
    "@context": "https://schema.org",
    "@type": "FurnitureStore",
    name: settings.business_name || "ON BY INCENSE DESIGN",
    description:
      settings.tagline ||
      "Imported & Indian Furniture | Interior Design Studio",
    address: {
      "@type": "PostalAddress",
      streetAddress:
        settings.address || "7/27, Block 7, Kirti Nagar Industrial Area",
      addressLocality: "New Delhi",
      postalCode: "110015",
      addressCountry: "IN",
    },
    openingHours: "Mo-Su 09:00-21:00",
  };
  if (settings.email) schema.email = settings.email;
  let element = document.getElementById("business-jsonld");
  if (!element) {
    element = document.createElement("script");
    element.type = "application/ld+json";
    element.id = "business-jsonld";
    document.head.appendChild(element);
  }
  element.textContent = JSON.stringify(schema);
}

function whatsappNumber() {
  const digits = String(settings.whatsapp_number || "+91 92172 99927").replace(/\D/g, "");
  return digits.length === 10 ? "91" + digits : digits;
}

function setWhatsAppLinks() {
  document.querySelectorAll("[data-whatsapp]").forEach(function (anchor) {
    anchor.href = "https://wa.me/" + whatsappNumber();
  });
}

function setHeroHeading() {
  const target = byId("hero-heading");
  if (!target || !settings.homepage_heading) return;
  const heading = String(settings.homepage_heading).trim();
  window.setTimeout(function () {
    const parts = heading.split(/\s+/);
    const last = parts.pop() || "";
    target.innerHTML =
      escapeHtml(parts.join(" ")) +
      (parts.length ? "<br>" : "") +
      "<em>" +
      escapeHtml(last) +
      "</em>";
  }, 4000);
}

function safeStoreHref(value, fallback) {
  const href = String(value || "").trim();
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  if (/^https:\/\//i.test(href)) return href;
  return fallback;
}

function configureHomeContent() {
  const description = byId("hero-description");
  if (description && settings.hero_description) description.textContent = settings.hero_description;
  const image = String(settings.hero_image || "").trim();
  const localImage = /^images\/[A-Za-z0-9 _().-]+\.(jpe?g|png|webp|avif)$/i.test(image);
  if (image && (localImage || image.startsWith("/") || /^https:\/\//i.test(image))) {
    const art = byId("hero-art");
    const imageUrl = localImage ? new URL(image, window.location.href).href : image;
    if (art) art.style.backgroundImage = 'linear-gradient(180deg, rgba(18,18,16,.02), rgba(18,18,16,.44)), url("' + imageUrl.replace(/["\\\n\r]/g, "") + '")';
  }
  const cta = byId("hero-primary-cta");
  if (cta) {
    cta.href = safeStoreHref(settings.hero_cta_url, "/shop.html");
    if (settings.hero_cta_text && cta.firstChild) cta.firstChild.textContent = settings.hero_cta_text + " ";
  }
  const promo = byId("home-promo-heading");
  if (promo && settings.promotional_heading) {
    const words = String(settings.promotional_heading).trim().split(/\s+/);
    const accent = words.pop() || "";
    promo.innerHTML = escapeHtml(words.join(" ")) + (words.length ? "<br>" : "") + "<em>" + escapeHtml(accent) + "</em>";
  }
  const promoCopy = byId("home-promo-copy");
  if (promoCopy) promoCopy.textContent = "Add eligible furniture to your cart to see your bundle savings. The showroom will confirm your final price.";
  const address = byId("home-showroom-address");
  if (address && settings.address) address.textContent = settings.address;
  const hours = byId("home-showroom-hours");
  if (hours && settings.business_hours) hours.textContent = settings.business_hours;
}

function configureAboutContent() {
  const tagline = byId("about-tagline");
  if (tagline) tagline.textContent = settings.tagline || "Imported & Indian Furniture | Interior Design Studio";
  const address = String(settings.address || "7/27, Block 7, Kirti Nagar Industrial Area, New Delhi 110015").trim();
  const addressNode = byId("about-address");
  if (addressNode) addressNode.textContent = address;
  const hours = byId("about-hours");
  if (hours) hours.textContent = settings.business_hours || "Contact the showroom to confirm opening hours.";
  const mapLink = byId("about-map-link");
  if (mapLink) mapLink.href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(address);
}

function wireAddButtons(products) {
  document.querySelectorAll("[data-add-to-cart]").forEach(function (button) {
    button.addEventListener("click", function () {
      const product = products.find(function (item) {
        return item.id === Number(button.dataset.addToCart);
      });
      if (!product) return;
      if (!isAvailableForSale(product)) return;
      addToCart(product.id, 1);
      toast(product.name + " added to your cart.", {
        label: "View Cart",
        href: "/cart.html",
      });
    });
  });
}

async function fetchProducts() {
  try {
    productCache = await api("/api/products");
    productLoadError = "";
    return productCache;
  } catch (error) {
    productCache = [];
    productLoadError =
      "The furniture list could not load from the store server. Run start-server.bat and open this page at http://127.0.0.1:8000, then try again.";
    console.error("Furniture catalog request failed", error);
    toast(productLoadError);
    return [];
  }
}

function pickDiverseProducts(products, count, excludedIds) {
  const remaining = products.filter((product) => !excludedIds.has(Number(product.id)));
  const categories = Array.from(new Set(remaining.map((product) => product.category)));
  const selected = [];
  while (remaining.length && selected.length < count) {
    let added = false;
    categories.forEach((category) => {
      if (selected.length >= count) return;
      const index = remaining.findIndex((product) => product.category === category);
      if (index < 0) return;
      selected.push(remaining.splice(index, 1)[0]);
      added = true;
    });
    if (!added) break;
  }
  return selected;
}

function renderHome(products) {
  const publicProducts = products.filter((product) => !product.is_demo);
  const offers = settings.special_offers_enabled
    ? pickDiverseProducts(publicProducts.filter((product) => activeSale(product)), 8, new Set())
    : [];
  const seenIds = new Set(offers.map((product) => Number(product.id)));
  const selectedFeatured = publicProducts.filter((product) => product.featured && !seenIds.has(Number(product.id))).slice(0, 8);
  const featuredIds = new Set(selectedFeatured.map((product) => Number(product.id)));
  let featured = selectedFeatured.concat(pickDiverseProducts(publicProducts, 8 - selectedFeatured.length, new Set([...seenIds, ...featuredIds])));
  if (featured.length < 8) {
    featured = featured.concat(pickDiverseProducts(publicProducts, 8 - featured.length, new Set(featured.map((product) => Number(product.id)))));
  }
  featured.forEach((product) => seenIds.add(Number(product.id)));
  const favorites = publicProducts.filter((product) => product.bestseller).slice(0, 8);
  favorites.forEach((product) => seenIds.add(Number(product.id)));
  const arrivals = settings.new_arrivals_enabled
    ? publicProducts
      .filter((product) => product.new_arrival)
      .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))
      .slice(0, 8)
    : [];
  arrivals.forEach((product) => seenIds.add(Number(product.id)));
  const moreFurniture = pickDiverseProducts(publicProducts, 12, seenIds);
  if (byId("home-featured")) {
    byId("home-featured").innerHTML = featured.length
      ? featured.map(function (product) { return productCard(product, settings.discounts); }).join("")
      : '<div class="empty-inline">' + escapeHtml(productLoadError || "Featured pieces will appear here as the showroom updates its collection.") + (productLoadError ? ' <button class="button button-outline-dark" type="button" data-retry-products>Try again</button>' : "") + "</div>";
  }
  document.querySelectorAll("[data-retry-products]").forEach((button) => button.addEventListener("click", () => window.location.reload()));
  if (byId("home-bestsellers")) {
    const section = byId("home-bestsellers").closest(".bestseller-section");
    if (section) section.classList.toggle("hidden", !favorites.length);
    byId("home-bestsellers").innerHTML = favorites.map((product) => productCard(product, settings.discounts)).join("");
  }
  const offersSection = byId("home-offers");
  if (offersSection) {
    const showOffers = Boolean(settings.special_offers_enabled) && offers.length > 0;
    offersSection.classList.toggle("hidden", !showOffers);
    byId("home-offers-products").innerHTML = offers.map((product) => productCard(product, settings.discounts)).join("");
  }
  if (byId("home-new")) {
    const section = byId("home-new-section");
    const showArrivals = Boolean(settings.new_arrivals_enabled) && arrivals.length > 0;
    if (section) section.classList.toggle("hidden", !showArrivals);
    byId("home-new").innerHTML = arrivals.map((product) => productCard(product, settings.discounts)).join("");
  }
  const moreSection = byId("home-more-section");
  if (moreSection) {
    moreSection.classList.toggle("hidden", !moreFurniture.length);
    byId("home-more").innerHTML = moreFurniture.map((product) => productCard(product, settings.discounts)).join("");
  }
  const tiersHost = byId("home-discount-tiers");
  if (tiersHost) {
    const tiers = settings.discounts && settings.discounts.tiers ? settings.discounts.tiers : [];
    tiersHost.innerHTML = tiers.filter((tier) => Number(tier.percent) > 0)
      .map((tier) => '<span>' + Number(tier.min_items) + (Number(tier.min_items) >= 6 ? '+ items · ' : ' items · ') + Number(tier.percent) + '% off</span>')
      .join("");
  }
  wireAddButtons(products);
}

function initShop(products) {
  const grid = byId("shop-products");
  if (!grid) return;
  const discountHost = byId("shop-discount-progress");
  async function updateShopDiscount() {
    if (!discountHost) return;
    const cart = getCart();
    if (cart.length) {
      try {
        discountHost.innerHTML = renderProgress(await getCartQuote(cart));
      } catch (_error) {
        discountHost.innerHTML = '<p class="shop-discount-message">Your bundle savings will appear in your cart.</p>';
      }
      return;
    }
    const tiers = settings.discounts && settings.discounts.tiers
      ? settings.discounts.tiers
      : [{ min_items: 2, percent: 3 }, { min_items: 3, percent: 5 }, { min_items: 4, percent: 8 }, { min_items: 5, percent: 10 }, { min_items: 6, percent: 15 }];
    const offers = tiers
      .filter(function (tier) { return Number(tier.percent) > 0; })
      .map(function (tier) {
        return '<span>' + Number(tier.min_items) + ' items · ' + Number(tier.percent) + '% off</span>';
      })
      .join("");
    discountHost.innerHTML = '<p class="shop-discount-message"><strong>Save on eligible furniture when you buy more.</strong> Savings are shown in your cart.</p><div class="shop-discount-tiers">' + offers + '</div>';
  }
  updateShopDiscount();
  window.addEventListener("onby:cartchange", updateShopDiscount);
  if (productLoadError) {
    byId("shop-count").textContent = "Collection unavailable";
    grid.innerHTML = '<div class="empty-inline">' + escapeHtml(productLoadError) + ' <button class="button button-outline-dark" type="button" data-retry-products>Try again</button></div>';
    grid.querySelector("[data-retry-products]").addEventListener("click", () => window.location.reload());
    byId("shop-empty").classList.add("hidden");
    return;
  }
  const search = byId("shop-search");
  const category = byId("category-filter");
  const price = byId("price-filter");
  const availability = byId("availability-filter");
  const sort = byId("sort-filter");
  const loadMore = byId("shop-load-more");
  const paginationStatus = byId("shop-pagination-status");
  const pageSize = 24;
  let visibleLimit = pageSize;
  let currentResults = [];
  const query = new URLSearchParams(window.location.search);
  search.value = query.get("search") || "";
  const requestedCategory = query.get("category") || "";
  if (
    requestedCategory &&
    !Array.from(category.options).some(function (option) {
      return option.value === requestedCategory;
    })
  ) {
    const option = document.createElement("option");
    option.value = requestedCategory;
    option.textContent = requestedCategory;
    category.appendChild(option);
  }
  category.value = requestedCategory;
  const categories = Array.from(
    new Set(
      products.map(function (item) {
        return item.category;
      }),
    ),
  );
  categories.forEach(function (value) {
    if (
      !Array.from(category.options).some(function (option) {
        return option.value === value;
      })
    ) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      category.appendChild(option);
    }
  });

  function renderResults() {
    const visible = currentResults.slice(0, visibleLimit);
    grid.innerHTML = visible.map(function (product) {
      return productCard(product, settings.discounts);
    }).join("");
    byId("shop-empty").classList.toggle("hidden", currentResults.length > 0);
    grid.classList.toggle("hidden", currentResults.length === 0);
    loadMore.classList.toggle("hidden", currentResults.length <= visibleLimit);
    paginationStatus.textContent = currentResults.length > visibleLimit
      ? "Showing " + visible.length + " of " + currentResults.length + " pieces"
      : "";
    wireAddButtons(products);
  }

  function applyFilters() {
    const term = search.value.trim().toLowerCase();
    const selectedCategory = category.value;
    const maxPaise =
      Number(price.value) > 0 ? Number(price.value) * 100 : Infinity;
    const selectedAvailability = availability.value;
    const filtered = products.filter(function (product) {
      const matchesTerm =
        !term ||
        (product.name + " " + product.category).toLowerCase().includes(term);
      const matchesCategory =
        !selectedCategory || product.category === selectedCategory;
      const matchesPrice = currentPrice(product) <= maxPaise;
      const matchesAvailability =
        selectedAvailability === "" ||
        (selectedAvailability === "in" && isAvailableForSale(product)) ||
        (selectedAvailability === "out" &&
          product.availability_confirmed &&
          !isAvailableForSale(product));
      return (
        matchesTerm && matchesCategory && matchesPrice && matchesAvailability
      );
    });
    if (sort.value === "price-asc")
      filtered.sort(function (a, b) {
        return currentPrice(a) - currentPrice(b);
      });
    else if (sort.value === "price-desc")
      filtered.sort(function (a, b) {
        return currentPrice(b) - currentPrice(a);
      });
    else if (sort.value === "name")
      filtered.sort(function (a, b) {
        return a.name.localeCompare(b.name);
      });
    else
      filtered.sort(function (a, b) {
        return Number(b.featured) - Number(a.featured) || a.id - b.id;
      });
    byId("shop-count").textContent =
      filtered.length + (filtered.length === 1 ? " piece" : " pieces");
    currentResults = filtered;
    visibleLimit = pageSize;
    renderResults();
  }

  [search, category, price, availability, sort].forEach(function (input) {
    input.addEventListener(
      input === search || input === price ? "input" : "change",
      applyFilters,
    );
  });
  function clearFilters() {
    search.value = "";
    category.value = "";
    price.value = "";
    availability.value = "";
    sort.value = "featured";
    applyFilters();
  }
  byId("clear-filters").addEventListener("click", clearFilters);
  byId("empty-clear").addEventListener("click", clearFilters);
  loadMore.addEventListener("click", function () {
    visibleLimit += pageSize;
    renderResults();
  });
  applyFilters();
}

function recentProductIds(productId) {
  let recent = [];
  try {
    recent = JSON.parse(sessionStorage.getItem("onby_recent_v1") || "[]");
  } catch (_error) {}
  recent = [productId]
    .concat(
      recent.filter(function (id) {
        return Number(id) !== Number(productId);
      }),
    )
    .slice(0, 6);
  try { sessionStorage.setItem("onby_recent_v1", JSON.stringify(recent)); } catch (_error) {}
  return recent;
}

function setProductSchema(product) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    category: product.category,
    description:
      product.description || "Contact us for dimensions, materials, and other product details.",
    brand: {
      "@type": "Brand",
      name: settings.business_name || "ON BY INCENSE DESIGN",
    },
  };
  if (product.images && product.images.length) schema.image = product.images;
  let element = document.getElementById("product-jsonld");
  if (!element) {
    element = document.createElement("script");
    element.type = "application/ld+json";
    element.id = "product-jsonld";
    document.head.appendChild(element);
  }
  element.textContent = JSON.stringify(schema);
}

async function initProduct(products) {
  const host = byId("product-detail");
  if (!host) return;
  const slug = window.location.pathname.split("/").filter(Boolean)[1] ||
    new URLSearchParams(window.location.search).get("slug");
  if (!slug) {
    host.innerHTML =
      '<div class="empty-state"><span>—</span><h2>Choose a piece</h2><p>Browse the collection to see product details.</p><a class="button button-dark" href="/shop.html">Explore furniture</a></div>';
    return;
  }
  try {
    let product = products.find((item) => item.slug === slug);
    if (!product) product = await api("/api/products/" + encodeURIComponent(slug));
    if (!product) throw Object.assign(new Error("That product could not be found."), { status: 404 });
    recentProductIds(product.id);
    document.title =
      product.name + " | " + (settings.business_name || "ON BY INCENSE DESIGN");
    setMeta(
      "description",
      product.name +
        " from " +
        (settings.business_name || "ON BY INCENSE DESIGN") +
        ". Confirm product details and availability with the showroom.",
    );
    setProductSchema(product);
    byId("breadcrumb-product").textContent = product.name;
    const images = Array.isArray(product.images) ? product.images : [];
    const availableForSale = isAvailableForSale(product);
    const stockText = availableForSale
      ? "Available for sale"
      : product.availability_confirmed
        ? "Currently Unavailable"
        : "Check availability with the showroom";
    const discountEligible = product.discount_eligible &&
      (!activeSale(product) || product.sale_stack_discounts) &&
      currentPrice(product) >= Number(settings.discounts ? settings.discounts.min_eligible_price_paise : 0);
    const discountLabel = settings.discounts && settings.discounts.discounts_enabled
      ? (discountEligible ? "Bundle discount applies" : "Not included in bundle discount")
      : "";
    const stockClass = availableForSale ? "stock-line" : "stock-line out";
    const thumbs =
      images.length > 1
        ? '<div class="gallery-thumbnails">' +
          images
            .map(function (src, index) {
              return (
                '<button class="gallery-thumbnail' +
                (index === 0 ? " active" : "") +
                '" type="button" data-gallery-index="' +
                index +
                '" aria-label="View photograph ' +
                (index + 1) +
                '"><img src="' +
                escapeHtml(src) +
                '" alt="" loading="lazy"></button>'
              );
            })
            .join("") +
          "</div>"
        : "";
    host.innerHTML =
      '<div class="product-gallery"><div class="product-gallery-main" id="gallery-main">' +
      productVisual(product, "gallery-visual", "eager") +
      (images.length
        ? '<button class="zoom-button" type="button" aria-label="Enlarge product photograph">⌕</button>'
        : "") +
      "</div>" +
      thumbs +
      '</div><div class="product-detail-copy"><p class="eyebrow">ON BY INCENSE DESIGN</p><p class="product-detail-category">' +
      escapeHtml(product.category) +
      "</p>" +
      "<h1>" +
      escapeHtml(product.name) +
      '</h1><p class="detail-price">' +
      productPriceMarkup(product, true) +
      '</p><p class="detail-price-note">Prices shown are guides. The showroom will confirm your final price before you order.</p>' +
      '<p class="detail-description">' +
      escapeHtml(
        product.description ||
          "Contact us for dimensions, materials, and other product details.",
      ) +
      "</p>" +
      '<p class="' +
      stockClass +
      '">' +
      escapeHtml(stockText) +
      '</p>' +
      (discountLabel ? '<p class="detail-offer-label' + (discountEligible ? "" : " excluded") + '">' + escapeHtml(discountLabel) + "</p>" : "") +
      '<div class="quantity-row"><span class="field-label">Quantity</span><div class="quantity-control"><button type="button" id="qty-minus" aria-label="Decrease quantity">−</button><span id="detail-qty">1</span><button type="button" id="qty-plus" aria-label="Increase quantity">+</button></div></div>' +
      '<div class="detail-actions"><button class="button button-dark" id="detail-add" type="button"' +
      (!availableForSale ? " disabled" : "") +
      '>Add to Cart <span aria-hidden="true">+</span></button><button class="button button-outline-dark" id="detail-buy" type="button"' +
      (!availableForSale ? " disabled" : "") +
      '>Request this item <span aria-hidden="true">↗</span></button></div>' +
      '<a class="detail-whatsapp" id="product-whatsapp" target="_blank" rel="noopener noreferrer">Ask about this item on WhatsApp ↗</a></div>';
    let quantity = 1;
    byId("qty-minus").addEventListener("click", function () {
      quantity = Math.max(1, quantity - 1);
      byId("detail-qty").textContent = String(quantity);
    });
    byId("qty-plus").addEventListener("click", function () {
      quantity = Math.min(99, quantity + 1);
      byId("detail-qty").textContent = String(quantity);
    });
    byId("detail-add").addEventListener("click", function () {
      addToCart(product.id, quantity);
      toast(product.name + " added to your cart.", {
        label: "View Cart",
        href: "/cart.html",
      });
    });
    byId("detail-buy").addEventListener("click", function () {
      addToCart(product.id, quantity);
      window.location.href = "/checkout.html";
    });
    const whatsappText =
      "Hello " +
      (settings.business_name || "ON BY INCENSE DESIGN") +
      ", I would like to ask about " +
      product.name +
      ".";
    byId("product-whatsapp").href =
      "https://wa.me/" +
      whatsappNumber() +
      "?text=" +
      encodeURIComponent(whatsappText);
    if (images.length) {
      const zoom = document.createElement("dialog");
      zoom.className = "product-zoom";
      zoom.setAttribute("aria-label", "Enlarged product photograph");
      zoom.innerHTML =
        '<form method="dialog"><button class="drawer-close" aria-label="Close enlarged photograph">×</button></form><img src="' +
        escapeHtml(images[0]) +
        '" alt="' +
        escapeHtml(product.name) +
        ' furniture photograph">';
      document.body.appendChild(zoom);
      byId("gallery-main")
        .querySelector(".zoom-button")
        .addEventListener("click", function () {
          zoom.showModal();
        });
      zoom.querySelector("img").addEventListener("click", function () {
        zoom.close();
      });
    }
    let gallerySwapTimer = 0;
    const galleryThumbnails = Array.from(host.querySelectorAll("[data-gallery-index]"));
    galleryThumbnails.forEach(function (button) {
      button.addEventListener("click", function () {
        const index = Number(button.dataset.galleryIndex);
        const mainImage = byId("gallery-main").querySelector(".product-photo");
        if (!mainImage) return;
        if (gallerySwapTimer) window.clearTimeout(gallerySwapTimer);
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          mainImage.src = images[index];
        } else {
          mainImage.classList.add("gallery-switching");
          gallerySwapTimer = window.setTimeout(function () {
            mainImage.src = images[index];
            window.requestAnimationFrame(function () {
              mainImage.classList.remove("gallery-switching");
            });
          }, 100);
        }
        host.querySelectorAll(".gallery-thumbnail").forEach(function (thumb) {
          thumb.classList.toggle("active", thumb === button);
        });
        const zoomImage = document.querySelector(".product-zoom img");
        if (zoomImage) zoomImage.src = images[index];
      });
    });
    if (galleryThumbnails.length > 1) {
      const galleryMain = byId("gallery-main");
      let swipeStart = null;
      galleryMain.addEventListener("pointerdown", function (event) {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        swipeStart = { x: event.clientX, y: event.clientY };
      });
      galleryMain.addEventListener("pointerup", function (event) {
        if (!swipeStart) return;
        const deltaX = event.clientX - swipeStart.x;
        const deltaY = event.clientY - swipeStart.y;
        swipeStart = null;
        if (Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return;
        event.preventDefault();
        const activeIndex = galleryThumbnails.findIndex(function (button) {
          return button.classList.contains("active");
        });
        const nextIndex = (activeIndex + (deltaX < 0 ? 1 : -1) + galleryThumbnails.length) % galleryThumbnails.length;
        galleryThumbnails[nextIndex].click();
      });
      galleryMain.addEventListener("pointercancel", function () {
        swipeStart = null;
      });
    }
    const related = byId("related-products");
    let visited = [];
    try {
      visited = JSON.parse(
        sessionStorage.getItem("onby_recent_v1") || "[]",
      ).map(Number);
    } catch (_error) {}
    const relatedProducts = products
      .filter(function (item) {
        return item.id !== product.id;
      })
      .sort(function (a, b) {
        const ai = visited.indexOf(a.id);
        const bi = visited.indexOf(b.id);
        const ar = ai === -1 ? 100 : ai;
        const br = bi === -1 ? 100 : bi;
        return ar - br;
      })
      .slice(0, 4);
    related.innerHTML = relatedProducts.map(function (item) {
      return productCard(item, settings.discounts);
    }).join("");
    wireAddButtons(products);
  } catch (error) {
    const notFound = Number(error && error.status) === 404;
    host.innerHTML = '<div class="empty-state"><span>—</span><h2>' +
      (notFound ? "Product not found" : "Product details are temporarily unavailable") +
      '</h2><p>' +
      (notFound
        ? "This item is no longer available. Browse the collection to find another option."
        : "We could not load this item. Check your connection and try again.") +
      '</p><div class="detail-error-actions">' +
      (notFound ? "" : '<button class="button button-outline-dark" id="product-retry" type="button">Try again</button>') +
      '<a class="button button-dark" href="/shop.html">Return to the collection</a></div></div>';
    const retry = byId("product-retry");
    if (retry) retry.addEventListener("click", function () { initProduct(products); });
  }
}

function cartProduct(productId, products) {
  return products.find(function (product) {
    return product.id === Number(productId);
  });
}

function renderProgress(quote) {
  if (!quote.discounts_enabled) {
    return '<div class="summary-progress"><p>No bundle offer is available right now.</p></div>';
  }
  if (!quote.next_tier) {
    if (quote.eligible_units === 0) {
      return '<div class="summary-progress"><p>Add eligible furniture to unlock a discount.</p></div>';
    }
    return (
      '<div class="summary-progress"><p>You unlocked the maximum discount: <strong>' +
      quote.discount_percent +
      '% OFF</strong>.</p><div class="progress-track"><span style="width:100%"></span></div></div>'
    );
  }
  const nextCount = Number(quote.next_tier.min_items);
  const percent = Number(quote.next_tier.percent);
  const remaining = Math.max(0, nextCount - Number(quote.eligible_units));
  const progress = Math.min(
    100,
    Math.round((Number(quote.eligible_units) / nextCount) * 100),
  );
  const unlocked = Number(quote.discount_percent) > 0
    ? '<p class="discount-unlocked">You unlocked <strong>' + Number(quote.discount_percent) + '% OFF!</strong></p>'
    : "";
  const remainingText = remaining === 1
    ? "Add 1 more eligible item"
    : "Add " + remaining + " more eligible items";
  return (
    '<div class="summary-progress">' + unlocked + '<p>' +
    remainingText +
    " for <strong>" +
    percent +
    '% OFF</strong>.</p><div class="progress-track" role="progressbar" aria-valuenow="' +
    progress +
    '" aria-valuemin="0" aria-valuemax="100"><span style="width:' +
    progress +
    '%"></span></div><p class="progress-labels"><span>' +
    quote.eligible_units +
    " eligible items</span><span>" +
    nextCount +
    " items · " +
    percent +
    "%</span></p></div>"
  );
}

function summaryMarkup(quote, checkout) {
  const lines = checkout
    ? quote.lines
        .map(function (line) {
          return (
            '<div class="summary-line"><span>' +
            escapeHtml(line.name) +
            " × " +
            line.quantity +
            "</span><strong>" +
            money(line.line_total_paise) +
            "</strong></div>"
          );
        })
        .join("")
    : "";
  return (
    "<h2>" +
    (checkout ? "Your order" : "Your Cart") +
    "</h2>" +
    lines +
    '<div class="summary-row"><span>Subtotal</span><strong>' +
    money(quote.subtotal_paise) +
    "</strong></div>" +
    '<div class="summary-row discount"><span>Bundle discount (' +
    quote.discount_percent +
    "%)</span><strong>− " +
    money(quote.discount_paise) +
    "</strong></div>" +
    '<div class="summary-row total"><span>Estimated total</span><strong>' +
    money(quote.total_paise) +
    "</strong></div>" +
    '<p class="summary-note">' +
    (Number(quote.discount_paise) > 0 ? "Bundle savings of " + money(quote.discount_paise) + " are included. " : "") +
    escapeHtml(quote.delivery_note) +
    " The showroom will confirm the final price before you decide.</p>" +
    renderProgress(quote) +
    (checkout
      ? ""
      : '<a class="button button-dark button-wide" href="/checkout.html">Continue to checkout <span aria-hidden="true">→</span></a><a class="text-link" href="/shop.html">Continue shopping <span aria-hidden="true">→</span></a>')
  );
}

async function getCartQuote(cart) {
  return api("/api/cart/quote", {
    method: "POST",
    body: { items: cartItemsForQuote(cart) },
  });
}

function wireCartActions(host) {
  host.querySelectorAll("[data-cart-qty]").forEach(function (button) {
    button.addEventListener("click", function () {
      const item = getCart().find((row) => row.id === Number(button.dataset.cartQty));
      if (item) setCartQuantity(item.id, item.quantity + Number(button.dataset.step));
    });
  });
  host.querySelectorAll("[data-cart-remove]").forEach(function (button) {
    button.addEventListener("click", function () {
      saveCart(getCart().filter((item) => item.id !== Number(button.dataset.cartRemove)));
    });
  });
  const summary = byId("cart-summary");
  if (summary && !byId("clear-cart")) {
    const clearButton = document.createElement("button");
    clearButton.className = "button button-outline-dark button-wide";
    clearButton.id = "clear-cart";
    clearButton.type = "button";
    clearButton.textContent = "Clear cart";
    summary.append(clearButton);
  }
  const clearButton = byId("clear-cart");
  if (clearButton) clearButton.addEventListener("click", function () {
    if (window.confirm("Clear all items from your cart?")) saveCart([]);
  });
}

async function renderCart(products) {
  const itemsHost = byId("cart-items");
  const summaryHost = byId("cart-summary");
  if (!itemsHost || !summaryHost) return;
  const cart = getCart();
  if (!cart.length) {
    itemsHost.innerHTML =
      '<div class="cart-empty"><h2>Your cart is empty.</h2><p>Browse the collection and add furniture you like.</p><a class="button button-dark" href="/shop.html">Browse furniture</a></div>';
    summaryHost.innerHTML = "";
    return;
  }
  if (productLoadError) {
    itemsHost.innerHTML = '<div class="empty-state"><h2>We could not load your cart details</h2><p>Your cart is saved on this device. Check your connection and try again, or remove an item below.</p></div>' + cart.map((item) => '<article class="cart-row"><div><p class="cart-category">SAVED CART ITEM</p><h2>Furniture item</h2><p>Quantity: ' + item.quantity + '</p></div><button class="remove-item" type="button" data-cart-remove="' + item.id + '">Remove</button></article>').join("");
    summaryHost.innerHTML = '<div class="empty-state"><h2>Prices are unavailable right now</h2><p>Check your connection and try again. Your saved cart is still here.</p><button class="button button-outline-dark" id="cart-retry-catalog" type="button">Try again</button><a class="button button-dark" href="/shop.html">Continue shopping</a></div>';
    wireCartActions(itemsHost);
    byId("cart-retry-catalog").addEventListener("click", async function () {
      await fetchProducts();
      if (productLoadError) return renderCart([]);
      renderCart(productCache);
    });
    return;
  }
  try {
    const valid = cart.filter(function (item) {
      return cartProduct(item.id, products);
    });
    if (valid.length !== cart.length) saveCart(valid);
    if (!valid.length) return renderCart(products);
    const quote = await getCartQuote(valid);
    const lineMap = new Map(
      quote.lines.map(function (line) {
        return [line.product_id, line];
      }),
    );
    itemsHost.innerHTML = valid
      .map(function (item) {
        const product = cartProduct(item.id, products);
        const line = lineMap.get(item.id);
        return (
          '<article class="cart-row" data-cart-row="' +
          product.id +
          '">' +
          productVisual(product) +
          '<div><p class="cart-category">' +
          escapeHtml(product.category) +
          '</p><h2><a href="/product.html?slug=' +
          encodeURIComponent(product.slug) +
          '">' +
          escapeHtml(product.name) +
          '</a></h2><p class="cart-price">' +
          productPriceMarkup(product) +
          ' <small>guide price each</small></p>' +
          (quote.discounts_enabled ? '<p class="cart-offer-note' + (line.discount_eligible ? "" : " excluded") + '">' +
            (line.discount_eligible ? "Bundle discount applies" : "Not included in bundle discount") +
            "</p>" : "") +
          '</div><div class="cart-row-actions"><div class="quantity-control"><button type="button" data-cart-qty="' +
          product.id +
          '" data-step="-1" aria-label="Decrease ' +
          escapeHtml(product.name) +
          ' quantity">−</button><span>' +
          item.quantity +
          '</span><button type="button" data-cart-qty="' +
          product.id +
          '" data-step="1" aria-label="Increase ' +
          escapeHtml(product.name) +
          ' quantity">+</button></div><span class="cart-row-total">' +
          money(line.line_total_paise) +
          '</span><button class="remove-item" type="button" data-cart-remove="' +
          product.id +
          '">Remove</button></div></article>'
        );
      })
      .join("");
    summaryHost.innerHTML = summaryMarkup(quote, false);
    wireCartActions(itemsHost);
  } catch (error) {
    const savedItems = getCart();
    itemsHost.innerHTML = savedItems.map(function (item) {
      const product = cartProduct(item.id, products);
      if (!product) return "";
      const currentlyUnavailable = !isAvailableForSale(product);
      return '<article class="cart-row" data-cart-row="' + product.id + '">' + productVisual(product) + '<div><p class="cart-category">' + escapeHtml(product.category) + '</p><h2><a href="/product.html?slug=' + encodeURIComponent(product.slug) + '">' + escapeHtml(product.name) + '</a></h2><p class="cart-price">' + productPriceMarkup(product) + ' <small>guide price each</small></p><p>' + (currentlyUnavailable ? 'This item is not available for sale right now.' : 'We could not refresh this price. Try again shortly.') + '</p></div><div class="cart-row-actions"><div class="quantity-control"><button type="button" data-cart-qty="' + product.id + '" data-step="-1" aria-label="Decrease ' + escapeHtml(product.name) + ' quantity">−</button><span>' + item.quantity + '</span><button type="button" data-cart-qty="' + product.id + '" data-step="1" aria-label="Increase ' + escapeHtml(product.name) + ' quantity">+</button></div><button class="remove-item" type="button" data-cart-remove="' + product.id + '">Remove</button></div></article>';
    }).join("");
    console.error("Cart quote refresh failed", error);
    summaryHost.innerHTML = '<div class="empty-state"><h2>We could not refresh your prices</h2><p>Check your connection and try again. Your cart is still saved.</p><button class="button button-outline-dark" id="cart-retry-quote" type="button">Try again</button><a class="button button-dark" href="/shop.html">Continue shopping</a></div>';
    wireCartActions(itemsHost);
    byId("cart-retry-quote").addEventListener("click", () => renderCart(products));
  }
}

async function initCheckout() {
  const form = byId("checkout-form");
  const summaryHost = byId("checkout-summary");
  if (!form || !summaryHost) return;
  const cart = getCart();
  if (!cart.length) {
    form.innerHTML = '<div class="cart-empty"><h2>Your cart is empty.</h2><a class="button button-dark" href="/shop.html">Shop Furniture</a></div>';
    summaryHost.innerHTML = "";
    return;
  }
  try {
    const quote = await getCartQuote(cart);
    summaryHost.innerHTML = summaryMarkup(quote, true);
  } catch (error) {
    byId("checkout-error").textContent = error.message || "We could not prepare your order summary.";
  }
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const currentCart = getCart();
    if (!currentCart.length) return window.location.assign("/cart.html");
    const popup = window.open("about:blank", "_blank");
    const values = new FormData(form);
    const customer = {
      name: String(values.get("customer_name") || "").trim(),
      phone: String(values.get("phone") || "").trim(),
      address: String(values.get("address") || "").trim(),
      city: String(values.get("city") || "").trim(),
      state: String(values.get("state") || "").trim(),
    };
    const button = byId("place-order");
    const errorHost = byId("checkout-error");
    button.disabled = true;
    errorHost.textContent = "";
    try {
      const result = await api("/api/orders", { method: "POST", body: { customer, items: cartItemsForQuote(currentCart) } });
      const whatsappUrl = result.whatsapp_url;
      if (popup && !popup.closed) popup.location.href = whatsappUrl;
      else window.location.href = whatsappUrl;
      form.innerHTML = '<div class="order-reference"><span>WHATSAPP ORDER REQUEST</span><strong>Request saved</strong><span class="order-status-pill">' + escapeHtml(result.id) + '</span></div><p class="confirmation-copy">Your order request is saved. WhatsApp opened with the order details; press Send there to contact the showroom.</p><p class="checkout-legal">The showroom will confirm availability, delivery, and final price. No payment is collected here.</p>';
    } catch (error) {
      if (popup && !popup.closed) popup.close();
      button.disabled = false;
      button.textContent = "Continue to WhatsApp";
      errorHost.textContent = error.message || "We could not prepare the WhatsApp message. Please try again.";
    }
  });
}

function initConfirmation() {
  if (!byId("confirmation-ref")) return;
  byId("confirmation-ref").textContent = "WhatsApp request";
  const sendWhatsApp = byId("send-whatsapp");
  if (sendWhatsApp) {
    sendWhatsApp.href = "https://wa.me/" + whatsappNumber();
    sendWhatsApp.classList.remove("hidden");
  }
  const note = byId("confirmation-note");
  if (note) note.textContent = "Your order request is saved when you continue to WhatsApp. Press Send there to contact the showroom. No payment is collected here.";
}

function initContact() {
  const address = byId("contact-address");
  const hours = byId("contact-hours");
  const maps = byId("map-link");
  const email = byId("contact-email");
  if (address) address.textContent = settings.address || "";
  if (hours) hours.textContent = "Open every day · " + (settings.business_hours || "9:00 AM – 9:00 PM");
  if (maps) maps.href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(settings.address || "");
  const emailLine = email && email.closest(".contact-email-line");
  if (email && settings.email) {
    email.textContent = settings.email;
    email.href = "mailto:" + encodeURIComponent(settings.email);
    if (emailLine) emailLine.hidden = false;
  } else if (emailLine) emailLine.hidden = true;
  const enquiryForm = byId("contact-enquiry-form");
  if (enquiryForm) enquiryForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (!enquiryForm.reportValidity()) return;
    const values = new FormData(enquiryForm);
    const submit = enquiryForm.querySelector('[type="submit"]');
    const popup = window.open("about:blank", "_blank");
    submit.disabled = true;
    byId("enquiry-error").textContent = "";
    byId("enquiry-success").textContent = "";
    try {
      const result = await api("/api/enquiries", { method: "POST", body: {
        name: String(values.get("name") || "").trim(),
        phone: String(values.get("phone") || "").trim(),
        email: String(values.get("email") || "").trim(),
        subject: String(values.get("subject") || "").trim(),
        message: String(values.get("message") || "").trim(),
        website: String(values.get("website") || ""),
      } });
      if (popup && !popup.closed) { popup.location.href = result.whatsapp_url; popup.opener = null; }
      else window.location.href = result.whatsapp_url;
      enquiryForm.reset();
      byId("enquiry-success").textContent = "Your message has been saved. WhatsApp opened; press Send there to contact the showroom.";
    } catch (error) {
      if (popup && !popup.closed) popup.close();
      byId("enquiry-error").textContent = error.message || "We could not save your message. Please try again.";
    } finally { submit.disabled = false; }
  });
}
async function initialize() {
  const page = document.body.dataset.page;
  const settingsPromise = bootChrome();
  const needsProducts = ["home", "shop", "product"].includes(page) || (page === "cart" && getCart().length > 0);
  const productsPromise = needsProducts ? fetchProducts() : Promise.resolve([]);
  settings = await settingsPromise;
  setWhatsAppLinks();
  setBusinessJsonLd();
  setHeroHeading();
  configureHomeContent();
  configureAboutContent();
  const products = await productsPromise;
  if (page === "home") renderHome(products);
  if (page === "shop") initShop(products);
  if (page === "product") await initProduct(products);
  if (page === "cart") {
    await renderCart(products);
    window.addEventListener("onby:cartchange", function () { renderCart(productCache); });
  }
  if (page === "checkout") await initCheckout();
  if (page === "contact") initContact();
  if (page === "confirmation") initConfirmation();
  initScrollReveals();
}

initialize().catch(function (error) {
  console.error("Storefront initialization failed", error);
});
