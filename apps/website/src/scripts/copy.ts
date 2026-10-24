for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
  button.hidden = false;
  button.addEventListener("click", async () => {
    const status = button.closest("figure")?.querySelector<HTMLElement>(".copy-status");
    const command = button.getAttribute("data-copy");
    if (!status || !command) return;
    status.textContent = "";
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(command);
      status.textContent = "Copied to clipboard.";
    } catch {
      status.textContent = "Clipboard unavailable. Select and copy the code above.";
      const code = button.closest("figure")?.querySelector("code");
      if (code) {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    } finally {
      button.disabled = false;
    }
  });
}
