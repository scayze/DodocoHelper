/** Tiny transient toast for submit feedback on game tabs. */

let timer: number | null = null;

export function showToast(message: string, timeoutMs = 2500): void {
  const node = document.getElementById("toast");
  if (!node) return;
  node.textContent = message;
  node.classList.remove("hidden");
  node.classList.add("show");
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    node.classList.remove("show");
    node.classList.add("hidden");
  }, timeoutMs);
}
