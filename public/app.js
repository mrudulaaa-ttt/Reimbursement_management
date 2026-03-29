(function () {
  const currencyMap = window.currencyMap || {};
  const countrySelect = document.querySelector("[data-country-select]");
  const currencyPreview = document.querySelector("[data-currency-preview]");

  if (countrySelect && currencyPreview) {
    const updateCurrencyPreview = () => {
      currencyPreview.value = currencyMap[countrySelect.value] || "USD";
    };
    countrySelect.addEventListener("change", updateCurrencyPreview);
    updateCurrencyPreview();
  }

  const categoryInput = document.querySelector("[data-request-category]");
  const amountInput = document.querySelector("[data-request-amount]");
  const dateInput = document.querySelector("[data-request-date]");
  const currencyInput = document.querySelector("[data-request-currency]");
  const descriptionInput = document.querySelector("[data-request-description]");
  const fileInput = document.querySelector("[data-request-file]");
  const previewNode = document.querySelector("[data-request-preview]");

  if (previewNode) {
    const renderPreview = () => {
      const parts = [
        `Category: ${categoryInput?.selectedOptions?.[0]?.text || "Not selected"}`,
        `Amount: ${currencyInput?.value || "INR"} ${amountInput?.value || "0"}`,
        `Date: ${dateInput?.value || "Not set"}`,
        `Description: ${descriptionInput?.value || "Not added"}`,
        `Document: ${fileInput?.files?.[0]?.name || "Not uploaded"}`,
        "AI checks: OCR, duplicate detection, authenticity, threshold suggestor",
      ];
      previewNode.textContent = parts.join(" | ");
    };

    [categoryInput, amountInput, dateInput, currencyInput, descriptionInput, fileInput].forEach((node) => {
      if (node) {
        node.addEventListener("input", renderPreview);
        node.addEventListener("change", renderPreview);
      }
    });
    renderPreview();
  }
})();
