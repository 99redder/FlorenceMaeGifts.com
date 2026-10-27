(function() {
  var SEND_FAILED = "Sorry, your message didn't go through. Please try again in a moment, or email us at contact@florencemaegifts.com.";

  // Rejects with an Error whose message can be shown to the visitor.
  function sendForm(mode, payload) {
    return fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ mode: mode }, payload))
    }).then(function(response) {
      return response.json().catch(function() {
        return {};
      }).then(function(data) {
        if (!response.ok) {
          // Server-side failures are nothing the visitor can fix; 4xx errors ("Invalid email address") are.
          throw new Error(response.status < 500 && data.error ? data.error : SEND_FAILED);
        }
        return data;
      });
    }, function() {
      throw new Error(SEND_FAILED);
    });
  }

  function showSuccessModal(title, message) {
    var modal = document.getElementById("modal-form-success");
    var titleEl = document.getElementById("form-success-title");
    var msgEl = document.getElementById("form-success-message");
    if (!modal || !titleEl || !msgEl) return;
    titleEl.textContent = title;
    msgEl.textContent = message;
    modal.style.display = "block";
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal(id) {
    var modal = document.getElementById(id);
    if (modal) {
      modal.style.display = "none";
      modal.setAttribute("aria-hidden", "true");
    }
  }

  // Show the fields for the chosen topic. Hidden fields are disabled, so the
  // browser skips their "required" check and FormData leaves them out.
  function applyContactTopic(form) {
    var topicSelect = document.getElementById("contact-topic");
    if (!topicSelect) return;
    if (!topicSelect.value) topicSelect.value = "general";
    var topic = topicSelect.value;
    var option = topicSelect.options[topicSelect.selectedIndex];

    form.querySelectorAll("[data-topics]").forEach(function(section) {
      var show = section.getAttribute("data-topics").split(" ").indexOf(topic) !== -1;
      section.hidden = !show;
      section.querySelectorAll("input, select, textarea").forEach(function(field) {
        field.disabled = !show;
      });
    });

    var messageLabel = document.getElementById("contact-message-label");
    var message = document.getElementById("contact-message");
    var submitText = document.querySelector("#contact-submit span");
    if (messageLabel) messageLabel.textContent = option.getAttribute("data-label") || "Your message";
    if (message) message.placeholder = option.getAttribute("data-placeholder") || "";
    if (submitText) submitText.textContent = option.getAttribute("data-submit") || "Send message";
  }

  // The listing a link sits in (a product page, or the shop's listing modal), so a
  // sizing question can say which item it is about.
  function itemNameNear(opener) {
    var listing = opener && opener.closest(".shop-listing-details, #shop-modal-body");
    var button = listing && listing.querySelector(".start-stripe-order[data-item-name]");
    if (!button) return "";
    return button.getAttribute("data-item-name").replace(/\s*\(Multiple Sizes Available\)\s*$/i, "");
  }

  // Ask K's chat to send along with the message (ask-k.js); empty when the form was opened any other way.
  function setAskKChat(chat) {
    var field = document.getElementById("contact-askk-chat");
    var note = document.getElementById("contact-askk-note");
    if (field) field.value = chat || "";
    if (note) note.hidden = !chat;
  }

  // extras (from Ask K): { message, chat } - message is typed into the message box.
  function openContactModal(topic, opener, extras) {
    var modal = document.getElementById("modal-contact");
    var form = document.getElementById("contact-form");
    if (!modal || !form) return;
    extras = extras || {};

    var topicSelect = document.getElementById("contact-topic");
    if (topicSelect) {
      topicSelect.value = topic || "general";
      applyContactTopic(form);
    }
    var itemField = document.getElementById("contact-item");
    var item = itemNameNear(opener);
    if (itemField && item) itemField.value = item;
    var messageField = document.getElementById("contact-message");
    if (messageField && extras.message) messageField.value = extras.message;
    setAskKChat(extras.chat);

    modal.style.display = "block";
    modal.setAttribute("aria-hidden", "false");
    var firstEmpty = Array.prototype.find.call(form.querySelectorAll("#contact-name, #contact-email, #contact-message"), function(field) {
      return !field.value;
    });
    (firstEmpty || topicSelect || form).focus();
  }

  function initFooterForms() {
    var contactForm = document.getElementById("contact-form");
    var contactStatus = document.getElementById("contact-form-status");
    if (contactForm && contactStatus && !contactForm.dataset.bound) {
      contactForm.dataset.bound = "true";
      var topicSelect = document.getElementById("contact-topic");
      var neededBy = document.getElementById("contact-needed");
      if (neededBy) neededBy.min = new Date().toISOString().slice(0, 10);
      if (topicSelect) {
        topicSelect.addEventListener("change", function() {
          applyContactTopic(contactForm);
        });
        applyContactTopic(contactForm);
      }

      contactForm.addEventListener("submit", function(event) {
        event.preventDefault();
        var submitButton = document.getElementById("contact-submit");
        var payload = {};
        new FormData(contactForm).forEach(function(value, key) {
          payload[key] = value;
        });
        var isCustom = payload.topic === "custom";

        contactStatus.classList.remove("is-error");
        contactStatus.textContent = "Sending your message...";
        if (submitButton) submitButton.disabled = true;
        sendForm("contact", payload).then(function() {
          contactForm.reset();
          setAskKChat("");
          applyContactTopic(contactForm);
          contactStatus.textContent = "";
          closeModal("modal-contact");
          showSuccessModal(
            isCustom ? "Custom request received" : "Message sent",
            isCustom
              ? "Thank you! Megan will look over your idea and email you back within 24 hours."
              : "Thanks for reaching out! Megan will email you back within 24 hours."
          );
        }).catch(function(err) {
          contactStatus.classList.add("is-error");
          contactStatus.textContent = err.message || SEND_FAILED;
        }).then(function() {
          if (submitButton) submitButton.disabled = false;
        });
      });
    }
  }

  // Any link to the contact modal can pick its topic: data-contact-topic="custom".
  document.addEventListener("click", function(event) {
    var opener = event.target.closest('[data-open-modal="modal-contact"]');
    if (!opener) return;
    event.preventDefault();
    openContactModal(opener.getAttribute("data-contact-topic"), opener);
  });

  window.openContactModal = openContactModal;
  document.addEventListener("htmlincludesloaded", initFooterForms);
})();
