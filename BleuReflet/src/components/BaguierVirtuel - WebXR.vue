<template>
  <div class="baguier-root">

    <div id="appcov" v-show="!isModalOpen">
      <button id="openModalButton" @click="openModal">Ouvrir l'Application</button>
    </div>

    <div id="modal" class="modal" :style="{ display: isModalOpen ? 'flex' : 'none' }">
      <div class="modal-content">
        <span class="close" @click="closeModal">&times;</span>
        <h1>Votre baguier virtuel (WebXR)</h1>

        <div id="initialMessage" v-show="showInitialMessage">
          WebXR nécessite un appareil compatible + HTTPS + geste utilisateur.
          Cliquez “Démarrer AR” puis cliquez 2 fois dans la zone pour choisir p1/p2.
        </div>

        <div id="videoContainer" ref="xrContainer" @click="onPickPoint">
          <!-- WebXR ne donne pas un <video>; on affiche un canvas WebGL pour l'AR -->
          <canvas ref="xrCanvas" id="xrCanvas"></canvas>

          <!-- Overlay points -->
          <div v-if="edgeL" class="pick-dot" :style="{ left: edgeL.uiX + 'px', top: edgeL.uiY + 'px' }"></div>
          <div v-if="edgeR" class="pick-dot" :style="{ left: edgeR.uiX + 'px', top: edgeR.uiY + 'px' }"></div>

          <div id="distanceCircle" :class="{ hidden: !distanceMessage }">
            <span id="distanceText">{{ distanceMessage }}</span>
          </div>

          <div id="resultCircle" :class="{ hidden: !resultDisplayed }">
            <span class="result-bubble">
              Diamètre: {{ snapDiameterMm?.toFixed?.(1) ?? "?" }} mm<br/>
              zC: {{ snapZC?.toFixed?.(3) ?? "?" }} m<br/>
              zL: {{ snapZL?.toFixed?.(3) ?? "?" }} m<br/>
              zR: {{ snapZR?.toFixed?.(3) ?? "?" }} m
            </span>

            <button
              id="newMeasurementButton"
              :class="{ hidden: !resultDisplayed }"
              @click="restart"
            >
              Nouvelle Mesure
            </button>
          </div>
        </div>

        <div style="display:flex; gap:8px; justify-content:center; margin-top:10px;">
          <button class="finger-button" @click="startAR" :disabled="isXRRunning">
            Démarrer AR
          </button>
          <button class="finger-button" @click="stopAR" :disabled="!isXRRunning">
            Stop AR
          </button>
        </div>

        <div id="fingerSelection">
          <button
            v-for="finger in fingers"
            :key="finger.key"
            class="finger-button"
            :class="{ selected: currentFinger === finger.key }"
            @click="onFingerButtonClick(finger.key)"
          >
            {{ finger.label }}
          </button>
        </div>

        <div style="margin-top:8px; font-size:12px; color:#444;">
          <div>WebXR: {{ isXRSupported ? "supporté" : "non supporté" }}</div>
          <div>Depth: {{ hasDepth ? "OK" : "pas dispo" }}</div>
          <div>Depth map: {{ depthW }}×{{ depthH }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from "vue";

/* =========================================================
   DEBUG (logs très explicites)
========================================================= */
const DBG = true;
const nowMs = () => Math.round(performance.now());
const log = (...a) => DBG && console.log(`[XR ${nowMs()}]`, ...a);
const warn = (...a) => DBG && console.warn(`[XR ${nowMs()}]`, ...a);
const err = (...a) => DBG && console.error(`[XR ${nowMs()}]`, ...a);

// Petit helper pour logs lisibles
const fmt = (v, d = 4) => (Number.isFinite(v) ? Number(v).toFixed(d) : String(v));
const briefPt = (p) =>
  p
    ? { uiX: +p.uiX.toFixed(1), uiY: +p.uiY.toFixed(1), nx: +p.nx.toFixed(4), ny: +p.ny.toFixed(4) }
    : null;

/* =========================================================
   LIVE (mise à jour en continu)
========================================================= */
const liveZC = ref(null);
const liveZL = ref(null);
const liveZR = ref(null);
const liveDiameterMm = ref(null);

/* =========================================================
   SNAP (valeurs figées -> affichées)
========================================================= */
const snapZC = ref(null);
const snapZL = ref(null);
const snapZR = ref(null);
const snapDiameterMm = ref(null);

/* =========================================================
   UI STATE
========================================================= */
const isModalOpen = ref(false);
const showInitialMessage = ref(true);
const distanceMessage = ref("");
const resultDisplayed = ref(false);

const currentFinger = ref("None");
const fingers = [
  { key: "thumb", label: "Pouce" },
  { key: "index", label: "Index" },
  { key: "middle", label: "Majeur" },
  { key: "ring", label: "Annulaire" },
  { key: "pinky", label: "Auriculaire" },
];

/* =========================================================
   XR REFS + FLAGS
========================================================= */
const xrCanvas = ref(null);
const xrContainer = ref(null);

const isXRSupported = ref(false);
const isXRRunning = ref(false);
const hasDepth = ref(false);
const hasHands = ref(false);

let xrSession = null;
let xrRefSpace = null;
let xrGl = null;

const depthW = ref(0);
const depthH = ref(0);
let lastDepthInfo = null;

/* =========================================================
   FREEZE + OVERLAY DOTS
========================================================= */
const frozen = ref(false);
let pendingFreeze = false;
let freezeRequestId = 0; // identifiant de requête freeze (debug)
let lastLiveUpdateId = 0; // identifiant de mise à jour live (debug)

// Dots overlay
const edgeL = ref(null);
const edgeR = ref(null);
const edgeC = ref(null);

/* =========================================================
   JOINTS (WebXR)
========================================================= */
const JOINTS = {
  thumb:  { mcp: "thumb-metacarpal", pip: "thumb-phalanx-proximal" },
  index:  { mcp: "index-finger-metacarpal", pip: "index-finger-phalanx-proximal" },
  middle: { mcp: "middle-finger-metacarpal", pip: "middle-finger-phalanx-proximal" },
  ring:   { mcp: "ring-finger-metacarpal", pip: "ring-finger-phalanx-proximal" },
  pinky:  { mcp: "pinky-finger-metacarpal", pip: "pinky-finger-phalanx-proximal" },
};

/* =========================================================
   LIFECYCLE
========================================================= */
onMounted(async () => {
  try {
    isXRSupported.value =
      !!navigator.xr && (await navigator.xr.isSessionSupported?.("immersive-ar"));
  } catch (e) {
    isXRSupported.value = false;
  }
  log("Mounted. XR supported =", isXRSupported.value);
});

onUnmounted(() => {
  stopAR();
});

/* =========================================================
   MODAL
========================================================= */
const openModal = () => {
  isModalOpen.value = true;
  showInitialMessage.value = true;
  resetAll("openModal");
  log("Modal opened");
};

const closeModal = () => {
  isModalOpen.value = false;
  stopAR();
  log("Modal closed");
};

/* =========================================================
   START / STOP XR
========================================================= */
const startAR = async () => {
  if (!navigator.xr) {
    distanceMessage.value = "WebXR indisponible sur ce navigateur.";
    warn("startAR blocked: navigator.xr missing");
    return;
  }

  log("startAR: requesting immersive-ar session with depth+hands");
  try {
    xrSession = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["local", "depth-sensing", "hand-tracking"],
      depthSensing: {
        usagePreference: ["cpu-optimized"],
        dataFormatPreference: ["luminance-alpha"],
      },
    });
  } catch (e) {
    err("requestSession failed", e);
    distanceMessage.value = "WebXR AR/Hands/Depth non supportés ici.";
    return;
  }

  try {
    xrGl = xrCanvas.value.getContext("webgl", { xrCompatible: true });
    await xrGl.makeXRCompatible();
    xrSession.updateRenderState({ baseLayer: new XRWebGLLayer(xrSession, xrGl) });
    xrRefSpace = await xrSession.requestReferenceSpace("local");
  } catch (e) {
    err("WebGL/XR init failed", e);
    distanceMessage.value = "Impossible d'initialiser WebGL pour XR.";
    try { await xrSession.end(); } catch {}
    xrSession = null;
    return;
  }

  isXRRunning.value = true;
  showInitialMessage.value = false;
  frozen.value = false;
  pendingFreeze = false;

  distanceMessage.value = "AR démarrée. Choisis un doigt.";
  log("AR started OK");

  xrSession.addEventListener("end", () => {
    log("XR session end event");
    isXRRunning.value = false;
  });

  xrSession.requestAnimationFrame(onXRFrame);
};

