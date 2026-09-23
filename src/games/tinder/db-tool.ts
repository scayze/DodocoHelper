/** Tinder DB tool: tabular browser over pool + seen with revote.
 *
 * Table shows name/year/loc/status/src (rejected hidden by default).
 * Clicking a row loads the full card via /api/tinder/item and allows
 * adjusting the vote via /api/tinder/revote (accepted/rejected/pending).
 */
import { apiUrl } from "../../leaderboard/api.js";
import { el } from "../dom.js";
import { geoLabel } from "../geo-label.js";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface BrowseRow {
  qid: string;
  image: string;
  title: string;
  year: number;
  lat: number;
  lon: number;
  geoCountryCode?: string;
  placeName: string;
  page: string;
  thumb: string;
  source: string;
  status: "pending" | "accepted" | "rejected";
  decided_at: string | null;
}

interface DetailItem {
  qid: string;
  image: string;
  sourceImage: string;
  title: string;
  placeName: string;
  year: number;
  lat: number;
  lon: number;
  geoCity?: string;
  geoLocality?: string;
  geoSubdivision?: string;
  geoCountryName?: string;
  page: string;
  license: string;
  blurb: string;
  blurbSource: string;
  source: string;
  status: string;
  pinId: string;
}

const PAGE_SIZE = 50;

function srcLabel(source: string): string {
  if (source === "wikidata") return "wd";
  if (source === "historypin") return "hp";
  if (source === "wd" || source === "hp") return source;
  return "?";
}

/** Same keyless Esri canvas as the curator card (base + labels).
 *  Duplicated here to avoid coupling the two controllers. */
const DB_TILE_BASE =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const DB_TILE_REF =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}";
const DB_TILE_ATTR =
  '\u00a9 <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> &amp; contributors';

function srcName(source: string): string {
  if (source === "wikidata" || source === "wd") return "Wikidata";
  if (source === "historypin" || source === "hp") return "HistoryPin";
  return "Source";
}

