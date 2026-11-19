// mark.js - the "tap the basket" startup step. A small flow controller: no DOM, no timers.
//
//   tap      the user taps the middle of the basket on the large camera view
//   confirm  the app has looked around the tap for the top band and the tray and shows the box
//            (OK, tap again, or "fix": tap the top, then the bottom, by hand)
//   top / bottom  the manual fallback: two taps give the cage's top and bottom
//
// Coordinates are raw camera-frame fractions (not mirrored). The box handed to onCommit is what
// the make/miss logic treats as the cage: the area the disc must enter and stay in.
//
//   createBasketMark({ refine, aspect, onChange, onCommit })
//     refine(xn, yn) -> { xn, yn, wn, hn, refined, ... }   (finder.mark)
//     aspect()       -> video width / height (for preview boxes)
//     onChange(view) -> view = { phase, prompt, box, refined, canOk, canFix } | { phase: null }
//     onCommit(box)  -> the confirmed box

import { CONFIG } from './config.js';

export const PROMPT = Object.freeze({
  tap: 'Tap the middle of the basket',
  confirmRefined: 'Box runs top band to tray. OK, or tap again.',
  confirmPlain: 'Edges not found, using your tap. OK, tap again, or fix.',
  confirmHand: 'Box from your two taps. OK, or tap again.',
  top: 'Tap the TOP band of the basket',
  bottom: 'Now tap the BOTTOM of the basket (the tray)',
});

export function createBasketMark({ refine, aspect = () => 16 / 9, onChange, onCommit }) {
  const C = CONFIG.BASKET;
  let phase = null;
  let pending = null; // box that OK would commit
  let preview = null; // box drawn on the feed
  let note = PROMPT.tap;
  let topTap = null;

  const emit = () => {
    if (!onChange) return;
    onChange(phase
      ? {
        phase,
        prompt: note,
        box: preview,
        refined: !!(pending && pending.refined),
        canOk: phase === 'confirm',
        canFix: phase === 'confirm',
      }
      : { phase: null });
  };

  /** A box to draw for a plain tap: the real size comes later from the scale. */
  const plainPreview = (xn, yn) => ({
    xn, yn, hn: C.TAP_BOX_H, wn: (C.TAP_BOX_H * C.TAP_BOX_ASPECT) / aspect(),
  });

  return {
    begin() { phase = 'tap'; pending = null; preview = null; topTap = null; note = PROMPT.tap; emit(); },
    cancel() { phase = null; pending = null; preview = null; emit(); },
    isActive: () => phase !== null,
    getView() {
      return phase
        ? { phase, prompt: note, box: preview, refined: !!(pending && pending.refined), canOk: phase === 'confirm', canFix: phase === 'confirm' }
        : { phase: null };
    },
    tap(xn, yn) {
      if (phase === 'tap' || phase === 'confirm') {
        const b = refine(xn, yn);
        pending = b;
        preview = b.refined ? { xn: b.xn, yn: b.yn, wn: b.wn, hn: b.hn } : plainPreview(xn, yn);
        note = b.refined ? PROMPT.confirmRefined : PROMPT.confirmPlain;
        phase = 'confirm';
      } else if (phase === 'top') {
        topTap = { xn, yn };
        preview = null;
        note = PROMPT.bottom;
        phase = 'bottom';
      } else if (phase === 'bottom') {
        const y0 = Math.min(topTap.yn, yn);
        const y1 = Math.max(topTap.yn, yn);
        if (y1 - y0 < 0.02) { note = `Too close together. ${PROMPT.top}`; phase = 'top'; topTap = null; emit(); return; }
        const hn = y1 - y0;
        const box = {
          xn: (topTap.xn + xn) / 2,
          yn: (y0 + y1) / 2,
          hn,
          wn: (hn * C.TAP_BOX_ASPECT) / aspect(),
          manual: true,
          refined: true,
          score: null,
          band: null,
        };
        pending = box;
        preview = { xn: box.xn, yn: box.yn, wn: box.wn, hn: box.hn };
        note = PROMPT.confirmHand;
        phase = 'confirm';
      }
      emit();
    },
    ok() {
      if (phase !== 'confirm' || !pending) return;
      const box = pending;
      phase = null; pending = null; preview = null;
      emit();
      if (onCommit) onCommit(box);
    },
    fix() { if (phase === 'confirm') { phase = 'top'; note = PROMPT.top; preview = null; pending = null; emit(); } },
  };
}
