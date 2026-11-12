import { api } from "./api.js";

const form = document.getElementById("setup-form");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.getElementById("setup-error");
  const button = document.getElementById("setup-submit");
  const password = document.getElementById("setup-password").value;
  if (password !== document.getElementById("setup-confirm").value) {
    error.textContent = "The passwords do not match.";
    return;
  }
  const masterPassword = document.getElementById("setup-master-password").value;
  if (masterPassword !== document.getElementById("setup-master-confirm").value) {
    error.textContent = "The master recovery passwords do not match.";
    return;
  }
  if (password === masterPassword) {
    error.textContent = "Choose different Admin and master recovery passwords.";
    return;
  }
  button.disabled = true;
  button.textContent = "Setting up…";
  try {
    const result = await api("/api/admin/setup", { method: "POST", body: { setup_code: document.getElementById("setup-code").value.trim(), password, master_password: masterPassword } });
    form.reset();
    document.getElementById("setup-result").textContent = `${result.message}\n\nYour one-time backup code: ${result.recovery_code}\n\nYour master recovery password can be used more than once. Store it somewhere private.`;
    document.getElementById("setup-result").classList.add("recovery-code-result");
    button.textContent = "Setup complete";
  } catch (failure) {
    error.textContent = failure.message || "Admin setup could not be completed.";
    button.disabled = false;
    button.textContent = "Create admin password";
  }
});