const stopAR = async () => {
  if (xrSession) {
    log("stopAR: ending session");
    try { await xrSession.end(); } catch {}
  }

  xrSession = null;
  xrRefSpace = null;
  lastDepthInfo = null;

  isXRRunning.value = false;
  hasDepth.value = false;
  hasHands.value = false;

  frozen.value = false;
  pendingFreeze = false;

  resetAll("stopAR");
  log("AR stopped");
};

/* =========================================================
   MAIN LOOP
========================================================= */
let frameCount = 0;

const onXRFrame = (t, frame) => {
  if (!xrSession) return;
  xrSession.requestAnimationFrame(onXRFrame);

  const pose = frame.getViewerPose(xrRefSpace);
  if (!pose) return;
  const view = pose.views[0];

  frameCount++;

  // Depth
  lastDepthInfo = frame.getDepthInformation?.(view) ?? null;
  if (lastDepthInfo) {
    if (!hasDepth.value) log("Depth became available");
    hasDepth.value = true;
    depthW.value = lastDepthInfo.width;
    depthH.value = lastDepthInfo.height;
  } else {
    if (hasDepth.value) warn("Depth became unavailable (depthInfo=null)");
    hasDepth.value = false;
  }

  // Render minimal clear
  const glLayer = xrSession.renderState.baseLayer;
  xrGl.bindFramebuffer(xrGl.FRAMEBUFFER, glLayer.framebuffer);
  xrGl.clearColor(0, 0, 0, 1);
  xrGl.clear(xrGl.COLOR_BUFFER_BIT);

  // Info periodic
  if (DBG && frameCount % 90 === 0) {
    log("Heartbeat", {
      frame: frameCount,
      finger: currentFinger.value,
      frozen: frozen.value,
      pendingFreeze,
      hasDepth: hasDepth.value,
      hasHands: hasHands.value,
      depth: lastDepthInfo ? `${depthW.value}x${depthH.value}` : "none",
      live: {
        zL: liveZL.value, zR: liveZR.value, diam: liveDiameterMm.value
      },
      snap: {
        zL: snapZL.value, zR: snapZR.value, diam: snapDiameterMm.value
      },
      resultDisplayed: resultDisplayed.value
    });
  }

  // Frozen => no updates
  if (frozen.value) return;

  // No finger selected
  if (currentFinger.value === "None") {
    hasHands.value = detectAnyHand();
    return;
  }

  // LIVE update
  const ok = updateFingerEdgesFromWebXR(frame, view);
  if (!ok) {
    hasHands.value = false;
    distanceMessage.value = "Main non détectée. Montre ta main à la caméra.";
    return;
  }
  hasHands.value = true;
  if (distanceMessage.value) distanceMessage.value = "";

  // Freeze handling
  if (pendingFreeze) {
    const canFreeze = isLiveMeasureValid();

    log("Freeze pipeline: pendingFreeze check", {
      freezeRequestId,
      lastLiveUpdateId,
      canFreeze,
      edges: { L: !!edgeL.value, R: !!edgeR.value, C: !!edgeC.value },
      live: { zL: liveZL.value, zR: liveZR.value, zC: liveZC.value, diam: liveDiameterMm.value },
      hasDepth: hasDepth.value,
      depthInfo: !!lastDepthInfo,
    });

    if (canFreeze) {
      doFreezeSnapshot("pendingFreeze");
      pendingFreeze = false;
    } else {
      distanceMessage.value = "Mesure… ne bouge plus.";
    }
  }
};

