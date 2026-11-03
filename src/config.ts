/* =========================================================
   SETTINGS - names match the Paper liquid-metal controls
   ========================================================= */
export const metal = {
  colorTint: [0xb8 / 255, 0xb8 / 255, 0xb8 / 255] as [number, number, number],
  repetition: 2, // stripe density
  softness: 0.1, // 0 = hard stripe edges, 1 = smooth
  shiftRed: 0.3, // chromatic dispersion
  shiftBlue: 0.3,
  distortion: 1, // noise wobble on the stripes
  contour: 0.4, // how much the stripes bend around the shape edges
  angle: 70, // stripe direction (degrees)
  speed: 0.28,
  scale: 0.6,
  edgeSoftness: 0.08, // feathering of the letter outline
};

export const colors = {
  bg: "#000000",
  blob1: "#14a89c", // teal, top-left
  blob2: "#2f6fed", // blue, bottom-right
};

export const blob = {
  opacity: 0.55,
  opacityPeak: 0.7,
};

export const hellos = [
  "hello", "hello", "hello", "hello", "hello",
  "szia", "szia", "szentem", "szervusz", "szia", "szia",
  "hola", "bonjour", "hallo", "ciao", "olá", "cześć",
  "ahoj", "hei", "hej", "geia", "priveet", "terve",
  "tere", "labas", "zdravo",
];

// Timing (seconds)
export const timing = {
  introDelay: 0.6, // first "hello" melts in after this
  stayMin: 2, // each word holds for 2-4 s (random)
  stayMax: 4,
  morph: 1.2, // liquid morph duration
  lead: 0.5, // waves start building this long before each morph
  transitionBoost: 3, // how much faster/wavier it gets mid-transition
};

// Vertical drift + scale from the hello page, applied during the morph.
// Set drift to 0 for a pure in-place liquid morph.
export const motion = {
  drift: 26, // dp
  exitScale: 1.15,
  enterScale: 0.85,
};
