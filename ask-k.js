// Ask K: the order-help chat opened by the floating "Need help with an order?"
// button (footer.html). Questions go to /api/ask-k (cloudflare/src/ask-k.js).
// When K can't help, it opens the contact modal on the right topic with a
// summary typed in and this chat attached (window.openContactModal, footer.js).
// For order updates it shows an email field: the status of that address's site
// orders is emailed to it (/api/ask-k/order-status), never shown in the chat.
(function() {
  var API = "/api/ask-k";
  var STATUS_API = "/api/ask-k/order-status";
  var LOOKUP_INTRO = "I can email you the latest status and tracking for orders placed on this website (or custom work Megan invoiced you for). Which email address did you order with?";
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

  function post(url, body, token) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({}, body, { pass: state.pass || undefined, turnstileToken: token || undefined }))
    }).then(function(response) {
      return response.json().catch(function() { return {}; }).then(function(data) {
        data.status = response.status;
        return data;
      });
    });
  }

  // Posts with the conversation pass, or a Turnstile token when there is none yet.
  function call(url, body, retried) {
    var tokenNeeded = !state.pass;
    var tokenReady = tokenNeeded ? turnstileToken() : Promise.resolve("");
    return tokenReady.then(function(token) {
      if (tokenNeeded) useToken();
      return post(url, body, token);
    }).then(function(data) {
      if (data.pass) state.pass = data.pass;
      if (data.needsVerification && !retried) {
        state.pass = "";
        return call(url, body, true);
      }
      return data;
    });
  }

  function ask(question) {
    return call(API, { message: question, history: state.history });
  }

  // The "email me my order status" field, shown under K's message. The address is
  // sent once and kept nowhere: not in the chat, the history or session storage.
  function lookupForm() {
    var form = document.createElement("form");
    form.className = "ask-k-lookup";
    form.innerHTML = '<label class="ask-k-lookup-label">Email you ordered with</label>' +
      '<input class="ask-k-lookup-email" type="email" required maxlength="254" autocomplete="email" placeholder="you@example.com">' +
      '<label class="ask-k-lookup-label">Order number <span class="ask-k-lookup-optional">(optional, for just that order)</span></label>' +
      '<div class="ask-k-lookup-row"><input class="ask-k-lookup-number" type="text" maxlength="30" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="FMG-7K3QX2">' +
      '<button type="submit">Email my status</button></div>' +
      '<p class="ask-k-lookup-note">We\'ll send the status and tracking to that inbox. Nothing about your order is shown here.</p>';
    var input = form.querySelector(".ask-k-lookup-email");
    var numberInput = form.querySelector(".ask-k-lookup-number");
    var labels = form.querySelectorAll("label");
    var stamp = Date.now();
    input.id = "ask-k-lookup-email-" + stamp;
    numberInput.id = "ask-k-lookup-number-" + stamp;
    labels[0].setAttribute("for", input.id);
    labels[1].setAttribute("for", numberInput.id);
    form.addEventListener("submit", function(event) {
      event.preventDefault();
      var email = input.value.trim();
      if (!email || busy) return;
      busy = true;
      var button = form.querySelector("button");
      button.disabled = true;
      button.textContent = "Sending...";
      call(STATUS_API, { email: email, orderNumber: numberInput.value.trim() || undefined }).then(function(data) {
        if (!data.ok) {
          button.disabled = false;
          button.textContent = "Email my status";
          addBubble("assistant", data.error || NETWORK_ERROR);
          return;
        }
        form.remove();
        state.history.push({ role: "assistant", content: data.reply });
        save();
        addBubble("assistant", data.reply);
      }, function() {
        button.disabled = false;
        button.textContent = "Email my status";
        addBubble("assistant", NETWORK_ERROR);
      }).then(function() {
        busy = false;
      });
    });
    setTimeout(function() { input.focus(); }, 0);
    return form;
  }

  function showLookup(intro) {
    if (intro) {
      state.history.push({ role: "user", content: "Check my order status" }, { role: "assistant", content: intro });
      save();
      addBubble("user", "Check my order status");
      addBubble("assistant", intro);
    }
    var log = el("ask-k-log");
    log.querySelectorAll(".ask-k-lookup").forEach(function(old) { old.remove(); });
    log.appendChild(lookupForm());
    log.scrollTop = log.scrollHeight;
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
      var reply = data.ok ? data.reply : (data.error || NETWORK_ERROR);
      var handoff = data.ok ? data.handoff : (data.handoff || data.status >= 500);
      var summary = data.summary || question;
      state.history.push({ role: "user", content: question });
      if (data.ok) state.history.push({ role: "assistant", content: reply });
      save();
      addBubble("assistant", reply, handoff ? formButton(data.topic, summary) : null);
      if (data.ok && data.lookup) showLookup();
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
      if (!chip || busy) return;
      el("ask-k-chips").hidden = true;
      // Answered here, without a question to Claude.
      if (chip.hasAttribute("data-ask-k-lookup")) showLookup(LOOKUP_INTRO);
      else send(chip.textContent);
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