/* =========================================================
   HAND DETECTION
========================================================= */
const detectAnyHand = () => {
  if (!xrSession) return false;
  return xrSession.inputSources.some((s) => !!s.hand);
};

/* =========================================================
   CORE: update LIVE finger edges + depth + diameter
========================================================= */
const updateFingerEdgesFromWebXR = (frame, view) => {
  const finger = currentFinger.value;
  const j = JOINTS[finger];
  if (!j) return false;

  // 1) pick a hand input source
  const src = [...xrSession.inputSources].find((s) => s.hand);
  if (!src?.hand) {
    warn("No inputSource with hand found");
    return false;
  }

  const mcp = src.hand.get(j.mcp);
  const pip = src.hand.get(j.pip);
  if (!mcp || !pip) {
    warn("Missing joints", { finger, mcp: !!mcp, pip: !!pip });
    return false;
  }

  const mcpPose = frame.getJointPose?.(mcp, xrRefSpace);
  const pipPose = frame.getJointPose?.(pip, xrRefSpace);
  if (!mcpPose || !pipPose) {
    warn("Missing joint poses", { finger, mcpPose: !!mcpPose, pipPose: !!pipPose });
    return false;
  }

  // 2) world vectors
  const M = vec3(mcpPose.transform.position.x, mcpPose.transform.position.y, mcpPose.transform.position.z);
  const C = vec3(pipPose.transform.position.x, pipPose.transform.position.y, pipPose.transform.position.z);

  const fingerDir = normalize(sub(C, M));
  if (!fingerDir) return false;

  const Vpos = vec3(view.transform.position.x, view.transform.position.y, view.transform.position.z);
  const viewDir = normalize(sub(C, Vpos));
  if (!viewDir) return false;

  let perp = normalize(cross(viewDir, fingerDir));
  if (!perp) return false;

  // 3) radius
  const radius = Number.isFinite(pipPose.radius) ? pipPose.radius : null;
  if (radius == null || radius <= 0) {
    warn("pipPose.radius invalid => diameter cannot be computed", { finger, radius, pipPoseRadiusRaw: pipPose.radius });
    return false;
  }

  const Lw = add(C, scale(perp, -radius));
  const Rw = add(C, scale(perp,  radius));

  // 4) project to UI
  const rect = xrContainer.value.getBoundingClientRect();
  const pC2 = projectToUI(view, C, rect);
  const pL2 = projectToUI(view, Lw, rect);
  const pR2 = projectToUI(view, Rw, rect);
  if (!pC2 || !pL2 || !pR2) {
    warn("Projection failed", { pC2: !!pC2, pL2: !!pL2, pR2: !!pR2 });
    return false;
  }

  edgeC.value = pC2;
  edgeL.value = pL2;
  edgeR.value = pR2;

  // 5) depth readings (raw + normalized)
  const dz = readDepthTriplet(pC2, pL2, pR2);

  // LIVE assign
  liveZC.value = dz.zC;
  liveZL.value = dz.zL;
  liveZR.value = dz.zR;
  liveDiameterMm.value = 2 * radius * 1000.0;

  lastLiveUpdateId++;
  if (DBG && frameCount % 30 === 0) {
    log("LIVE updated", {
      lastLiveUpdateId,
      finger,
      radius_m: radius,
      liveDiameterMm: fmt(liveDiameterMm.value, 2),
      points: { C: briefPt(pC2), L: briefPt(pL2), R: briefPt(pR2) },
      depthRaw: dz.raw,
      depthNorm: { zC: dz.zC, zL: dz.zL, zR: dz.zR },
    });
  }

  return true;
};