export function initTinderDb(): void {
  const statusSel = el<HTMLSelectElement>("tinder-db-status");
  const sourceSel = el<HTMLSelectElement>("tinder-db-source");
  const countrySel = el<HTMLSelectElement>("tinder-db-country");
  const fromInput = el<HTMLInputElement>("tinder-db-from");
  const toInput = el<HTMLInputElement>("tinder-db-to");
  const qInput = el<HTMLInputElement>("tinder-db-q");
  const applyBtn = el<HTMLButtonElement>("tinder-db-apply");
  const count = el("tinder-db-count");
  const rowsEl = el("tinder-db-rows");
  const prevBtn = el<HTMLButtonElement>("tinder-db-prev");
  const nextBtn = el<HTMLButtonElement>("tinder-db-next");
  const pageInfo = el("tinder-db-page");
  const detail = el("tinder-db-detail");
  const listView = el("tinder-db-list");
  const tableWrap = el("tinder-db-table-wrap");
  const backBtn = el<HTMLButtonElement>("tinder-db-back");
  const mapEl = el("tinder-db-map");
  const dImg = el<HTMLImageElement>("tinder-db-img");
  const dTitle = el("tinder-db-title");
  const dMeta = el("tinder-db-meta");
  const dBlurb = el("tinder-db-blurb");
  const dBlurbToggle = el<HTMLButtonElement>("tinder-db-blurb-toggle");
  // Shared fullscreen viewer (same overlay the curator card uses).
  const dbLightbox = el("tinder-lightbox");
  const dbLightboxImg = el<HTMLImageElement>("tinder-lightbox-img");
  const dbLightboxClose = el<HTMLButtonElement>("tinder-lightbox-close");
  const dSource = el<HTMLAnchorElement>("tinder-db-source-link");
  let savedScroll = 0;

  function showDetail(): void {
    savedScroll = tableWrap.scrollTop;
    listView.classList.add("hidden");
    detail.classList.remove("hidden");
    backBtn.focus();
  }

  function showList(): void {
    detail.classList.add("hidden");
    listView.classList.remove("hidden");
    current = null;
    currentDetail = null;
    tableWrap.scrollTop = savedScroll;
  }
  const dVoteStatus = el("tinder-db-vote-status");
  const dAccept = el<HTMLButtonElement>("tinder-db-accept");
  const dReject = el<HTMLButtonElement>("tinder-db-reject");

  let offset = 0;
  let total = 0;
  let current: { qid: string; image: string } | null = null;
  let currentDetail: DetailItem | null = null;
  let loading = false;

  let dbMap: L.Map | null = null;
  let dbMarker: L.Marker | null = null;
  let showingDbMap = false;

  /** Lazily create the Leaflet map on first toggle. Must only run while
   *  the map box is visible (hidden => zero size). */
  function ensureDbMap(): void {
    if (dbMap) {
      dbMap.invalidateSize();
      return;
    }
    dbMap = L.map(mapEl, { zoomControl: true });
    dbMap.attributionControl.setPrefix(false);
    L.tileLayer(DB_TILE_BASE, {
      attribution: DB_TILE_ATTR,
      maxZoom: 19,
      maxNativeZoom: 16,
    }).addTo(dbMap);
    L.tileLayer(DB_TILE_REF, { maxZoom: 19, maxNativeZoom: 16 }).addTo(dbMap);
    dbMarker = L.marker([0, 0], {
      icon: L.divIcon({
        className: "",
        html: '<span class="tinder-pin"></span>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
    }).addTo(dbMap);
  }

  function setDbMapShown(show: boolean): void {
    if (!current && show) return;
    showingDbMap = show;
    dImg.classList.toggle("hidden", show);
    mapEl.classList.toggle("hidden", !show);
    dMeta.setAttribute("aria-pressed", String(show));
    dMeta.setAttribute("aria-label", show ? "Show photo" : "Show map");
    if (show && currentDetail) {
      ensureDbMap();
      dbMap!.setView([currentDetail.lat, currentDetail.lon], 5);
      dbMarker!.setLatLng([currentDetail.lat, currentDetail.lon]);
    }
  }

  function filters(): string {
    const p = new URLSearchParams();
    p.set("status", statusSel.value || "not-rejected");
    const src = sourceSel.value || "all";
    if (src !== "all") p.set("source", src);
    const country = (countrySel.value || "all").toUpperCase();
    if (country !== "ALL" && country !== "") p.set("country", country);
    if (fromInput.value.trim() !== "") p.set("from", fromInput.value.trim());
    if (toInput.value.trim() !== "") p.set("to", toInput.value.trim());
    if (qInput.value.trim() !== "") p.set("q", qInput.value.trim());
    p.set("sort", "year");
    p.set("order", "asc");
    p.set("limit", String(PAGE_SIZE));
    p.set("offset", String(offset));
    return p.toString();
  }

  function paintPager(): void {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    pageInfo.textContent = total === 0 ? "0" : `Page ${page}/${pages} · ${total} entries`;
    prevBtn.disabled = offset <= 0 || loading;
    nextBtn.disabled = offset + PAGE_SIZE >= total || loading;
  }

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    count.textContent = "Loading…";
    paintPager();
    try {
      const res = await fetch(apiUrl(`/tinder/browse?${filters()}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { rows?: BrowseRow[]; total?: number };
      const rows = Array.isArray(body.rows) ? body.rows : [];
      total = typeof body.total === "number" ? body.total : rows.length;
      count.textContent = total === 0 ? "No entries match." : `${total} entries`;
      rowsEl.textContent = "";
      for (const r of rows) {
        const tr = document.createElement("tr");
        tr.className = "tinder-db-row";
        tr.tabIndex = 0;
        tr.dataset["qid"] = r.qid;
        tr.dataset["image"] = r.image;
        const name = document.createElement("td");
        name.className = "tinder-db-name";
        name.textContent = r.title || "(untitled)";
        name.title = r.title;
        const year = document.createElement("td");
        year.textContent = String(r.year);
        const loc = document.createElement("td");
        // Country code for enriched rows, coords fallback (pending pool rows).
        const coords = `${Number(r.lat).toFixed(1)}°, ${Number(r.lon).toFixed(1)}°`;
        loc.textContent = r.geoCountryCode || coords;
        loc.title = r.geoCountryCode ? `${r.geoCountryCode} · ${coords}` : coords;
        const st = document.createElement("td");
        const badge = document.createElement("span");
        badge.className = `tinder-db-badge is-${r.status}`;
        badge.textContent = r.status;
        st.appendChild(badge);
        const src = document.createElement("td");
        src.textContent = srcLabel(r.source);
        tr.append(name, year, loc, st, src);
        tr.addEventListener("click", () => void openDetail(r.qid, r.image));
        tr.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void openDetail(r.qid, r.image);
          }
        });
        rowsEl.appendChild(tr);
      }
    } catch {
      count.textContent = "Lookup failed — retry.";
    } finally {
      loading = false;
      paintPager();
    }
  }

  async function openDetail(qid: string, image: string): Promise<void> {
    current = { qid, image };
    currentDetail = null;
    showDetail();
    // New card always starts on the photo, never the map.
    setDbMapShown(false);
    dVoteStatus.textContent = "Loading…";
    dImg.removeAttribute("src");
    dTitle.textContent = "";
    dMeta.textContent = "";
    dBlurb.textContent = "";
    dBlurb.classList.remove("is-expanded");
    dBlurbToggle.classList.add("hidden");
    dBlurbToggle.textContent = "more…";
    dBlurbToggle.setAttribute("aria-expanded", "false");
    try {
      const res = await fetch(
        apiUrl(`/tinder/item?qid=${encodeURIComponent(qid)}&image=${encodeURIComponent(image)}`),
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { item?: DetailItem };
      const it = body.item;
      if (!it || !current || current.qid !== qid) return;
      currentDetail = it;
      paintDetail(it);
      dVoteStatus.textContent = "";
    } catch {
      dVoteStatus.textContent = "Failed to load details.";
    }
  }

  /** Blurbs arrive whole: collapse to 3 lines, expand on demand. The
   *  toggle only shows when the text actually overflows. */
  function setDbBlurb(text: string): void {
    dBlurb.textContent = text;
    dBlurb.classList.remove("is-expanded");
    dBlurbToggle.classList.add("hidden");
    dBlurbToggle.textContent = "more…";
    dBlurbToggle.setAttribute("aria-expanded", "false");
    window.requestAnimationFrame(() => {
      if (dBlurb.textContent !== text) return; // detail moved on already
      if (dBlurb.scrollHeight > dBlurb.clientHeight + 2) {
        dBlurbToggle.classList.remove("hidden");
      }
    });
  }

  dBlurbToggle.addEventListener("click", () => {
    const expanded = dBlurb.classList.toggle("is-expanded");
    dBlurbToggle.textContent = expanded ? "less" : "more…";
    dBlurbToggle.setAttribute("aria-expanded", String(expanded));
  });

  // Fullscreen viewer on the detail photo, reusing the curator overlay.
  // Open only — the curator's close/backdrop/Esc handlers do the rest.
  // The opener id steers focus back to this photo on close.
  function openDbLightbox(): void {
    if (!currentDetail) return;
    const src = dImg.getAttribute("src");
    if (!src) return;
    dbLightboxImg.setAttribute("src", src);
    dbLightboxImg.alt = currentDetail.title;
    dbLightbox.dataset["openerId"] = "tinder-db-img";
    dbLightbox.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    dbLightboxClose.focus();
  }
  dImg.addEventListener("click", openDbLightbox);
  dImg.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDbLightbox();
    }
  });

  function paintDetail(it: DetailItem): void {
    dImg.setAttribute("src", it.image);
    dImg.alt = it.title;
    dTitle.textContent = it.title;
    dMeta.textContent = `${it.year} · ${geoLabel(it) || `${Number(it.lat).toFixed(2)}°, ${Number(it.lon).toFixed(2)}°`}`;
    setDbBlurb(it.blurb || it.placeName || "");
    dSource.setAttribute("href", it.page || "#");
    dSource.textContent = `${srcName(it.source)} ↗`;
    // Keep the map pin in sync when repainting (e.g. after a revote).
    if (showingDbMap) setDbMapShown(true);
    // Toggle semantics: the active decision stays pressed; tapping it again
    // clears the vote back to pending (replaces the old Reset button).
    const accepted = it.status === "accepted";
    const rejected = it.status === "rejected";
    dAccept.disabled = false;
    dReject.disabled = false;
    dAccept.setAttribute("aria-pressed", String(accepted));
    dReject.setAttribute("aria-pressed", String(rejected));
    dAccept.classList.toggle("is-active", accepted);
    dReject.classList.toggle("is-active", rejected);
  }

  async function revote(decision: "accepted" | "rejected" | "pending"): Promise<void> {
    if (!current) return;
    dAccept.disabled = true;
    dReject.disabled = true;
    try {
      const res = await fetch(apiUrl("/tinder/revote"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          qid: current.qid,
          image: current.image,
          rendered: dImg.getAttribute("src") ?? current.image,
          decision,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (!res.ok || !body.ok) throw new Error("revote failed");
      if (currentDetail) {
        currentDetail = { ...currentDetail, status: decision };
        paintDetail(currentDetail);
      }
      void load();
    } catch {
      dVoteStatus.textContent = "Save failed — retry.";
      if (currentDetail) paintDetail(currentDetail);
    }
  }

  applyBtn.addEventListener("click", () => {
    offset = 0;
    void load();
  });
  // Country options come from decided rows (codes + counts); the
  // static "All" option stays first. Failure keeps just "All".
  void fetch(apiUrl("/tinder/countries"))
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      const list = (body as { countries?: Array<{ code: string; n: number }> } | null)?.countries;
      if (!Array.isArray(list)) return;
      for (const c of list) {
        if (typeof c.code !== "string" || !/^[A-Z]{2}$/.test(c.code)) continue;
        const opt = document.createElement("option");
        opt.value = c.code;
        opt.textContent = typeof c.n === "number" ? `${c.code} (${c.n})` : c.code;
        countrySel.appendChild(opt);
      }
    })
    .catch(() => {});
  qInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      offset = 0;
      void load();
    }
  });
  prevBtn.addEventListener("click", () => {
    offset = Math.max(0, offset - PAGE_SIZE);
    void load();
  });
  nextBtn.addEventListener("click", () => {
    offset += PAGE_SIZE;
    void load();
  });
  backBtn.addEventListener("click", () => {
    showList();
  });
  dAccept.addEventListener("click", () => void revote(currentDetail?.status === "accepted" ? "pending" : "accepted"));
  dReject.addEventListener("click", () => void revote(currentDetail?.status === "rejected" ? "pending" : "rejected"));

  // The coordinates line doubles as the map toggle (click or Enter/Space),
  // mirroring the curator card.
  dMeta.classList.add("tinder-meta-toggle");
  dMeta.setAttribute("role", "button");
  dMeta.tabIndex = 0;
  dMeta.setAttribute("aria-pressed", "false");
  dMeta.setAttribute("aria-label", "Show map");
  dMeta.addEventListener("click", () => setDbMapShown(!showingDbMap));
  dMeta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setDbMapShown(!showingDbMap);
    }
  });

  void load();
}
