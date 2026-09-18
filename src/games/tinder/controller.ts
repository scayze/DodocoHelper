/** Tinder curator: one card, two buttons. No timer, no leaderboard.
 *
 * Cards come from Historypin (photo pins with time + location stamps).
 * Same SnapshotItem schema as the game; votes land in a separate dataset.
 */
import { apiUrl } from "../../leaderboard/api.js";
import { el } from "../dom.js";

interface TinderCard {
  id: string;
  title: string;
  image: string;
  fallbackImage: string | null;
  page: string;
  lat: number;
  lon: number;
  placeName: string;
  year: number;
  license: string;
  blurb: string;
  blurbSource: string;
  pinId: string;
  sourceImage: string;
}

/** Tinder fetches run live upstream harvests: allow 60s, not the 8s game default. */
async function fetchTinder(path: string, init?: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(apiUrl(path), { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  } finally {
    window.clearTimeout(timer);
  }
}

export function initTinder(): void {
  const root = el("tinder");
  const img = el<HTMLImageElement>("tinder-img");
  const title = el("tinder-title");
  const meta = el("tinder-meta");
  const blurb = el("tinder-blurb");
  const blurbToggle = el<HTMLButtonElement>("tinder-blurb-toggle");
  const status = el("tinder-status");
  const count = el("tinder-count");
  const acceptBtn = el<HTMLButtonElement>("tinder-accept");
  const rejectBtn = el<HTMLButtonElement>("tinder-reject");
  const retryBtn = el<HTMLButtonElement>("tinder-retry");
  const source = el<HTMLAnchorElement>("tinder-source");
  const lightbox = el("tinder-lightbox");
  // Host at body level: panel backdrop-filters would otherwise contain
  // the fixed overlay and clip it to the card.
  const lightboxImg = el<HTMLImageElement>("tinder-lightbox-img");
  const lightboxClose = el<HTMLButtonElement>("tinder-lightbox-close");
  document.body.appendChild(lightbox);

  root.classList.remove("hidden");

  let queue: TinderCard[] = [];
  let current: TinderCard | null = null;
  let paintedId = "";
  let busy = false;
  let accepted = 0;
  let rejected = 0;
  let fetching = false;

  // Rolling prefetch buffer: fill toward TARGET, top up below LOW.
  const BUFFER_TARGET = 50;
  const BUFFER_LOW = 25;
  const BUFFER_FETCH = 10;
  const FIRST_BATCH = 6;

  function setStatus(text: string): void {
    status.textContent = text;
  }

  function paintCount(): void {
    const parts = [`✓ ${accepted}`, `✗ ${rejected}`];
    if (queue.length > 0) parts.push(`${queue.length}/${BUFFER_TARGET} queued`);
    count.textContent = parts.join(" · ");
  }

  function paint(): void {
    const has = current !== null;
    acceptBtn.disabled = !has || busy;
    rejectBtn.disabled = !has || busy;
    if (!current) return;
    // Never clobber a fallback swap: only assign when the src belongs to
    // neither this card's primary nor its fallback URL.
    const src = img.getAttribute("src");
    if (src !== current.image && src !== current.fallbackImage) {
      img.setAttribute("src", current.image);
    }
    if (paintedId !== current.id) {
      paintedId = current.id;
      img.dataset["fallbackTried"] = "";
    }
    img.alt = current.title;
    title.textContent = current.title;
    meta.textContent = `${current.year} · ${current.lat.toFixed(2)}°, ${current.lon.toFixed(2)}°`;
    setBlurb(current.blurb);
    source.setAttribute("href", current.page);
    paintCount();
  }

  /** Blurbs arrive whole: collapse to 3 lines, expand on demand. The
   *  toggle only shows when the text actually overflows. */
  function setBlurb(text: string): void {
    blurb.textContent = text;
    blurb.classList.remove("is-expanded");
    blurbToggle.classList.add("hidden");
    blurbToggle.textContent = "more…";
    blurbToggle.setAttribute("aria-expanded", "false");
    window.requestAnimationFrame(() => {
      if (blurb.textContent !== text) return; // card moved on already
      if (blurb.scrollHeight > blurb.clientHeight + 2) {
        blurbToggle.classList.remove("hidden");
      }
    });
  }

  blurbToggle.addEventListener("click", () => {
    const expanded = blurb.classList.toggle("is-expanded");
    blurbToggle.textContent = expanded ? "less" : "more…";
    blurbToggle.setAttribute("aria-expanded", String(expanded));
  });

  function next(): void {
    current = queue.shift() ?? null;
    if (!current) {
      setStatus("Loading…");
      img.removeAttribute("src");
      title.textContent = "";
      meta.textContent = "";
      blurb.textContent = "";
      blurb.classList.remove("is-expanded");
      blurbToggle.classList.add("hidden");
      paintCount();
      void ensureBuffer();
      return;
    }
    setStatus("");
    paint();
    paintCount();
    void ensureBuffer();
  }

  async function ensureBuffer(first = false): Promise<void> {
    if (fetching) return;
    if (current && queue.length >= BUFFER_LOW) return;
    fetching = true;
    retryBtn.classList.add("hidden");
    let failed = false;
    let dryRounds = 0;
    try {
      while (queue.length < BUFFER_TARGET) {
        const amount = first ? FIRST_BATCH : Math.min(BUFFER_FETCH, BUFFER_TARGET - queue.length);
        first = false;
        let added = 0;
        try {
          const res = await fetchTinder("/tinder/next?limit=" + amount);
          const cards = Array.isArray((res as { cards?: TinderCard[] }).cards)
            ? (res as { cards?: TinderCard[] }).cards as TinderCard[]
            : [];
          const known = new Set(queue.map((c) => c.sourceImage));
          if (current) known.add(current.sourceImage);
          for (const c of cards) {
            if (!c.image || !c.pinId || known.has(c.sourceImage)) continue;
            known.add(c.sourceImage);
            queue.push(c);
            added++;
          }
        } catch {
          failed = true;
          break;
        }
        if (!current) next();
        else {
          paint();
          paintCount();
        }
        if (added === 0 && ++dryRounds >= 2) break;
        if (added > 0) dryRounds = 0;
        if (queue.length < BUFFER_TARGET) {
          await new Promise((r) => window.setTimeout(r, 400));
        }
      }
      if (queue.length === 0 && !current) {
        setStatus(failed ? "Lookup failed (Historypin busy?)." : "Still nothing fresh — Historypin is sparse here.");
        retryBtn.classList.remove("hidden");
      }
    } finally {
      fetching = false;
    }
  }

  async function vote(decision: "accepted" | "rejected"): Promise<void> {
    if (!current || busy) return;
    const card = current;
    busy = true;
    paint();
    try {
      await fetch(apiUrl("/tinder/vote"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pinId: card.pinId,
          image: card.sourceImage,
          // URL that actually rendered (primary or fallback): the server
          // keeps it so the dataset holds a known-good image.
          rendered: img.getAttribute("src") ?? card.sourceImage,
          decision,
        }),
      });
    } catch {
      // Vote is best-effort: the row is already marked seen server-side,
      // so the card will never resurface even if this POST fails.
    }
    if (decision === "accepted") accepted++;
    else rejected++;
    busy = false;
    next();
  }

  acceptBtn.addEventListener("click", () => void vote("accepted"));
  rejectBtn.addEventListener("click", () => void vote("rejected"));
  retryBtn.addEventListener("click", () => {
    setStatus("Loading…");
    void ensureBuffer();
  });

  // Fullscreen viewer: tap the picture, see it large. Overlay only —
  // voting state is untouched, any tap or Esc closes it again.
  function openLightbox(): void {
    if (!current) return;
    // Show what's actually rendered (primary or fallback swap), not the
    // raw card URL — the rendered one is proven to load.
    const src = img.getAttribute("src");
    if (!src) return;
    lightboxImg.setAttribute("src", src);
    lightboxImg.alt = current.title;
    lightbox.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    lightboxClose.focus();
  }
  function closeLightbox(): void {
    if (lightbox.classList.contains("hidden")) return;
    lightbox.classList.add("hidden");
    lightboxImg.removeAttribute("src");
    document.body.style.overflow = "";
    img.focus();
  }
  img.addEventListener("click", openLightbox);
  img.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openLightbox();
    }
  });
  lightboxClose.addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox || e.target === lightboxImg) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });

  img.addEventListener("error", () => {
    if (!current) return;
    // One second chance via the embedded original before giving up.
    if (current.fallbackImage && !img.dataset["fallbackTried"]) {
      img.dataset["fallbackTried"] = "1";
      img.setAttribute("src", current.fallbackImage);
      return;
    }
    setStatus("Image failed to load — reject to skip it.");
  });

  setStatus("Loading…");
  void ensureBuffer(true);
}