/* =========================================================
   DEPTH: raw -> normalized + logs sur "0"
========================================================= */
const readDepthTriplet = (pC2, pL2, pR2) => {
  const out = { zC: null, zL: null, zR: null, raw: { c: null, l: null, r: null } };

  if (!lastDepthInfo || typeof lastDepthInfo.getDepthInMeters !== "function") {
    out.raw = { c: null, l: null, r: null };
    return out;
  }

  const c = lastDepthInfo.getDepthInMeters(pC2.nx, pC2.ny);
  const l = lastDepthInfo.getDepthInMeters(pL2.nx, pL2.ny);
  const r = lastDepthInfo.getDepthInMeters(pR2.nx, pR2.ny);

  out.raw = { c, l, r };

  const zC = normalizeDepthValue(c);
  const zL = normalizeDepthValue(l);
  const zR = normalizeDepthValue(r);

  out.zC = zC;
  out.zL = zL;
  out.zR = zR;

  // Logs ciblés si problème (0/NaN)
  if (DBG && (c === 0 || l === 0 || r === 0 || !Number.isFinite(c) || !Number.isFinite(l) || !Number.isFinite(r))) {
    warn("Depth read anomaly", {
      raw: { c, l, r },
      norm: { zC, zL, zR },
      depthDims: lastDepthInfo ? `${lastDepthInfo.width}x${lastDepthInfo.height}` : "none",
      pC2: briefPt(pC2),
      pL2: briefPt(pL2),
      pR2: briefPt(pR2),
    });
  }

  return out;
};

