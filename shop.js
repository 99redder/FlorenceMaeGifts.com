(function() {
  function initArchiveGallery() {
    const modal = document.getElementById("myModal");
    const modalImg = document.getElementById("img01");
    const captionText = document.getElementById("caption");
    const close = document.querySelector(".close");
    if (!modal || !modalImg || !captionText) return;

    document.querySelectorAll(".examples, #example20").forEach(function(img) {
      img.addEventListener("click", function() {
        modal.style.display = "block";
        modalImg.src = img.src;
        captionText.textContent = img.alt;
      });
    });

    if (close) {
      close.addEventListener("click", function() {
        modal.style.display = "none";
      });
    }
  }

  function parsePriceFromOptionText(text) {
    const match = (text || "").match(/\(\$\d+(?:\.\d{2})?\)/);
    return match ? `${match[0].replace(/[()]/g, "")} USD` : "";
  }

  function hydrateSizeSelector(scopeNode) {
    const orderButton = scopeNode ? scopeNode.querySelector(".start-stripe-order") : null;
    if (!orderButton) return;

    const mapRaw = orderButton.getAttribute("data-size-price-map");
    if (!mapRaw) return;

    let sizeMap;
    try {
      sizeMap = JSON.parse(mapRaw);
    } catch {
      return;
    }

    const sizeOptions = Object.keys(sizeMap);
    if (!sizeOptions.length) return;

    const wrap = document.createElement("div");
    wrap.className = "shop-size-wrap";

    const label = document.createElement("label");
    label.className = "shop-size-label";
    label.textContent = "Choose size";

    const select = document.createElement("select");
    select.className = "shop-size-select";

    const decoder = document.createElement("textarea");

    sizeOptions.forEach(function(optionText, idx) {
      const option = document.createElement("option");
      option.value = sizeMap[optionText];
      decoder.innerHTML = optionText;
      option.textContent = decoder.value;
      if (idx === 0) option.selected = true;
      select.appendChild(option);
    });

    const startingText = select.options[0]?.textContent || "";
    const startingPrice = parsePriceFromOptionText(startingText);
    if (startingPrice) {
      orderButton.setAttribute("data-price-display", startingPrice);
    }

    const priceText = scopeNode.querySelector("p strong");
    if (priceText && startingPrice && priceText.textContent.trim().toLowerCase() === "price:") {
      priceText.parentElement.innerHTML = `<strong>Price:</strong> ${startingPrice}`;
    }

    select.addEventListener("change", function() {
      const selectedOptionText = select.options[select.selectedIndex]?.textContent || "";
      const selectedPrice = parsePriceFromOptionText(selectedOptionText);
      if (selectedPrice) {
        orderButton.setAttribute("data-price-display", selectedPrice);
        const detailPrice = scopeNode.querySelector("p strong");
        if (detailPrice && detailPrice.textContent.trim().toLowerCase() === "price:") {
          detailPrice.parentElement.innerHTML = `<strong>Price:</strong> ${selectedPrice}`;
        }
      }
      orderButton.setAttribute("data-price-id", select.value);
    });

    orderButton.setAttribute("data-price-id", select.value);
    wrap.appendChild(label);
    wrap.appendChild(select);
    orderButton.parentElement.parentElement.insertBefore(wrap, orderButton.parentElement);
  }

  function layoutListingModal(scopeNode) {
    if (!scopeNode || scopeNode.querySelector(".listing-modal-top")) return;

    const mainImageWrap = scopeNode.querySelector(".listing-main-image-wrap");
    const orderButton = scopeNode.querySelector(".start-stripe-order");
    const sizeWrap = scopeNode.querySelector(".shop-size-wrap");
    if (!mainImageWrap || !orderButton) return;

    const orderRow = orderButton.closest("p");
    const priceRow = scopeNode.querySelector("p strong")?.parentElement || null;
    const top = document.createElement("div");
    const actions = document.createElement("div");
    top.className = "listing-modal-top";
    actions.className = "listing-modal-actions";

    top.appendChild(mainImageWrap);
    if (priceRow) actions.appendChild(priceRow);
    if (sizeWrap) actions.appendChild(sizeWrap);
    if (orderRow) actions.appendChild(orderRow);
    top.appendChild(actions);

    const heading = scopeNode.querySelector("h3");
    if (heading) {
      heading.insertAdjacentElement("afterend", top);
    } else {
      scopeNode.prepend(top);
    }
  }

  function listingMatchesCategory(title, category) {
    const t = (title || "").toLowerCase();
    const isPattern = t.includes("pdf download");
    const forceBabySet =
      t === "crochet goku inspired costume with baby onesie and hat (multiple sizes available)" ||
      t === "shenron shenlong gohan inspired four star hat photo set (multiple sizes available)";
    const isBabySet = t.includes("baby set") || t.includes("diaper cover") || forceBabySet;
    const isHat = t.includes("hat") || t.includes("beanie");
    const excludeFromHats =
      t === "crochet baby trunks inspired beanie diaper cover photo set costume (multiple sizes available)" ||
      t === "crochet goku inspired costume with baby onesie and hat (multiple sizes available)" ||
      t === "shenron shenlong gohan inspired four star hat photo set (multiple sizes available)";

    if (category === "patterns") return isPattern;
    if (category === "baby-sets") return isBabySet && !isPattern;
    if (category === "hats") return isHat && !isPattern && !excludeFromHats;
    return true;
  }

  function applyShopCategoryFilter(category) {
    document.querySelectorAll(".shop-listing").forEach(function(listing) {
      const title = listing.querySelector(".open-listing-modal")?.textContent?.trim() || "";
      listing.style.display = listingMatchesCategory(title, category) ? "flex" : "none";
    });
  }

  function hideModal(modal) {
    if (modal) {
      modal.style.display = "none";
      modal.setAttribute("aria-hidden", "true");
    }
  }

  function initShopListingUi() {
    const listingModal = document.getElementById("shop-listing-modal");
    const listingModalBody = document.getElementById("shop-modal-body");
    const listingModalClose = document.getElementById("shop-modal-close");
    const checkoutStatusModal = document.getElementById("checkout-status-modal");
    const checkoutStatusClose = document.getElementById("checkout-status-close");
    const checkoutStatusTitle = document.getElementById("checkout-status-title");
    const checkoutStatusText = document.getElementById("checkout-status-text");

    if (!listingModal && !checkoutStatusModal) return;

    showCheckoutStatusFromQuery(checkoutStatusModal, checkoutStatusTitle, checkoutStatusText);

    document.addEventListener("click", function(event) {
      const categoryTab = event.target.closest(".shop-category-tab");
      if (categoryTab) {
        event.preventDefault();
        const category = categoryTab.getAttribute("data-category") || "all";
        document.querySelectorAll(".shop-category-tab").forEach(function(tab) {
          tab.classList.remove("active");
        });
        categoryTab.classList.add("active");
        applyShopCategoryFilter(category);
        return;
      }

      const trigger = event.target.closest(".open-listing-modal");
      if (trigger) {
        event.preventDefault();
        const targetId = trigger.getAttribute("data-modal-target");
        const detailsNode = document.getElementById(targetId);
        if (detailsNode && listingModal && listingModalBody) {
          listingModalBody.innerHTML = detailsNode.innerHTML;
          hydrateSizeSelector(listingModalBody);
          layoutListingModal(listingModalBody);
          listingModal.style.display = "block";
          listingModal.setAttribute("aria-hidden", "false");
        }
        return;
      }

      const selectedThumb = event.target.closest(".listing-gallery-thumb");
      if (selectedThumb) {
        const fullSrc = selectedThumb.getAttribute("data-full-src") || selectedThumb.getAttribute("src");
        const modalMainImage = listingModalBody ? listingModalBody.querySelector(".listing-main-image") : null;
        if (modalMainImage && fullSrc) {
          modalMainImage.setAttribute("src", fullSrc);
        }
        return;
      }

      const stripeOrderButton = event.target.closest(".start-stripe-order");
      if (stripeOrderButton) {
        event.preventDefault();
        handleStripeOrderButton(stripeOrderButton);
        return;
      }

      if (event.target === listingModal) {
        hideModal(listingModal);
      }
    });

    if (listingModalClose) {
      listingModalClose.addEventListener("click", function() {
        hideModal(listingModal);
      });
    }

    if (checkoutStatusClose && checkoutStatusModal) {
      checkoutStatusClose.addEventListener("click", function() {
        hideModal(checkoutStatusModal);
      });
      checkoutStatusModal.addEventListener("click", function(event) {
        if (event.target === checkoutStatusModal) {
          hideModal(checkoutStatusModal);
        }
      });
    }

    document.addEventListener("keydown", function(event) {
      if (event.key === "Escape") {
        if (listingModal && listingModal.style.display === "block") hideModal(listingModal);
        if (checkoutStatusModal && checkoutStatusModal.style.display === "block") hideModal(checkoutStatusModal);
      }
    });
  }

  function showCheckoutStatusFromQuery(checkoutStatusModal, checkoutStatusTitle, checkoutStatusText) {
    if (!checkoutStatusModal || !checkoutStatusTitle || !checkoutStatusText) return;

    const params = new URLSearchParams(window.location.search);
    const checkoutStatus = params.get("checkout");

    if (checkoutStatus === "success") {
      checkoutStatusTitle.textContent = "Order Confirmed";
      checkoutStatusText.innerHTML = "Thank you for your order! Your checkout was completed successfully.";
      const sessionId = params.get("session_id");
      if (sessionId) {
        fetch(`/api/checkout-session-details?session_id=${encodeURIComponent(sessionId)}`)
          .then((res) => res.json().then((details) => ({ ok: res.ok, details })))
          .then(({ ok, details }) => {
            if (ok && details?.isDigital) {
              checkoutStatusText.innerHTML += "<br><br><strong>A download link for your pattern will be sent to your email.</strong>";
              if (details?.downloadUrl) {
                checkoutStatusText.innerHTML += `<br><br><strong>Your digital download is ready:</strong><br><a href="${details.downloadUrl}" target="_blank" rel="noopener noreferrer">Download your PDF file</a>`;
              }
            }
          }).catch(function() {});
      }
      checkoutStatusModal.style.display = "block";
      checkoutStatusModal.setAttribute("aria-hidden", "false");
      params.delete("checkout");
      params.delete("session_id");
      window.history.replaceState({}, "", `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`);
      return;
    }

    if (checkoutStatus === "cancel") {
      checkoutStatusTitle.textContent = "Checkout Canceled";
      checkoutStatusText.textContent = "No problem - your order was not completed. You can try again anytime.";
      checkoutStatusModal.style.display = "block";
      checkoutStatusModal.setAttribute("aria-hidden", "false");
      params.delete("checkout");
      window.history.replaceState({}, "", `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`);
    }
  }

  function handleStripeOrderButton(stripeOrderButton) {
    const itemName = stripeOrderButton.getAttribute("data-item-name") || "Custom Item";
    const isPdfOnly = [
      "Four Star Ball Crochet Baby Hat Pattern - Beginner Level (PDF Download Only)",
      "Crochet Baby Hat Pattern: Five Point Design (PDF Download Only)"
    ].includes(itemName);

    if (isPdfOnly && !window.confirm("Digital item confirmation: You are purchasing a digital item only. This order includes a PDF file only, and no physical item will be shipped. Continue?")) {
      return;
    }

    const paymentLink = stripeOrderButton.getAttribute("data-payment-link");
    if (paymentLink && paymentLink.startsWith("https://buy.stripe.com/")) {
      window.location.href = paymentLink;
      return;
    }

    const priceId = stripeOrderButton.getAttribute("data-price-id") || "";
    if (priceId && priceId.startsWith("price_")) {
      stripeOrderButton.disabled = true;
      stripeOrderButton.textContent = "Redirecting to secure checkout...";
      fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedItemName: itemName, priceId: priceId })
      }).then((res) => res.json()).then(function(data) {
        if (data && data.url) {
          window.location.href = data.url;
          return;
        }
        throw new Error(data?.error || "Could not create checkout session.");
      }).catch(function(err) {
        alert(err.message || "Checkout failed. Please try again.");
        stripeOrderButton.disabled = false;
        stripeOrderButton.textContent = "Order this item with secure checkout";
      });
      return;
    }

    const customRequest = document.getElementById("modal-custom-request");
    if (customRequest) customRequest.style.display = "block";
  }

  document.addEventListener("DOMContentLoaded", initArchiveGallery);
  document.addEventListener("htmlincludesloaded", initShopListingUi);
})();
