/** Tinder curator: one card, two buttons. No timer, no leaderboard.
 *
 * Cards come from curated sources (Historypin photo pins or Wikidata items with time + location stamps).
 * Same SnapshotItem schema as the game; votes land in a separate dataset.
 */
import { apiUrl } from "../../leaderboard/api.js";
import { el } from "../dom.js";
import { initTinderDb } from "./db-tool.js";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/** Same keyless Esri canvas as the Snapshot minigame (base + labels).
 *  Duplicated here to avoid coupling the two controllers. */
const TINDER_TILE_BASE =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const TINDER_TILE_REF =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}";
const TINDER_TILE_ATTR =
  '\u00a9 <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> &amp; contributors';

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
  /** Winning date property (`P571`/`P585`/…/`depicted`, '' = unknown). */
  dateKind: string;
  /** English Wikipedia article title about the subject ('' = none). */
  article: string;
  /** Server-computed display tag for the year, e.g. ` (built)`. */
  dateTag: string;
  /** Server-computed tooltip explaining the tag. */
  dateHint: string;
}

/** Display name for the link to the entry's origin, derived from the
 *  namespaced source id (`hp:…` → HistoryPin, `wd:Q…` → Wikidata). */
function sourceName(pinId: string): string {
  if (pinId.startsWith("wd:")) return "Wikidata";
  if (pinId.startsWith("hp:")) return "HistoryPin";
  return "Source";
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
  const acceptBtn = el<HTMLButtonElement>("tinder-accept");
  const rejectBtn = el<HTMLButtonElement>("tinder-reject");
  const retryBtn = el<HTMLButtonElement>("tinder-retry");
  const source = el<HTMLAnchorElement>("tinder-source");
  const mapEl = el("tinder-map");
  const sourceFilter = el<HTMLSelectElement>("tinder-source-filter");

  // Card source filter: persisted, sent as ?source= on every fetch.
  // Switching clears the prefetch queue so the new source applies at once.
  let sourceSel = "all";
  try {
    sourceSel = window.localStorage.getItem("tinder-source") ?? "all";
  } catch {
    sourceSel = "all";
  }
  if (sourceSel !== "all" && sourceSel !== "hp" && sourceSel !== "wd") sourceSel = "all";
  sourceFilter.value = sourceSel;
  sourceFilter.addEventListener("change", () => {
    sourceSel = sourceFilter.value;
    try {
      window.localStorage.setItem("tinder-source", sourceSel);
    } catch {
      // Private mode etc: filtering still works for this session.
    }
    queue = [];
    current = null;
    next();
  });
  const lightbox = el("tinder-lightbox");
  // Host at body level: panel backdrop-filters would otherwise contain
  // the fixed overlay and clip it to the card.
  const lightboxImg = el<HTMLImageElement>("tinder-lightbox-img");
  const lightboxClose = el<HTMLButtonElement>("tinder-lightbox-close");
  document.body.appendChild(lightbox);

  // Curate / Database view toggle. DB boots lazily on first open.
  const viewCurateBtn = document.getElementById("tinder-view-curate") as HTMLButtonElement | null;
  const viewDbBtn = document.getElementById("tinder-view-db") as HTMLButtonElement | null;
  const card = document.getElementById("tinder-card");
  const dbView = document.getElementById("tinder-db");
  const curateFilter = document.getElementById("tinder-curate-filter");
  let dbReady = false;
  function setDbView(showDb: boolean): void {
    card?.classList.toggle("hidden", showDb);
    dbView?.classList.toggle("hidden", !showDb);
    curateFilter?.classList.toggle("hidden", showDb);
    // Curate filter row uses flex; hidden class alone leaves display from CSS.
    if (curateFilter) curateFilter.style.display = showDb ? "none" : "";
    viewCurateBtn?.setAttribute("aria-pressed", String(!showDb));
    viewDbBtn?.setAttribute("aria-pressed", String(showDb));
    if (viewCurateBtn && viewDbBtn) {
      viewCurateBtn.className = showDb
        ? "h-[32px] rounded-full border border-night-700/20 bg-white/70 px-[14px] text-[13px] font-bold text-night-900"
        : "h-[32px] rounded-full bg-gold-600 px-[14px] text-[13px] font-bold text-white";
      viewDbBtn.className = showDb
        ? "h-[32px] rounded-full bg-gold-600 px-[14px] text-[13px] font-bold text-white"
        : "h-[32px] rounded-full border border-night-700/20 bg-white/70 px-[14px] text-[13px] font-bold text-night-900";
    }
    if (showDb && !dbReady) {
      dbReady = true;
      try {
        initTinderDb();
      } catch {
        // DB tool is progressive enhancement; curate view keeps working.
      }
    }
  }
  viewCurateBtn?.addEventListener("click", () => setDbView(false));
  viewDbBtn?.addEventListener("click", () => setDbView(true));
  if (typeof location !== "undefined" && location.hash.includes("db")) setDbView(true);

  root.classList.remove("hidden");

  let queue: TinderCard[] = [];
  let current: TinderCard | null = null;
  let paintedId = "";
  let busy = false;
  let fetching = false;

  // Rolling prefetch buffer: fill toward TARGET, top up below LOW.
  // Small on purpose: warm fetches take ~10ms, so a deep buffer only
  // serves stale snapshots; this still bridges cold-harvest latency.
  const BUFFER_TARGET = 5;
  const BUFFER_LOW = 2;
  const BUFFER_FETCH = 3;
  const FIRST_BATCH = 3;

  function setStatus(text: string): void {
    status.textContent = text;
  }

  let tinderMap: L.Map | null = null;
  let tinderMarker: L.Marker | null = null;
  let showingMap = false;

  /** Lazily create the Leaflet map on first toggle. Must only run while
   *  the map box is visible (hidden => zero size). */
  function ensureTinderMap(): void {
    if (tinderMap) {
      tinderMap.invalidateSize();
      return;
    }
    tinderMap = L.map(mapEl, { zoomControl: true });
    tinderMap.attributionControl.setPrefix(false);
    L.tileLayer(TINDER_TILE_BASE, {
      attribution: TINDER_TILE_ATTR,
      maxZoom: 19,
      maxNativeZoom: 16,
    }).addTo(tinderMap);
    L.tileLayer(TINDER_TILE_REF, { maxZoom: 19, maxNativeZoom: 16 }).addTo(tinderMap);
    tinderMarker = L.marker([0, 0], {
      icon: L.divIcon({
        className: "",
        html: '<span class="tinder-pin"></span>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
    }).addTo(tinderMap);
  }

  function setMapShown(show: boolean): void {
    if (!current && show) return;
    showingMap = show;
    img.classList.toggle("hidden", show);
    mapEl.classList.toggle("hidden", !show);
    meta.setAttribute("aria-pressed", String(show));
    meta.setAttribute("aria-label", show ? "Show photo" : "Show map");
    if (show && current) {
      ensureTinderMap();
      tinderMap!.setView([current.lat, current.lon], 5);
      tinderMarker!.setLatLng([current.lat, current.lon]);
    }
  }

  // The coordinates line doubles as the map toggle (click or Enter/Space).
  // The date tooltip (title) is untouched; toggle state uses aria only.
  meta.classList.add("tinder-meta-toggle");
  meta.setAttribute("role", "button");
  meta.tabIndex = 0;
  meta.setAttribute("aria-pressed", "false");
  meta.setAttribute("aria-label", "Show map");
  meta.addEventListener("click", () => setMapShown(!showingMap));
  meta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setMapShown(!showingMap);
    }
  });

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
    // Date context (built/founded/photo date/…) is computed server-side
    // from the stored date kind + subject types.
    meta.textContent = `${current.year}${current.dateTag ?? ""} · ${current.lat.toFixed(2)}°, ${current.lon.toFixed(2)}°`;
    if (current.dateHint) meta.title = current.dateHint;
    else meta.removeAttribute("title");
    setBlurb(current.blurb);
    source.setAttribute("href", current.page);
    source.textContent = `${sourceName(current.pinId)} ↗`;
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
      setMapShown(false);
      img.removeAttribute("src");
      title.textContent = "";
      meta.textContent = "";
      blurb.textContent = "";
      blurb.classList.remove("is-expanded");
      blurbToggle.classList.add("hidden");
      void ensureBuffer();
      return;
    }
    setStatus("");
    // New card always starts on the photo, never the map.
    setMapShown(false);
    paint();
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
          const res = await fetchTinder(
            "/tinder/next?limit=" + amount + (sourceSel !== "all" ? "&source=" + sourceSel : ""),
          );
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
        else paint();
        if (added === 0 && ++dryRounds >= 2) break;
        if (added > 0) dryRounds = 0;
        if (queue.length < BUFFER_TARGET) {
          await new Promise((r) => window.setTimeout(r, 400));
        }
      }
      if (queue.length === 0 && !current) {
        setStatus(failed ? "Lookup failed (source busy?)." : "Still nothing fresh — sources are sparse here.");
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
    // Best-effort: the server records first-vote-wins, so a duplicate POST
    // after a reload is harmless (ignored, never double-counted).
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
      // Undecided cards stay servable server-side, so a failed POST can
      // simply be voted again on its next appearance.
    }
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