const normalizeDepthValue = (v) => {
  if (!Number.isFinite(v)) return null;
  if (v <= 0) return null;   // 0 => invalide / "pas de depth"
  if (v > 10) return null;   // garde-fou (10m)
  return v;
};

/* =========================================================
   FREEZE PIPELINE (très loggé)
========================================================= */
const isLiveMeasureValid = () => {
  const hasEdges = !!edgeL.value && !!edgeR.value;
  const hasDiameter = Number.isFinite(liveDiameterMm.value) && liveDiameterMm.value > 0;

  // Tu veux depth => on exige L/R valides (pas null, pas 0)
  const hasDepthLR =
    Number.isFinite(liveZL.value) && liveZL.value > 0 &&
    Number.isFinite(liveZR.value) && liveZR.value > 0;

  const ok = hasEdges && hasDiameter && hasDepthLR;

  // Log quand ça bloque (ça te dira EXACTEMENT pourquoi tu ne "freeze" pas)
  if (DBG && pendingFreeze && !ok) {
    warn("Freeze blocked: live not valid yet", {
      hasEdges,
      hasDiameter,
      hasDepthLR,
      edgeL: briefPt(edgeL.value),
      edgeR: briefPt(edgeR.value),
      live: {
        zL: liveZL.value,
        zR: liveZR.value,
        zC: liveZC.value,
        diam: liveDiameterMm.value,
      },
      hasDepth: hasDepth.value,
      depthInfo: !!lastDepthInfo,
    });
  }

  return ok;
};

const doFreezeSnapshot = (reason) => {
  log("FREEZE start", {
    reason,
    freezeRequestId,
    lastLiveUpdateId,
    live: { zL: liveZL.value, zR: liveZR.value, zC: liveZC.value, diam: liveDiameterMm.value },
    points: { L: briefPt(edgeL.value), R: briefPt(edgeR.value), C: briefPt(edgeC.value) },
  });

  // copy LIVE -> SNAP
  snapZC.value = liveZC.value;
  snapZL.value = liveZL.value;
  snapZR.value = liveZR.value;
  snapDiameterMm.value = liveDiameterMm.value;

  // freeze state
  frozen.value = true;

  const snapOk = isSnapValid();
  resultDisplayed.value = snapOk;

  log("FREEZE end -> display decision", {
    snapOk,
    resultDisplayed: resultDisplayed.value,
    snap: { zL: snapZL.value, zR: snapZR.value, zC: snapZC.value, diam: snapDiameterMm.value }
  });

  if (!snapOk) {
    warn("SNAP invalid after freeze => preventing display (avoid default result)", {
      snap: { zL: snapZL.value, zR: snapZR.value, zC: snapZC.value, diam: snapDiameterMm.value }
    });
  }
};

