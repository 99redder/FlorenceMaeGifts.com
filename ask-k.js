// Ask K: the order-help chat opened by the floating "Need help with an order?"
// button (footer.html). Questions go to /api/ask-k (cloudflare/src/ask-k.js).
// When K can't help, it opens the contact modal on the right topic with a
// summary typed in and this chat attached (window.openContactModal, footer.js).
(function() {
  var API = "/api/ask-k";
  var TURNSTILE_SITE_KEY = "0x4AAAAAAFnNlSgwL9V46Urf";
  var TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  var STORE_KEY = "fmgAskK";
  var HANDOFF_DELAY = 1600;
  var NETWORK_ERROR = "Sorry, I couldn't reach the shop just now. You can send Megan a message instead.";

  // Kept for this browser tab, so the chat survives moving between pages.
  var state = { history: [], pass: "" };
  var busy = false;
  var turnstile = { loading: null, widget: null, token: "", waiters: [] };

  function load() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
      if (saved && Array.isArray(saved.history)) state = { history: saved.history.slice(-20), pass: saved.pass || "" };
    } catch (e) {}
  }

  function save() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  function el(id) {
    return document.getElementById(id);
  }

  // Plain text with **bold**, line breaks, and links only to this site and the Etsy shop.
  function formatReply(text) {
    var div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/https:\/\/(?:www\.)?(?:florencemaegifts\.com|etsy\.com\/shop\/florencemaegifts)[^\s<]*/gi, function(url) {
        var trail = url.match(/[.,!?)]+$/);
        var clean = trail ? url.slice(0, -trail[0].length) : url;
        return '<a href="' + clean + '" target="_blank" rel="noopener">' + clean.replace(/^https:\/\/(www\.)?/, "") + "</a>" + (trail ? trail[0] : "");
      })
      .replace(/\n/g, "<br>");
  }

  function addBubble(role, text, extra) {
    var log = el("ask-k-log");
    var bubble = document.createElement("div");
    bubble.className = "ask-k-msg ask-k-" + (role === "user" ? "me" : "k");
    if (role === "user") bubble.textContent = text;
    else bubble.innerHTML = formatReply(text);
    if (extra) bubble.appendChild(extra);
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  function formButton(topic, summary) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "ask-k-handoff";
    button.textContent = "Open the message form";
    button.addEventListener("click", function() {
      openForm(topic, summary);
    });
    return button;
  }

  function renderLog() {
    var log = el("ask-k-log");
    log.innerHTML = "";
    addBubble("assistant", "Hi! I'm K, the Florence Mae Gifts helper. Ask me when your order will ship, which size to get, how returns work, or anything else about the shop.");
    state.history.forEach(function(turn) {
      addBubble(turn.role, turn.content);
    });
    el("ask-k-chips").hidden = state.history.length > 0;
  }

  function transcript() {
    var text = state.history.map(function(turn) {
      return (turn.role === "user" ? "Visitor: " : "K: ") + turn.content;
    }).join("\n\n");
    return text.length > 7000 ? "..." + text.slice(-7000) : text;
  }

  function openForm(topic, summary) {
    if (typeof window.openContactModal !== "function") return;
    window.openContactModal(topic || "order", null, { message: summary || "", chat: transcript() });
  }

  // ── Turnstile: loaded on first open, only shows itself if the visitor must click ──

  function loadTurnstile() {
    if (turnstile.loading) return turnstile.loading;
    turnstile.loading = new Promise(function(resolve, reject) {
      var script = document.createElement("script");
      script.src = TURNSTILE_SRC;
      script.async = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    }).then(function() {
      turnstile.widget = window.turnstile.render("#ask-k-turnstile", {
        sitekey: TURNSTILE_SITE_KEY,
        action: "ask_k",
        appearance: "interaction-only",
        theme: document.body.classList.contains("dark-theme") ? "dark" : "light",
        callback: function(token) {
          turnstile.token = token;
          turnstile.waiters.splice(0).forEach(function(done) { done(token); });
        },
        "expired-callback": function() { turnstile.token = ""; },
        "error-callback": function() { turnstile.token = ""; }
      });
    });
    return turnstile.loading;
  }

  // A fresh token, waiting up to 30 seconds for the check to finish.
  function turnstileToken() {
    return loadTurnstile().then(function() {
      if (turnstile.token) return turnstile.token;
      return new Promise(function(resolve) {
        turnstile.waiters.push(resolve);
        setTimeout(function() { resolve(""); }, 30000);
      });
    }, function() { return ""; });
  }

  function useToken() {
    turnstile.token = "";
    if (window.turnstile && turnstile.widget !== null) window.turnstile.reset(turnstile.widget);
  }

  // ── Asking ──

  function post(question, token) {
    return fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question, history: state.history, pass: state.pass || undefined, turnstileToken: token || undefined })
    }).then(function(response) {
      return response.json().catch(function() { return {}; }).then(function(data) {
        data.status = response.status;
        return data;
      });
    });
  }

  function ask(question, retried) {
    var tokenNeeded = !state.pass;
    var tokenReady = tokenNeeded ? turnstileToken() : Promise.resolve("");
    return tokenReady.then(function(token) {
      if (tokenNeeded) useToken();
      return post(question, token);
    }).then(function(data) {
      if (data.needsVerification && !retried) {
        state.pass = "";
        return ask(question, true);
      }
      return data;
    });
  }

  function send(question) {
    question = question.trim();
    if (!question || busy) return;
    busy = true;
    var input = el("ask-k-input");
    var sendButton = el("ask-k-send");
    input.value = "";
    autoGrow();
    sendButton.disabled = true;
    el("ask-k-chips").hidden = true;
    addBubble("user", question);
    var typing = addBubble("assistant", "");
    typing.classList.add("ask-k-typing");
    typing.innerHTML = '<span></span><span></span><span></span><span class="ask-k-sr">K is typing</span>';

    ask(question).then(function(data) {
      typing.remove();
      if (data.pass) state.pass = data.pass;
      var reply = data.ok ? data.reply : (data.error || NETWORK_ERROR);
      var handoff = data.ok ? data.handoff : (data.handoff || data.status >= 500);
      var summary = data.summary || question;
      state.history.push({ role: "user", content: question });
      if (data.ok) state.history.push({ role: "assistant", content: reply });
      save();
      addBubble("assistant", reply, handoff ? formButton(data.topic, summary) : null);
      if (handoff) {
        setTimeout(function() { openForm(data.topic || "order", summary); }, HANDOFF_DELAY);
      }
    }, function() {
      typing.remove();
      addBubble("assistant", NETWORK_ERROR, formButton("order", question));
    }).then(function() {
      busy = false;
      sendButton.disabled = false;
      if (isOpen()) input.focus();
    });
  }

  // ── Panel ──

  function isOpen() {
    var panel = el("ask-k");
    return !!panel && !panel.hidden;
  }

  function autoGrow() {
    var input = el("ask-k-input");
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }

  function setOpen(open) {
    var panel = el("ask-k");
    if (!panel) return;
    panel.hidden = !open;
    document.body.classList.toggle("ask-k-open", open);
    document.querySelectorAll("[data-ask-k-open]").forEach(function(button) {
      button.setAttribute("aria-expanded", open ? "true" : "false");
    });
    if (open) {
      if (!state.pass) loadTurnstile().catch(function() {});
      el("ask-k-input").focus();
      var log = el("ask-k-log");
      log.scrollTop = log.scrollHeight;
    } else {
      var opener = document.querySelector("[data-ask-k-open]");
      if (opener) opener.focus();
    }
  }

  function init() {
    if (!el("ask-k") || el("ask-k").dataset.bound) return;
    el("ask-k").dataset.bound = "true";
    load();
    renderLog();

    el("ask-k-form").addEventListener("submit", function(event) {
      event.preventDefault();
      send(el("ask-k-input").value);
    });
    el("ask-k-input").addEventListener("input", autoGrow);
    el("ask-k-input").addEventListener("keydown", function(event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send(el("ask-k-input").value);
      }
    });
    el("ask-k-chips").addEventListener("click", function(event) {
      var chip = event.target.closest("button");
      if (chip) send(chip.textContent);
    });
    el("ask-k").addEventListener("keydown", function(event) {
      var modalOpen = document.querySelector('.footer-modal[aria-hidden="false"]');
      if (event.key === "Escape" && !modalOpen) setOpen(false);
    });
  }

  // Captured before site.js / footer.js see the click: the button still carries
  // data-open-modal="modal-contact", so it opens the form if this script never loads.
  document.addEventListener("click", function(event) {
    var target = event.target.closest("[data-ask-k-open], [data-ask-k-close], [data-ask-k-skip]");
    if (!target || !el("ask-k")) return;
    event.preventDefault();
    event.stopPropagation();
    init();
    if (target.hasAttribute("data-ask-k-open")) setOpen(!isOpen());
    else if (target.hasAttribute("data-ask-k-close")) setOpen(false);
    else openForm("order", "");
  }, true);

  document.addEventListener("htmlincludesloaded", init);
})();
