<template src="./BaguierVirtuel.html"></template>

<script setup>
import * as logic from './BaguierVirtuel.js';
import { onUnmounted } from 'vue';

// On extrait explicitement chaque variable pour le template HTML
const {
  isModalOpen, showInitialMessage, handDetected, videoElement, freezeCanvasEl,
  debugCanvasEl, currentFinger, currentHandFilter, distanceMessage,
  resultDisplayed, isFrozen, resultEU, measuredDiameter, confidenceLevel,
  detectionMode, FINGERS_CONFIG, openModal, closeModal, resumeMeasurement, restart, selectFinger
} = logic;

onUnmounted(() => logic.closeModal());
</script>

<style scoped src="./BaguierVirtuel.css"></style>