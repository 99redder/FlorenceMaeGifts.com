(function() {
  function setDefaultTheme() {
    const theme = localStorage.getItem("mode") || "light-theme";
    const iconMode = localStorage.getItem("iconMode") || "fa-toggle-off";
    const iconText = localStorage.getItem("iconText") || "Light Mode";
    const icon = document.getElementById("icon-mode");
    const text = document.getElementById("icon-text");

    document.body.className = theme;
    if (icon) {
      icon.className = `fa ${iconMode} pull-right`;
    }
    if (text) {
      text.textContent = iconText;
    }
  }

  function toggleMode() {
    const isLight = document.body.classList.contains("light-theme");
    localStorage.setItem("mode", isLight ? "dark-theme" : "light-theme");
    localStorage.setItem("iconMode", isLight ? "fa-toggle-on" : "fa-toggle-off");
    localStorage.setItem("iconText", isLight ? "Dark Mode" : "Light Mode");
    setDefaultTheme();
  }

  function showModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
      modal.style.display = "block";
      modal.setAttribute("aria-hidden", "false");
    }
  }

  function hideModal(modal) {
    if (modal) {
      modal.style.display = "none";
      modal.setAttribute("aria-hidden", "true");
    }
  }

  function wireGlobalClicks() {
    document.addEventListener("click", function(event) {
      const themeToggle = event.target.closest("#icon-mode");
      if (themeToggle) {
        event.preventDefault();
        toggleMode();
        return;
      }

      const opener = event.target.closest("[data-open-modal]");
      if (opener) {
        event.preventDefault();
        showModal(opener.getAttribute("data-open-modal"));
        return;
      }

      const closer = event.target.closest("[data-close-modal]");
      if (closer) {
        event.preventDefault();
        hideModal(document.getElementById(closer.getAttribute("data-close-modal")));
        return;
      }

      const modalBackdrop = event.target.closest(".footer-modal");
      if (modalBackdrop && event.target === modalBackdrop) {
        hideModal(modalBackdrop);
      }
    });

    document.addEventListener("keydown", function(event) {
      if (event.target.closest("#icon-mode") && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        toggleMode();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function() {
    setDefaultTheme();
    wireGlobalClicks();

    if (typeof includeHTML === "function") {
      includeHTML(function() {
        document.dispatchEvent(new Event("htmlincludesloaded"));
      });
    } else {
      document.dispatchEvent(new Event("htmlincludesloaded"));
    }
  });
})();
