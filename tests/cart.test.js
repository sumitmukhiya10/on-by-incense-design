import assert from "node:assert/strict";
import test from "node:test";

const storedValues = new Map();
const dispatched = [];
globalThis.localStorage = {
  getItem(key) { return storedValues.has(key) ? storedValues.get(key) : null; },
  setItem(key, value) { storedValues.set(key, String(value)); },
  removeItem(key) { storedValues.delete(key); },
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
};
globalThis.window = { dispatchEvent(event) { dispatched.push(event); } };

const { addToCart, cartItemsForQuote, getCart, saveCart, setCartQuantity } = await import("../js/store.js");

test("cart merges product IDs, saves quantities only, and updates/removes items", () => {
  storedValues.clear();
  dispatched.length = 0;

  addToCart(17, 1);
  addToCart(17, 2);
  addToCart(24, 1);

  assert.deepEqual(getCart(), [{ id: 17, quantity: 3 }, { id: 24, quantity: 1 }]);
  assert.deepEqual(JSON.parse(storedValues.get("onby_cart_v1")), [
    { id: 17, quantity: 3 },
    { id: 24, quantity: 1 },
  ]);
  assert.deepEqual(cartItemsForQuote(getCart()), [
    { product_id: 17, quantity: 3 },
    { product_id: 24, quantity: 1 },
  ]);
  assert.equal(dispatched.at(-1).type, "onby:cartchange");

  setCartQuantity(17, 2);
  setCartQuantity(24, 0);
  assert.deepEqual(getCart(), [{ id: 17, quantity: 2 }]);

  saveCart([]);
  assert.deepEqual(getCart(), []);
});