const isSnapValid = () => {
  return (
    Number.isFinite(snapZL.value) && snapZL.value > 0 &&
    Number.isFinite(snapZR.value) && snapZR.value > 0 &&
    Number.isFinite(snapDiameterMm.value) && snapDiameterMm.value > 0
  );
};

/* =========================================================
   FINGER BUTTON UX
   - 1er clic : select
   - 2e clic : request freeze on next valid frame
========================================================= */
const onFingerButtonClick = (fingerKey) => {
  if (currentFinger.value !== fingerKey) {
    log("Finger select", { from: currentFinger.value, to: fingerKey });

    currentFinger.value = fingerKey;
    frozen.value = false;
    pendingFreeze = false;
    resultDisplayed.value = false;

    clearSnap("selectFinger");
    clearLive("selectFinger");

    distanceMessage.value = "Place ta main… puis re-clique pour figer.";
    return;
  }

  // second click => freeze request
  freezeRequestId++;
  pendingFreeze = true;
  distanceMessage.value = "Mesure… ne bouge plus.";

  log("Freeze requested", {
    freezeRequestId,
    finger: fingerKey,
    lastLiveUpdateId,
    live: { zL: liveZL.value, zR: liveZR.value, zC: liveZC.value, diam: liveDiameterMm.value },
    hasDepth: hasDepth.value,
    hasHands: hasHands.value,
  });
};

/* =========================================================
   RESTART / RESET
========================================================= */
const restart = () => {
  log("Restart");
  frozen.value = false;
  pendingFreeze = false;
  resultDisplayed.value = false;
  clearSnap("restart");
  clearLive("restart");
  distanceMessage.value = "Nouvelle mesure. Choisis un doigt.";
};

const resetAll = (tag) => {
  log("Reset all", tag);
  frozen.value = false;
  pendingFreeze = false;
  currentFinger.value = "None";
  resultDisplayed.value = false;
  clearSnap(tag);
  clearLive(tag);
  distanceMessage.value = "";
};

const clearLive = (tag) => {
  edgeL.value = null;
  edgeR.value = null;
  edgeC.value = null;

  liveZC.value = null;
  liveZL.value = null;
  liveZR.value = null;
  liveDiameterMm.value = null;

  if (DBG) log("LIVE cleared", tag);
};

const clearSnap = (tag) => {
  snapZC.value = null;
  snapZL.value = null;
  snapZR.value = null;
  snapDiameterMm.value = null;

  if (DBG) log("SNAP cleared", tag);
};

/* =========================================================
   PROJECTION: world -> UI coords
========================================================= */
const projectToUI = (view, worldP, rect) => {
  const invView = view.transform.inverse.matrix;
  const proj = view.projectionMatrix;

  const v = mulMat4Vec4(invView, [worldP.x, worldP.y, worldP.z, 1]);
  const c = mulMat4Vec4(proj, v);

  if (Math.abs(c[3]) < 1e-6) return null;

  const ndcX = c[0] / c[3];
  const ndcY = c[1] / c[3];

  if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return null;

  const nx = (ndcX + 1) * 0.5;
  const ny = 1 - (ndcY + 1) * 0.5;

  const cnx = Math.max(0, Math.min(1, nx));
  const cny = Math.max(0, Math.min(1, ny));

  return {
    nx: cnx,
    ny: cny,
    uiX: cnx * rect.width,
    uiY: cny * rect.height,
  };
};

const mulMat4Vec4 = (m, v) => {
  const x = v[0], y = v[1], z = v[2], w = v[3];
  return [
    m[0]*x + m[4]*y + m[8]*z + m[12]*w,
    m[1]*x + m[5]*y + m[9]*z + m[13]*w,
    m[2]*x + m[6]*y + m[10]*z + m[14]*w,
    m[3]*x + m[7]*y + m[11]*z + m[15]*w,
  ];
};

