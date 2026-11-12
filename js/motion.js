const REVEAL_SELECTOR = "main > section:not(.hero), .category-tile, .product-card, .story-split";

export function initScrollReveals(root = document) {
  if (!("IntersectionObserver" in window)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const isHomePage = document.body.dataset.page === "home";
  document.documentElement.classList.toggle("home-motion", isHomePage);
  const elements = Array.from(root.querySelectorAll(REVEAL_SELECTOR));
  if (!elements.length) return;

  let observerResponded = false;
  const observer = new IntersectionObserver((entries) => {
    observerResponded = true;
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-revealed");
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -5% 0px" });

  elements.forEach((element, index) => {
    element.classList.add("scroll-reveal");
    const delay = isHomePage ? Math.min(index % 3, 2) * 28 : Math.min(index % 4, 3) * 45;
    element.style.setProperty("--reveal-delay", `${delay}ms`);
    observer.observe(element);
  });
  document.documentElement.classList.add("motion-ready");

  window.setTimeout(() => {
    if (observerResponded) return;
    observer.disconnect();
    elements.forEach((element) => element.classList.add("is-revealed"));
  }, 1800);
}
