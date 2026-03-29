(function () {
  const countrySelect = document.querySelector("[data-country-select]");
  const currencyPreview = document.querySelector("[data-currency-preview]");

  if (countrySelect && currencyPreview) {
    const updateCurrencyPreview = () => {
      const selectedOption = countrySelect.selectedOptions?.[0];
      currencyPreview.value = selectedOption?.dataset?.currencyCode || "USD";
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
  const claimForm = document.querySelector("[data-claim-form]");
  const validationPanel = document.querySelector("[data-validation-panel]");
  const validationList = document.querySelector("[data-validation-list]");
  const validationSummary = document.querySelector("[data-validation-summary]");
  const submitAnywayInput = document.querySelector("[data-submit-anyway]");
  const precheckCompleteInput = document.querySelector("[data-precheck-complete]");
  const justificationInput = document.querySelector("[data-justification-input]");
  const editButton = document.querySelector("[data-validation-edit]");
  const submitAnywayButton = document.querySelector("[data-validation-submit]");

  let bypassPrecheck = false;

  const resetValidationState = () => {
    bypassPrecheck = false;
    if (submitAnywayInput) {
      submitAnywayInput.value = "0";
    }
    if (precheckCompleteInput) {
      precheckCompleteInput.value = "0";
    }
    if (validationPanel) {
      validationPanel.classList.add("hidden");
    }
    if (validationList) {
      validationList.innerHTML = "";
    }
    if (validationSummary) {
      validationSummary.textContent = "Review before routing to approval flow";
    }
  };

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
      resetValidationState();
    };

    [categoryInput, amountInput, dateInput, currencyInput, descriptionInput, fileInput].forEach((node) => {
      if (node) {
        node.addEventListener("input", renderPreview);
        node.addEventListener("change", renderPreview);
      }
    });
    renderPreview();
  }

  if (editButton) {
    editButton.addEventListener("click", () => {
      resetValidationState();
      justificationInput?.focus();
    });
  }

  if (submitAnywayButton) {
    submitAnywayButton.addEventListener("click", () => {
      if (justificationInput && !justificationInput.value.trim()) {
        justificationInput.focus();
        return;
      }
      if (submitAnywayInput) {
        submitAnywayInput.value = "1";
      }
      if (precheckCompleteInput) {
        precheckCompleteInput.value = "1";
      }
      bypassPrecheck = true;
      claimForm?.requestSubmit();
    });
  }

  if (claimForm) {
    claimForm.addEventListener("submit", async (event) => {
      if (bypassPrecheck) {
        bypassPrecheck = false;
        return;
      }

      event.preventDefault();
      resetValidationState();

      const formData = new FormData(claimForm);
      try {
        const response = await fetch("/claims/precheck", {
          method: "POST",
          body: formData,
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || "Validation failed");
        }

        if (!result.warnings?.length) {
          if (precheckCompleteInput) {
            precheckCompleteInput.value = "1";
          }
          bypassPrecheck = true;
          claimForm.requestSubmit();
          return;
        }

        if (validationPanel) {
          validationPanel.classList.remove("hidden");
        }
        if (validationSummary) {
          validationSummary.textContent = `Risk ${result.risk_score} · ${result.summary}`;
        }
        if (validationList) {
          validationList.innerHTML = result.warnings.map((warning) => `
            <article class="validation-item validation-${warning.severity}">
              <strong>${warning.title}</strong>
              <p>${warning.message}</p>
            </article>
          `).join("");
        }
        if (previewNode && result.formatted_request) {
          previewNode.textContent = result.formatted_request;
        }
        justificationInput?.focus();
      } catch (error) {
        if (validationPanel) {
          validationPanel.classList.remove("hidden");
        }
        if (validationSummary) {
          validationSummary.textContent = error.message;
        }
        if (validationList) {
          validationList.innerHTML = `<article class="validation-item validation-danger"><strong>Validation Error</strong><p>${error.message}</p></article>`;
        }
      }
    });
  }
})();
