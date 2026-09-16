(() => {
  const titleText = document.getElementById("auth-title-text");
  const subtitle = document.getElementById("auth-subtitle");
  const form = document.getElementById("auth-form");
  const submitBtn = document.getElementById("submit-btn");
  const passwordHint = document.getElementById("password-hint");
  const messageEl = document.getElementById("form-message");

  let mode = "login"; // or "setup"

  function showMessage(text, kind) {
    messageEl.textContent = text;
    messageEl.className = `form-message ${kind}`;
    messageEl.hidden = false;
  }

  async function init() {
    try {
      const res = await fetch("/api/auth/status");
      const data = await res.json();

      if (data.loggedIn) {
        window.location.href = "/admin.html";
        return;
      }

      if (data.setupRequired) {
        mode = "setup";
        titleText.textContent = "Create admin account";
        subtitle.textContent = "No admin account exists yet — create the first (and only) one.";
        submitBtn.textContent = "Create account";
        passwordHint.hidden = false;
        document.getElementById("password").setAttribute("autocomplete", "new-password");
      }
    } catch {
      showMessage("Couldn't reach the server. Try reloading the page.", "error");
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    messageEl.hidden = true;
    submitBtn.disabled = true;

    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    const endpoint = mode === "setup" ? "/api/auth/setup" : "/api/auth/login";

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        showMessage(data.error || "Something went wrong.", "error");
        submitBtn.disabled = false;
        return;
      }

      window.location.href = "/admin.html";
    } catch {
      showMessage("Couldn't reach the server. Try again.", "error");
      submitBtn.disabled = false;
    }
  });

  init();
})();