/* =========================================================
   VEC3 HELPERS
========================================================= */
const vec3 = (x,y,z) => ({x,y,z});
const add = (a,b) => vec3(a.x+b.x, a.y+b.y, a.z+b.z);
const sub = (a,b) => vec3(a.x-b.x, a.y-b.y, a.z-b.z);
const scale = (a,s) => vec3(a.x*s, a.y*s, a.z*s);
const cross = (a,b) => vec3(
  a.y*b.z - a.z*b.y,
  a.z*b.x - a.x*b.z,
  a.x*b.y - a.y*b.x
);
const normalize = (a) => {
  const l = Math.hypot(a.x,a.y,a.z);
  if (!Number.isFinite(l) || l < 1e-8) return null;
  return vec3(a.x/l, a.y/l, a.z/l);
};

/* =========================================================
   EXPOSE
========================================================= */
defineExpose({
  openModal,
  closeModal,
  startAR,
  stopAR,
  restart,
  onFingerButtonClick,

  // si tu veux inspecter dans la console Vue devtools
  liveZL, liveZR, liveZC, liveDiameterMm,
  snapZL, snapZR, snapZC, snapDiameterMm,
  edgeL, edgeR, frozen, pendingFreeze,
});
</script>



<style scoped>
/* base visuel inchangé */
.baguier-root {
  margin: 0;
  padding: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100vh;
  width: 100vw;
  background-color: #f0f0f0;
  background-image: url("/images/base-sizing.jpg");
  background-repeat: no-repeat;
  background-position: center;
  background-size: cover;
}

#openModalButton {
  padding: 10px 20px;
  background-color: #4CAF50;
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-size: 18px;
}
#openModalButton:hover { background-color: #000; }

.modal {
  display: none;
  position: fixed;
  z-index: 1000;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  justify-content: center;
  align-items: center;
}

.modal-content {
  background-color: #fff;
  width: 90%;
  max-width: 400px;
  border-radius: 10px;
  position: relative;
  padding: 20px;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
}

.close {
  color: #aaa;
  position: absolute;
  top: 10px;
  right: 15px;
  font-size: 28px;
  font-weight: bold;
  cursor: pointer;
}
.close:hover, .close:focus {
  color: black;
  text-decoration: none;
}

#videoContainer {
  position: relative;
  width: 100%;
  padding-top: 177.78%;
  overflow: hidden;
  background-color: black;
}

#xrCanvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.pick-dot {
  position: absolute;
  width: 12px;
  height: 12px;
  border-radius: 999px;
  background: #4CAF50;
  border: 2px solid #000;
  transform: translate(-50%, -50%);
  z-index: 1500;
}

#fingerSelection {
  text-align: center;
  margin-top: 10px;
}

.finger-button {
  margin: 3px;
  padding: 12px;
  cursor: pointer;
  background-color: #4CAF50;
  color: white;
  border: none;
  border-radius: 5px;
  font-size: 14px;
}
.finger-button:hover { background-color: #000; }

.selected {
  background-color: #4CAF50;
  color: white;
  border: 2px solid #000;
}

#initialMessage {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 350px;
  height: 660px;
  background-color: #000;
  color: #fff;
  font-size: 18px;
  text-align: center;
  pointer-events: none;
  position: absolute;
  z-index: 1000;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  opacity: 1;
  padding: 25px;
  font-family: arial;
  line-height: 1.2;
}

#resultCircle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: green;
  font-size: 18px;
  font-family: Arial, sans-serif;
  text-align: center;
  z-index: 20;
}

.result-bubble {
  border-radius: 50%;
  width: 250px;
  height: 250px;
  opacity: .95;
  background-color: black;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: #4CAF50;
  font-size: 16px;
  font-family: Arial, sans-serif;
  text-align: center;
}

#newMeasurementButton {
  padding: 10px 10px;
  background-color: #4CAF50;
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  position: absolute;
  bottom: -50px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 21;
  width: 150px;
}

.hidden { display: none !important; }

#distanceCircle {
  position: absolute;
  top: 10px;
  left: 10px;
  color: #4CAF50;
  font-size: 14px;
  font-family: Arial, sans-serif;
  z-index: 1000;
}
</style>
