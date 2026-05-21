(function() {
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
          throw new Error(data.error || "Unable to send message right now.");
        }
        return data;
      });
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

  function initFooterForms() {
    var contactForm = document.getElementById("contact-form");
    var contactStatus = document.getElementById("contact-form-status");
    if (contactForm && contactStatus && !contactForm.dataset.bound) {
      contactForm.dataset.bound = "true";
      contactForm.addEventListener("submit", function(event) {
        event.preventDefault();
        contactStatus.textContent = "Sending your message...";
        sendForm("contact", {
          name: document.getElementById("contact-name")?.value || "",
          email: document.getElementById("contact-email")?.value || "",
          message: document.getElementById("contact-message")?.value || ""
        }).then(function() {
          contactForm.reset();
          contactStatus.textContent = "";
          closeModal("modal-contact");
          showSuccessModal("Florence Mae Gifts", "Thanks! Your message was sent. We'll get back to you soon.");
        }).catch(function(err) {
          contactStatus.textContent = err.message || "Could not send message. Please try again.";
        });
      });
    }

    var customForm = document.getElementById("custom-request-form");
    var customStatus = document.getElementById("custom-request-form-status");
    if (customForm && customStatus && !customForm.dataset.bound) {
      customForm.dataset.bound = "true";
      customForm.addEventListener("submit", function(event) {
        event.preventDefault();
        customStatus.textContent = "Sending your request...";
        sendForm("custom", {
          name: document.getElementById("custom-name")?.value || "",
          email: document.getElementById("custom-email")?.value || "",
          phone: document.getElementById("custom-phone")?.value || "",
          requestType: document.getElementById("custom-request-type")?.value || "",
          message: document.getElementById("custom-message")?.value || ""
        }).then(function() {
          customForm.reset();
          customStatus.textContent = "";
          closeModal("modal-custom-request");
          showSuccessModal("Custom Request Received", "Thank you! We got your custom piece request and will email you back soon.");
        }).catch(function(err) {
          customStatus.textContent = err.message || "Could not send request. Please try again.";
        });
      });
    }
  }

  document.addEventListener("htmlincludesloaded", initFooterForms);
})();
