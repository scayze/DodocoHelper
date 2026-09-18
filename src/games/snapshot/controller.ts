import type { GameInstance } from "../types.js";
import { formatClock, todayUTC } from "../../leaderboard/api.js";
import { announceResult, createRunTimer } from "../../leaderboard/report.js";
import { boardEvents, type BoardDetail } from "../../leaderboard/view.js";
import { settingsEvents, type SettingsDetail } from "../mode-shell.js";
import { isDailyComplete, saveDailyResult } from "../daily-result.js";
import { dailyCompleteMessage } from "../daily.js";
import { createModeShell, type ModeShell } from "../mode-shell.js";
import { loadBoardState, saveBoardState } from "../persist.js";
import { setEndlessUnlocked } from "../mode.js";
import { el } from "../dom.js";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  snapshotItems,
  pickDailyIndex,
  pickRandomIndex,
  haversineKm,
  locationScore,
  yearScore,
  totalScore,
  formatDistance,
} from "./data.js";
import { isSnapshotStored, type SnapshotStored } from "./stored.js";
import type { SnapshotItem } from "./types.js";

const YEAR_MIN = 1400;
const YEAR_MAX = 2025;
const YEAR_DEFAULT = 1900;

/** Esri Light Gray Canvas: minimal style with English labels, no key required.
 *  Two layers (base + transparent reference with labels). Canvas tops out at
 *  z16, so deeper zooms upscale (maxNativeZoom). Note Esri tile order is z/y/x. */
const TILE_BASE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const TILE_REF_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}";
const TILE_ATTR =
  "Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, " +
  "Esri Japan, METI, Esri China (Hong Kong), Esri Thailand, TomTom, 2012";

/** Stack base + label layers onto a map (attribution once, on the base). */
function addCanvasLayers(target: L.Map): void {
  L.tileLayer(TILE_BASE_URL, {
    attribution: TILE_ATTR,
    maxZoom: 19,
    maxNativeZoom: 16,
  }).addTo(target);
  L.tileLayer(TILE_REF_URL, { maxZoom: 19, maxNativeZoom: 16 }).addTo(target);
}

export function createSnapshotGame(): GameInstance {
  const root = el("snapshot");
  const grid = el("snapshot-grid");
  // Shared status line below the square, identical to every other minigame.
  const message = el<HTMLParagraphElement>("snapshot-message");
  const timerValue = el("snapshot-timer-value");
  const modeDailyBtn = el<HTMLButtonElement>("snapshot-mode-daily");
  const modeEndlessBtn = el<HTMLButtonElement>("snapshot-mode-endless");
  const modeSep = el("snapshot-mode-sep");
  const gridWrap = el("snapshot-grid-wrap");
  const settingsPanel = el("snapshot-settings");
  const settingsToggle = el<HTMLButtonElement>("snapshot-settings-toggle");
  const regenBtn = el<HTMLButtonElement>("snapshot-regen");
  const viewToggle = el<HTMLButtonElement>("snapshot-view-toggle");
  const lbView = el("snapshot-lb-view");

  const runTimer = createRunTimer();
  const endlessTimer = createRunTimer();

  interface Slot {
    stored: SnapshotStored;
    day: string | null;
    timerLive: boolean;
  }
  let daily: Slot | null = null;
  let endless: Slot | null = null;

  let item: SnapshotItem | null = null;
  let itemIndex = 0;
  let dailyDay: string | null = null;
  let started = false;
  /** Active in-square screen: photo first, guess (map + year) on demand,
   *  details (results card) after reveal. Details is transient (never persisted). */
  let view: "photo" | "when" | "where" | "results" = "photo";
  let guessLat: number | null = null;
  let guessLon: number | null = null;
  let guessYear = YEAR_DEFAULT;
  let revealed = false;
  /** Results tab; transient, sticky within the round, opens on result. */
  let resultsTab: "result" | "text" | "image" = "result";
  let distKm: number | null = null;
  let yearErr: number | null = null;
  let score: number | null = null;
  let resultReported = false;
  let dailyLocked = false;

  // ---- Build the in-stage UI (everything lives inside the game square) ----
  grid.className = "snapshot-root";
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", "Snapshot guessing game");

  // Picture screen: photo fills the square, take-guess button at its bottom.
  const screenPhoto = document.createElement("div");
  screenPhoto.className = "snap-screen-photo";
  const img = document.createElement("img");
  img.className = "snap-img";
  img.alt = "Mystery painting or photograph — guess where and when";
  img.draggable = false;
  img.referrerPolicy = "no-referrer";
  img.loading = "lazy";
  const photoActions = document.createElement("div");
  photoActions.className = "snap-photo-actions";
  const whenBtn = document.createElement("button");
  whenBtn.type = "button";
  whenBtn.className = "snap-photo-btn";
  whenBtn.textContent = "When?";
  const whereBtn = document.createElement("button");
  whereBtn.type = "button";
  whereBtn.className = "snap-photo-btn";
  whereBtn.textContent = "Where?";
  const photoGuessBtn = document.createElement("button");
  photoGuessBtn.type = "button";
  photoGuessBtn.className = "snap-photo-btn snap-photo-btn-primary";
  photoGuessBtn.textContent = "Guess";
  photoActions.append(whenBtn, whereBtn, photoGuessBtn);
  screenPhoto.append(img, photoActions);

  // Guess screen: map, then year slider, then Back + Guess buttons.
  const screenGuess = document.createElement("div");
  screenGuess.className = "snap-screen-guess hidden";
  const mapView = document.createElement("div");
  mapView.className = "snap-map";
  const osmEl = document.createElement("div");
  osmEl.className = "snap-osm";
  osmEl.tabIndex = 0;
  osmEl.setAttribute("role", "application");
  osmEl.setAttribute("aria-label", "World map. Click to place your location guess.");

  const mapHint = document.createElement("p");
  mapHint.className = "snap-map-hint";
  mapView.append(osmEl, mapHint);

  const yearRow = document.createElement("div");
  yearRow.className = "snap-year";
  const yearLabel = document.createElement("label");
  yearLabel.className = "snap-year-label";
  yearLabel.setAttribute("for", "snapshot-year-range");
  yearLabel.textContent = "Year";
  const yearControls = document.createElement("div");
  yearControls.className = "snap-year-controls";
  const yearRange = document.createElement("input");
  yearRange.type = "range";
  yearRange.id = "snapshot-year-range";
  yearRange.min = String(YEAR_MIN);
  yearRange.max = String(YEAR_MAX);
  yearRange.step = "1";
  yearRange.value = String(YEAR_DEFAULT);
  yearRange.setAttribute("aria-label", "Guessed year");
  const yearNum = document.createElement("input");
  yearNum.type = "number";
  yearNum.id = "snapshot-year-num";
  yearNum.min = String(YEAR_MIN);
  yearNum.max = String(YEAR_MAX);
  yearNum.step = "1";
  yearNum.value = String(YEAR_DEFAULT);
  yearNum.inputMode = "numeric";
  yearNum.setAttribute("aria-label", "Guessed year (number)");
  yearControls.append(yearRange, yearNum);
  yearRow.append(yearLabel, yearControls);

  const whereConfirmBtn = document.createElement("button");
  whereConfirmBtn.type = "button";
  whereConfirmBtn.className = "snap-guess-btn";
  whereConfirmBtn.textContent = "Confirm";
  screenGuess.append(mapView, whereConfirmBtn);

  // When screen: year slider only, plus Confirm back to the picture.
  const screenWhen = document.createElement("div");
  screenWhen.className = "snap-screen-when hidden";
  const whenConfirmBtn = document.createElement("button");
  whenConfirmBtn.type = "button";
  whenConfirmBtn.className = "snap-guess-btn";
  whenConfirmBtn.textContent = "Confirm";
  screenWhen.append(yearRow, whenConfirmBtn);

  // Details screen: full results card shown after reveal (replaces the banner).
  // Results screen: Result (map) + Text + Image tabs sharing one square.
  const screenResults = document.createElement("div");
  screenResults.className = "snap-screen-results hidden";
  const resultsToggle = document.createElement("div");
  resultsToggle.className = "snap-results-toggle";
  resultsToggle.setAttribute("role", "group");
  resultsToggle.setAttribute("aria-label", "Switch between result, details and image");
  const resultsResultBtn = document.createElement("button");
  resultsResultBtn.type = "button";
  resultsResultBtn.className = "snap-results-toggle-btn is-active";
  resultsResultBtn.textContent = "Result";
  resultsResultBtn.setAttribute("aria-pressed", "true");
  const resultsTextBtn = document.createElement("button");
  resultsTextBtn.type = "button";
  resultsTextBtn.className = "snap-results-toggle-btn";
  resultsTextBtn.textContent = "Details";
  resultsTextBtn.setAttribute("aria-pressed", "false");
  const resultsImgBtn = document.createElement("button");
  resultsImgBtn.type = "button";
  resultsImgBtn.className = "snap-results-toggle-btn";
  resultsImgBtn.textContent = "Image";
  resultsImgBtn.setAttribute("aria-pressed", "false");
  resultsToggle.append(resultsResultBtn, resultsTextBtn, resultsImgBtn);
  const resultPane = document.createElement("div");
  resultPane.className = "snap-result-pane";
  const resultOsmEl = document.createElement("div");
  resultOsmEl.className = "snap-osm";
  resultOsmEl.setAttribute("role", "application");
  resultOsmEl.setAttribute("aria-label", "Result map: your guess and the answer.");
  const resultHint = document.createElement("p");
  resultHint.className = "snap-map-hint";
  resultPane.append(resultOsmEl, resultHint);
  const detailsText = document.createElement("div");
  detailsText.className = "snap-details-text";
  const detailsTitle = document.createElement("p");
  detailsTitle.className = "snap-details-title";
  const detailsAnswer = document.createElement("p");
  detailsAnswer.className = "snap-details-answer";
  const detailsGuess = document.createElement("p");
  detailsGuess.className = "snap-details-meta";
  const detailsScore = document.createElement("p");
  detailsScore.className = "snap-details-meta";
  const detailsLink = document.createElement("a");
  detailsLink.className = "snap-details-link";
  detailsLink.target = "_blank";
  detailsLink.rel = "noopener noreferrer";
  detailsLink.textContent = "View source on Commons ↗";
  const detailsLicense = document.createElement("p");
  detailsLicense.className = "snap-details-license";
  const detailsDaily = document.createElement("p");
  detailsDaily.className = "snap-details-daily";
  detailsText.append(
    detailsTitle,
    detailsAnswer,
    detailsGuess,
    detailsScore,
    detailsLink,
    detailsLicense,
    detailsDaily,
  );
  const detailsImageWrap = document.createElement("div");
  detailsImageWrap.className = "snap-details-image hidden";
  const detailsImg = document.createElement("img");
  detailsImg.className = "snap-details-img";
  detailsImg.draggable = false;
  detailsImg.referrerPolicy = "no-referrer";
  detailsImg.loading = "lazy";
  const detailsCaption = document.createElement("p");
  detailsCaption.className = "snap-details-caption";
  detailsImageWrap.append(detailsImg, detailsCaption);
  screenResults.append(resultsToggle, resultPane, detailsText, detailsImageWrap);

  grid.append(screenPhoto, screenWhen, screenGuess, screenResults);

  // ---- Persistence restore ----
  {
    const today = todayUTC();
    const sd = loadBoardState<SnapshotStored>("snapshot", "daily", isSnapshotStored, today);
    if (sd) {
      daily = { stored: sd.state, day: today, timerLive: sd.timerLive };
      runTimer.restoreElapsed(sd.elapsedMs);
    }
    const se = loadBoardState<SnapshotStored>("snapshot", "endless", isSnapshotStored, today);
    if (se) {
      endless = { stored: se.state, day: null, timerLive: se.timerLive };
      endlessTimer.restoreElapsed(se.elapsedMs);
    }
  }

  function snapshot(): Slot | null {
    if (!started || !item) return null;
    const stored: SnapshotStored = {
      itemId: item.id,
      itemIndex,
      guessLat,
      guessLon,
      guessYear,
      // Details is transient: persisted as the guess screen.
      view,
      revealed,
      distKm,
      yearErr,
      score,
      resultReported,
    };
    return { stored, day: dailyDay, timerLive: true };
  }

  const modeShell: ModeShell = createModeShell<Slot>({
    id: "snapshot",
    elements: {
      modeDaily: modeDailyBtn,
      modeEndless: modeEndlessBtn,
      modeSeparator: modeSep,
      settings: settingsPanel,
      settingsToggle,
      regenerate: regenBtn,
      viewToggle,
      leaderboardView: lbView,
      gridWrap,
      timerValue: "snapshot-timer-value",
    },
    dailyTimer: runTimer,
    endlessTimer,
    getSlot: (m) => (m === "daily" ? daily : endless),
    setSlot: (m, slot) => {
      if (m === "daily") daily = slot;
      else endless = slot;
      persistActive();
    },
    snapshot,
    restoreSlot: activateSlot,
    dealDaily,
    dealEndless,
    onEmptyDaily: () => {
      started = false;
      item = null;
      paint();
      setStatus("Loading today's photo…");
      modeShell.ensureDaily();
    },
    hasDaily: (day) => daily?.day === day,
    canResume: () => started && item !== null && !revealed,
  });

  function setStatus(text: string): void {
    message.textContent = text;
  }

  function freezeClock(): void {
    modeShell.activeTimer().stop();
    timerValue.textContent = formatClock(modeShell.activeTimer().elapsed());
  }

  const pauseClock = modeShell.pauseClock;
  const resumeClock = modeShell.resumeClock;

  function onBoardToggle(detail: BoardDetail): void {
    if (detail.game !== "snapshot") return;
    if (detail.showingBoard) pauseClock();
    else if (settingsPanel.classList.contains("hidden")) resumeClock();
  }

  function onSettingsToggle(detail: SettingsDetail): void {
    if (detail.game !== "snapshot") return;
    if (detail.settingsOpen) pauseClock();
    else if (lbView.classList.contains("hidden")) resumeClock();
  }

  function items(): SnapshotItem[] {
    return snapshotItems();
  }

  function paintScreens(): void {
    screenPhoto.classList.toggle("hidden", view !== "photo");
    screenWhen.classList.toggle("hidden", view !== "when");
    screenGuess.classList.toggle("hidden", view !== "where");
    screenResults.classList.toggle("hidden", view !== "results");
  }

  let resultMap: L.Map | null = null;
  let resultGuessMarker: L.Marker | null = null;
  let resultTrueMarker: L.Marker | null = null;
  let resultLinkLine: L.Polyline | null = null;

  /** Lazily create the result map when its tab becomes visible. */
  function ensureResultMap(): void {
    if (resultMap) {
      resultMap.invalidateSize();
      return;
    }
    resultMap = L.map(resultOsmEl, {
      center: [20, 10],
      zoom: 2,
      minZoom: 2,
      maxZoom: 19,
      keyboard: false,
      worldCopyJump: true,
    });
    addCanvasLayers(resultMap);
    syncResultMarkers();
  }

  function syncResultMarkers(): void {
    if (!resultMap) return;
    const hasGuess = guessLat !== null && guessLon !== null;
    if (hasGuess && item !== null) {
      if (!resultGuessMarker) {
        resultGuessMarker = L.marker([guessLat!, guessLon!], {
          icon: pinIcon("guess"),
          keyboard: false,
          interactive: false,
        }).addTo(resultMap);
      } else {
        resultGuessMarker.setLatLng([guessLat!, guessLon!]);
      }
      if (!resultTrueMarker) {
        resultTrueMarker = L.marker([item.lat, item.lon], {
          icon: pinIcon("true"),
          keyboard: false,
          interactive: false,
        }).addTo(resultMap);
      } else {
        resultTrueMarker.setLatLng([item.lat, item.lon]);
      }
      const ends: L.LatLngExpression[] = [
        [guessLat!, guessLon!],
        [item.lat, item.lon],
      ];
      if (!resultLinkLine) {
        resultLinkLine = L.polyline(ends, {
          color: "#b3261e",
          weight: 2,
          dashArray: "6 6",
        }).addTo(resultMap);
      } else {
        resultLinkLine.setLatLngs(ends);
      }
    }
  }

  function fitResultBounds(): void {
    if (!resultMap || !item || guessLat === null || guessLon === null) return;
    resultMap.fitBounds(
      L.latLngBounds([
        [guessLat, guessLon],
        [item.lat, item.lon],
      ]).pad(0.3),
    );
  }

  function paintResultTab(): void {
    resultsResultBtn.classList.toggle("is-active", resultsTab === "result");
    resultsTextBtn.classList.toggle("is-active", resultsTab === "text");
    resultsImgBtn.classList.toggle("is-active", resultsTab === "image");
    resultsResultBtn.setAttribute("aria-pressed", String(resultsTab === "result"));
    resultsTextBtn.setAttribute("aria-pressed", String(resultsTab === "text"));
    resultsImgBtn.setAttribute("aria-pressed", String(resultsTab === "image"));
    resultPane.classList.toggle("hidden", resultsTab !== "result");
    detailsText.classList.toggle("hidden", resultsTab !== "text");
    detailsImageWrap.classList.toggle("hidden", resultsTab !== "image");
    resultHint.textContent = revealed ? answerStatus() : "";
  }

  let map: L.Map | null = null;
  let guessMarker: L.Marker | null = null;
  let trueMarker: L.Marker | null = null;
  let linkLine: L.Polyline | null = null;

  function pinIcon(kind: "guess" | "true"): L.DivIcon {
    return L.divIcon({
      className: "",
      html: '<span class="snap-pin snap-pin-' + kind + '"></span>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
  }

  /** Lazily create the Leaflet map on first entering the guess screen.
   *  Must only run while the screen is visible (hidden => zero size). */
  function ensureMap(): void {
    if (map) {
      map.invalidateSize();
      return;
    }
    map = L.map(osmEl, {
      center: [20, 10],
      zoom: 2,
      minZoom: 2,
      maxZoom: 19,
      keyboard: false,
      worldCopyJump: true,
    });
    addCanvasLayers(map);
    map.on("click", (e: L.LeafletMouseEvent) => setGuess(e.latlng.lat, e.latlng.lng));
    syncMarkers();
  }

  /** Mirror guess/answer state onto Leaflet markers + dashed link line. */
  function syncMarkers(): void {
    if (!map) return;
    const hasGuess = guessLat !== null && guessLon !== null;
    if (hasGuess) {
      if (!guessMarker) {
        guessMarker = L.marker([guessLat!, guessLon!], {
          icon: pinIcon("guess"),
          draggable: !revealed,
          keyboard: false,
        }).addTo(map);
        guessMarker.on("dragend", () => {
          const at = guessMarker!.getLatLng();
          setGuess(at.lat, at.lng);
        });
      } else {
        guessMarker.setLatLng([guessLat!, guessLon!]);
        if (guessMarker.dragging) {
          if (revealed) guessMarker.dragging.disable();
          else guessMarker.dragging.enable();
        }
      }
    } else if (guessMarker) {
      guessMarker.remove();
      guessMarker = null;
    }
    const showTrue = revealed && item !== null;
    if (showTrue) {
      if (!trueMarker) {
        trueMarker = L.marker([item!.lat, item!.lon], {
          icon: pinIcon("true"),
          keyboard: false,
        }).addTo(map);
      } else {
        trueMarker.setLatLng([item!.lat, item!.lon]);
      }
      const ends: L.LatLngExpression[] = hasGuess
        ? [[guessLat!, guessLon!], [item!.lat, item!.lon]]
        : [];
      if (!linkLine) {
        linkLine = L.polyline(ends, { color: "#b3261e", weight: 2, dashArray: "6 6" }).addTo(map);
      } else {
        linkLine.setLatLngs(ends);
      }
    } else {
      if (trueMarker) {
        trueMarker.remove();
        trueMarker = null;
      }
      if (linkLine) {
        linkLine.remove();
        linkLine = null;
      }
    }
  }

  function paintMap(): void {
    syncMarkers();
    const hasGuess = guessLat !== null && guessLon !== null;
    if (!revealed) {
      mapHint.textContent =
        hasGuess && guessLat !== null && guessLon !== null
          ? "Pin: " + guessLat.toFixed(1) + "°, " + guessLon.toFixed(1) + "° — tap to move it"
          : "Tap the map to place your pin";
    } else {
      mapHint.textContent = answerStatus();
    }
  }
  /** Trusted pin glyph for the Location button (static markup, no user data). */
  const PIN_SVG =
    '<svg class="snap-pin-mini" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>' +
    '<circle cx="12" cy="10" r="3"/></svg>';

  /** Trusted clock glyph for the When button (static markup, no user data). */
  const TIME_SVG =
    '<svg class="snap-clock-mini" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="10"/>' +
    '<polyline points="12 6 12 12 16 14"/></svg>';

  /** Live state on the photo nav buttons: labels stay When/Where until a
   *  guess exists, then show the guessed year / pin icon + coords. */
  function paintPhotoButtons(): void {
    const yearSet = guessYear !== YEAR_DEFAULT;
    whenBtn.classList.toggle("has-year", yearSet);
    if (yearSet) {
      whenBtn.innerHTML = TIME_SVG + "<span>" + guessYear + "</span>";
    } else {
      whenBtn.textContent = "When?";
    }
    whenBtn.setAttribute(
      "aria-label",
      yearSet ? "Year guess " + guessYear + ", tap to change" : "Choose a year",
    );
    const hasPin = guessLat !== null && guessLon !== null;
    whereBtn.classList.toggle("has-pin", hasPin);
    if (hasPin) {
      whereBtn.innerHTML =
        PIN_SVG +
        "<span>" +
        guessLat!.toFixed(1) +
        "°, " +
        guessLon!.toFixed(1) +
        "°</span>";
    } else {
      whereBtn.textContent = "Where?";
    }
    whereBtn.setAttribute(
      "aria-label",
      hasPin ? "Location guess set, tap to change" : "Choose a location",
    );
  }

  /** Exact post-guess answer line: `Answer: London, 1982 | Score: 86`. */
  function answerStatus(): string {
    if (!item || score === null) return "";
    return `Answer: ${item.placeName}, ${item.year} | Score: ${score}`;
  }

  function paintYear(): void {
    yearRange.value = String(guessYear);
    if (document.activeElement !== yearNum) yearNum.value = String(guessYear);
    const locked = revealed || !started || item === null;
    yearRange.disabled = locked;
    yearNum.disabled = locked;
  }

  function paint(): void {
    if (!item) {
      img.removeAttribute("src");
      grid.setAttribute("aria-label", "Snapshot: loading");
      photoActions.classList.add("hidden");
      paintScreens();
      paintPhotoButtons();
      paintMap();
      paintYear();
      photoGuessBtn.disabled = true;
      whereConfirmBtn.disabled = true;
      whenConfirmBtn.disabled = true;
      return;
    }
    if (img.getAttribute("src") !== item.image) {
      img.setAttribute("src", item.image);
    }
    img.alt = revealed
      ? `${item.title} — answer revealed`
      : "Mystery painting or photograph — guess where and when";
    grid.setAttribute(
      "aria-label",
      revealed ? `Snapshot answer: ${item.title}` : "Snapshot: guess where and when",
    );
    if (revealed && distKm !== null && yearErr !== null && score !== null) {
      const loc = locationScore(distKm);
      const yrs = yearScore(yearErr);
      detailsTitle.textContent = `${item.title} — ${item.creator}`;
      detailsAnswer.textContent = `Answer: ${item.placeName}, ${item.year}`;
      detailsGuess.textContent =
        `Your guess: ${formatDistance(distKm)} off · ${Math.abs(yearErr)} yr${Math.abs(yearErr) === 1 ? "" : "s"} off`;
      detailsScore.textContent = `Location ${loc}/50 · Year ${yrs}/50 · Total ${score}/100`;
      detailsLink.setAttribute("href", item.page);
      detailsLicense.textContent = item.license;
      detailsDaily.textContent = modeShell.mode === "daily" ? dailyCompleteMessage() : "";
      if (detailsImg.getAttribute("src") !== item.image) {
        detailsImg.setAttribute("src", item.image);
      }
      detailsImg.alt = `${item.title} — answer revealed`;
      detailsCaption.textContent = `${item.title} — ${item.placeName}, ${item.year}`;
      // The map hint bar carries the answer on the result screen; the shared
      // status line repeats it only on the photo screen (which has no hint bar).
      setStatus(view === "photo" ? answerStatus() : "");
    }
    paintScreens();
    paintResultTab();
    syncResultMarkers();
    paintMap();
    paintYear();
    const locked = dailyLocked && modeShell.mode === "daily";
    photoActions.classList.toggle("hidden", locked || !started);
    // Post-reveal the photo Guess button links to the results view instead.
    photoGuessBtn.textContent = revealed ? "Results →" : "Guess";
    paintPhotoButtons();
    whereConfirmBtn.disabled = !started || item === null;
    whenConfirmBtn.disabled = !started || item === null;
    whereConfirmBtn.textContent = "Confirm";
  }

  function setResultsTab(next: "result" | "text" | "image"): void {
    if (resultsTab === next) return;
    resultsTab = next;
    paintResultTab();
    if (next === "result") {
      ensureResultMap();
      requestAnimationFrame(() => resultMap?.invalidateSize());
      if (revealed) fitResultBounds();
    }
  }

  function setView(next: "photo" | "when" | "where" | "results"): void {
    if (view === next) return;
    view = next;
    paint();
    if (next === "where") {
      // Screen just unhidden: (re)measure so tiles fill the box.
      ensureMap();
      requestAnimationFrame(() => map?.invalidateSize());
    }
    if (next === "results" && resultsTab === "result") {
      ensureResultMap();
      requestAnimationFrame(() => resultMap?.invalidateSize());
    }
    persistActive();
  }

  function setYear(raw: unknown): void {
    const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
    if (typeof n !== "number" || !Number.isFinite(n)) return;
    guessYear = Math.min(YEAR_MAX, Math.max(YEAR_MIN, Math.round(n)));
    paintYear();
    persistActive();
  }

  function setGuess(lat: number, lon: number): void {
    if (revealed || !started || !item) return;
    if (dailyLocked && modeShell.mode === "daily") return;
    guessLat = Math.max(-85, Math.min(85, Math.round(lat * 10) / 10));
    guessLon = Math.max(-180, Math.min(180, Math.round(lon * 10) / 10));
    paintMap();
    paint();
    persistActive();
  }
  function nudgePin(dLon: number, dLat: number): void {
    if (revealed || !started || !item) return;
    if (dailyLocked && modeShell.mode === "daily") return;
    if (guessLat === null || guessLon === null) {
      guessLat = 20;
      guessLon = 10;
    } else {
      guessLon = Math.max(-180, Math.min(180, guessLon + dLon));
      guessLat = Math.max(-85, Math.min(85, guessLat + dLat));
    }
    paintMap();
    paint();
    persistActive();
  }

  function persistActive(): void {
    const slot = snapshot();
    if (!slot) return;
    saveBoardState("snapshot", modeShell.mode, {
      day: slot.day,
      elapsedMs: modeShell.activeTimer().elapsed(),
      timerLive: true,
      state: slot.stored,
    });
  }

  function dealItem(index: number, day: string | null): void {
    const list = items();
    if (list.length === 0) {
      setStatus("No photos available.");
      return;
    }
    const safe = ((index % list.length) + list.length) % list.length;
    item = list[safe]!;
    itemIndex = safe;
    dailyDay = day;
    started = true;
    view = "photo";
    guessLat = null;
    guessLon = null;
    guessYear = YEAR_DEFAULT;
    revealed = false;
    distKm = null;
    yearErr = null;
    score = null;
    resultReported = false;
    dailyLocked = false;
    resultsTab = "result";
    if (resultMap) {
      resultGuessMarker?.remove();
      resultGuessMarker = null;
      resultTrueMarker?.remove();
      resultTrueMarker = null;
      resultLinkLine?.remove();
      resultLinkLine = null;
      resultMap.setView([20, 10], 2);
    }
    if (map) {
      guessMarker?.remove();
      guessMarker = null;
      trueMarker?.remove();
      trueMarker = null;
      linkLine?.remove();
      linkLine = null;
      map.setView([20, 10], 2);
    }
  }

  function dealDaily(day: string, seed: number): void {
    const index = pickDailyIndex(seed);
    if (modeShell.mode !== "daily") {
      const list = items();
      const safe = list.length === 0 ? 0 : index % list.length;
      const it = list[safe];
      daily =
        it === undefined
          ? null
          : {
              stored: {
                itemId: it.id,
                itemIndex: safe,
                guessLat: null,
                guessLon: null,
                guessYear: YEAR_DEFAULT,
                view: "photo",
                revealed: false,
                distKm: null,
                yearErr: null,
                score: null,
                resultReported: false,
              },
              day,
              timerLive: false,
            };
      return;
    }
    dealItem(index, day);
    runTimer.start();
    if (typeof document !== "undefined" && document.hidden) runTimer.pause();
    modeShell.bindTimerPill();
    daily = snapshot();
    paint();
    setStatus("");
    refreshDailyLock();
    persistActive();
  }

  function dealEndless(): void {
    const list = items();
    if (list.length === 0) {
      setStatus("No photos available.");
      return;
    }
    let index = pickRandomIndex();
    // Avoid an immediate repeat of the current photo.
    if (list.length > 1 && item !== null) {
      for (let tries = 0; tries < 5 && index === itemIndex; tries++) {
        index = pickRandomIndex();
      }
    }
    dealItem(index, null);
    endlessTimer.start();
    if (typeof document !== "undefined" && document.hidden) endlessTimer.pause();
    modeShell.bindTimerPill();
    endless = snapshot();
    paint();
    setStatus("");
    persistActive();
  }

  function activateSlot(slot: Slot): void {
    const list = items();
    const s = slot.stored;
    const byIndex = list[s.itemIndex];
    const found =
      byIndex !== undefined && byIndex.id === s.itemId
        ? byIndex
        : list.find((it) => it.id === s.itemId) ?? byIndex ?? list[0];
    if (found === undefined) {
      setStatus("No photos available.");
      return;
    }
    item = found;
    itemIndex = list.indexOf(found);
    dailyDay = slot.day;
    started = true;
    view = s.view;
    guessLat = s.guessLat;
    guessLon = s.guessLon;
    guessYear = s.guessYear;
    revealed = s.revealed;
    distKm = s.distKm;
    yearErr = s.yearErr;
    score = s.score;
    resultReported = s.resultReported;
    dailyLocked = false;
    const timer = modeShell.activeTimer();
    modeShell.bindTimerPill();
    if (!slot.timerLive) {
      slot.timerLive = true;
      timer.start();
      if (typeof document !== "undefined" && document.hidden) timer.pause();
    } else if (!revealed) {
      timer.resume();
    }
    paint();
    if (!revealed) setStatus("");
    refreshDailyLock();
  }

  function refreshDailyLock(): void {
    dailyLocked =
      modeShell.mode === "daily" && dailyDay !== null && isDailyComplete("snapshot", dailyDay);
    if (dailyLocked) {
      resultReported = true;
      modeShell.activeTimer().stop();
      paint();
    }
  }

  function revealGuess(): void {
    if (!item || revealed || guessLat === null || guessLon === null) {
      if (guessLat === null || guessLon === null) {
        setStatus("Place your pin on the map first — tap a spot.");
        setView("where");
      }
      return;
    }
    if (dailyLocked && modeShell.mode === "daily") return;
    distKm = haversineKm(guessLat, guessLon, item.lat, item.lon);
    yearErr = guessYear - item.year;
    score = totalScore(distKm, yearErr);
    revealed = true;
    freezeClock();
    // The result lives on the results view: go there (paints + persists).
    setView("results");
    // Zoom out just enough to show both the guess and the answer.
    fitResultBounds();
    if (!resultReported) {
      resultReported = true;
      if (modeShell.mode === "daily" && dailyDay !== null) {
        setEndlessUnlocked("snapshot", todayUTC());
        const durationMs = runTimer.elapsed();
        announceResult({
          game: "snapshot",
          durationMs,
          moves: 1,
          score: score ?? 0,
          won: true,
        });
        saveDailyResult("snapshot", {
          day: dailyDay,
          won: true,
          score: score ?? 0,
          durationMs,
          moves: 1,
        });
        modeShell.paintMode();
      }
    }
    persistActive();
  }

  whenBtn.addEventListener("click", () => setView("when"));
  whereBtn.addEventListener("click", () => {
    if (revealed) {
      setResultsTab("result");
      setView("results");
    } else {
      setView("where");
    }
  });
  photoGuessBtn.addEventListener("click", () => {
    if (revealed) setView("results");
    else revealGuess();
  });
  whenConfirmBtn.addEventListener("click", () => setView("photo"));
  whereConfirmBtn.addEventListener("click", () => {
    if (guessLat === null || guessLon === null) {
      setStatus("Place your pin on the map first — tap a spot.");
      return;
    }
    setView("photo");
  });
  resultsResultBtn.addEventListener("click", () => setResultsTab("result"));
  resultsTextBtn.addEventListener("click", () => setResultsTab("text"));
  resultsImgBtn.addEventListener("click", () => setResultsTab("image"));
  yearRange.addEventListener("input", () => setYear(yearRange.value));
  yearNum.addEventListener("change", () => setYear(yearNum.value));

  osmEl.addEventListener("keydown", (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      nudgePin(-step, 0);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      nudgePin(step, 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      nudgePin(0, step);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      nudgePin(0, -step);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (guessLat === null) nudgePin(0, 0);
    }
  });
  img.addEventListener("error", () => {
    if (!item) return;
    setStatus("That photo failed to load — try the next one (↻ in endless).");
  });

  boardEvents.on(onBoardToggle);
  settingsEvents.on(onSettingsToggle);
  modeShell.attachListeners();

  return {
    id: "snapshot",
    mount(): void {
      root.classList.remove("hidden");
      document.getElementById("top")?.classList.add("has-result");
      if (modeShell.mode === "endless") {
        if (endless) {
          if (!item) activateSlot(endless);
          else {
            paint();
            if (!revealed) setStatus("");
            resumeClock();
          }
        } else {
          dealEndless();
        }
      } else if (!daily) {
        started = false;
        item = null;
        paint();
        setStatus("Loading today's photo…");
        modeShell.ensureDaily();
      } else if (daily.day !== todayUTC()) {
        modeShell.ensureDaily();
      } else if (!item) {
        activateSlot(daily);
      } else {
        paint();
        if (!revealed) setStatus("");
        refreshDailyLock();
        resumeClock();
      }
      if (view === "where") {
        // Restored onto the map screen: tiles need a re-measure after unhide.
        ensureMap();
        requestAnimationFrame(() => map?.invalidateSize());
      }
      if (view === "results" && resultsTab === "result") {
        ensureResultMap();
        requestAnimationFrame(() => resultMap?.invalidateSize());
      }
      modeShell.paintMode();
    },
    unmount(): void {
      pauseClock();
      root.classList.add("hidden");
    },
    pauseClock,
    resumeClock,
  };
}
