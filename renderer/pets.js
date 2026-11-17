'use strict';
// Pixel pets: one little critter per session, drawn as an SVG pixel grid.
// Every pet shares the same chunky body, but the session id picks its colour,
// eyes, headwear, markings and idle habit, so no two sessions look alike.

(function () {
  const W = 14;
  const H = 13;

  const COLORS = {
    orange: ['#E07B53', '#B85A36', '#F6B79C'],
    blue: ['#5AA8FF', '#2F7BD6', '#B5D8FF'],
    pink: ['#FF7AA2', '#D24D78', '#FFC2D4'],
    amber: ['#F7B731', '#C98A0E', '#FDE29B'],
    violet: ['#A98BFF', '#7A5BE0', '#D9CCFF'],
    teal: ['#3FD0C0', '#1E9C8F', '#A7EEE6'],
    green: ['#5CCB6F', '#33994A', '#B5EBBE'],
    indigo: ['#7C83FF', '#5157D6', '#C7CAFF'],
  };
  const INK = '#1B1B22';

  const EYES = ['tall', 'wide', 'dot', 'sleepy', 'big'];
  const HATS = ['none', 'antenna', 'ears', 'sprout', 'crown', 'horns', 'tuft', 'bow'];
  const MARKS = ['none', 'blush', 'belly', 'spots', 'none', 'blush'];
  const HABITS = ['bob', 'sway', 'hop', 'look', 'bob', 'wiggle'];
  const ARMS = ['out', 'out', 'nub', 'up'];

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  const pick = (arr, h, shift) => arr[(h >>> shift) % arr.length];

  function traits(id, color) {
    const h = hash(String(id));
    const h2 = hash(String(id) + '#');
    return {
      color: COLORS[color] ? color : pick(Object.keys(COLORS), h, 0),
      eyes: pick(EYES, h, 3),
      hat: pick(HATS, h, 7),
      mark: pick(MARKS, h, 11),
      habit: pick(HABITS, h, 15),
      arms: pick(ARMS, h, 19),
      // Each pet runs at its own pace so a row of them never moves in lockstep.
      pace: 2.2 + ((h2 % 1000) / 1000) * 1.6,
      blinkEvery: 3.2 + (((h2 >>> 10) % 1000) / 1000) * 2.8,
      phase: (h2 >>> 20) % 5000,
    };
  }

  const px = (x, y, fill, w = 1, h = 1) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;

  function hatSvg(t, c) {
    const [, dark, light] = c;
    switch (t.hat) {
      case 'antenna':
        return px(7, 1, dark, 1, 2) + px(6, 0, '#FFD60A', 2, 1);
      case 'ears':
        return px(3, 1, dark, 2, 2) + px(9, 1, dark, 2, 2) + px(4, 2, light) + px(9, 2, light);
      case 'sprout':
        return px(7, 1, '#3FBF5A', 1, 2) + px(8, 0, '#5EE07E', 2, 1) + px(5, 0, '#5EE07E', 2, 1);
      case 'crown':
        return px(4, 2, '#FFD60A', 6, 1) + px(4, 1, '#FFD60A') + px(6, 1, '#FFD60A', 2, 1) + px(9, 1, '#FFD60A') + px(6, 0, '#FF6B6B', 2, 1);
      case 'horns':
        return px(3, 1, '#F2E8D8', 1, 2) + px(10, 1, '#F2E8D8', 1, 2) + px(2, 0, '#F2E8D8') + px(11, 0, '#F2E8D8');
      case 'tuft':
        return px(6, 1, dark, 2, 2) + px(5, 2, dark) + px(8, 2, dark) + px(7, 0, dark);
      case 'bow':
        return px(9, 1, '#FF5C8A', 1, 2) + px(11, 1, '#FF5C8A', 1, 2) + px(10, 1, '#FF9DBA', 1, 1) + px(10, 2, '#FF5C8A');
      default:
        return '';
    }
  }

  function eyesSvg(t) {
    // Eye centres sit on columns 5 and 8, rows 5–6.
    switch (t.eyes) {
      case 'wide':
        return px(4, 5, INK, 2, 1) + px(8, 5, INK, 2, 1);
      case 'dot':
        return px(5, 5, INK) + px(8, 5, INK);
      case 'sleepy':
        return px(4, 6, INK, 2, 1) + px(8, 6, INK, 2, 1);
      case 'big':
        return px(4, 5, INK, 2, 2) + px(8, 5, INK, 2, 2) + px(4, 5, '#FFFFFF') + px(8, 5, '#FFFFFF');
      default:
        return px(5, 5, INK, 1, 2) + px(8, 5, INK, 1, 2);
    }
  }

  function marksSvg(t, c) {
    const [, dark, light] = c;
    switch (t.mark) {
      case 'blush':
        return px(4, 7, '#FF8FA8') + px(9, 7, '#FF8FA8');
      case 'belly':
        return px(5, 7, light, 4, 2);
      case 'spots':
        return px(4, 3, dark) + px(9, 4, dark) + px(6, 8, dark);
      default:
        return '';
    }
  }

  function armsSvg(t, c) {
    const [base] = c;
    switch (t.arms) {
      case 'nub':
        return px(2, 6, base) + px(11, 6, base);
      case 'up':
        return px(2, 4, base, 1, 2) + px(11, 4, base, 1, 2) + px(1, 4, base) + px(12, 4, base);
      default:
        return px(1, 5, base, 2, 2) + px(11, 5, base, 2, 2);
    }
  }

  function badgeSvg(status) {
    // A tiny pixel speech bubble for states that want your attention.
    if (status === 'permission') {
      return `<g class="pet-badge">${px(11, 0, '#FF9F0A', 3, 4)}${px(12, 0.5, '#fff', 1, 2)}${px(12, 3, '#fff', 1, 0.6)}</g>`;
    }
    if (status === 'question') {
      return `<g class="pet-badge">${px(11, 0, '#BF5AF2', 3, 4)}${px(11.5, 0.5, '#fff', 2, 0.7)}${px(12.8, 0.5, '#fff', 0.7, 1.4)}${px(12, 1.7, '#fff', 0.8, 0.7)}${px(12, 3, '#fff', 0.8, 0.6)}</g>`;
    }
    if (status === 'done') {
      return `<g class="pet-badge sparkle">${px(12, 0, '#FFD60A', 1, 3)}${px(11, 1, '#FFD60A', 3, 1)}</g>`;
    }
    if (status === 'waiting') {
      return `<g class="pet-badge zz">${px(11, 1, '#64D2FF', 2, 0.6)}${px(12, 1.6, '#64D2FF', 0.6, 0.8)}${px(11, 2.4, '#64D2FF', 2, 0.6)}</g>`;
    }
    return '';
  }

  // A fixed per-pet offset, so pets never move in lockstep. The markup stays the same
  // between updates, which lets the page keep each pet's node (and its animation) alive.
  function delay(t, seconds) {
    return `-${((t.phase / 1000) % seconds).toFixed(2)}s`;
  }

  function petSvg(session, size = 34) {
    const t = traits(session.id, session.color);
    const c = COLORS[t.color];
    const [base, dark] = c;
    const status = session.status;
    const mood = status === 'running' ? 'busy' : status === 'done' ? 'happy' : status === 'permission' || status === 'question' ? 'alert' : 'idle';
    const pace = mood === 'busy' ? t.pace * 0.45 : mood === 'alert' ? 0.5 : t.pace;
    const style = `--pace:${pace.toFixed(2)}s;--blink:${t.blinkEvery.toFixed(2)}s;--d1:${delay(t, pace)};--d2:${delay(t, t.blinkEvery)}`;

    const body =
      px(3, 3, base, 8, 6) + // torso
      px(3, 8, dark, 8, 1) + // shadow line
      armsSvg(t, c) +
      marksSvg(t, c);
    const legsA = px(3, 9, dark, 1, 2) + px(5, 9, dark, 1, 2) + px(8, 9, dark, 1, 2) + px(10, 9, dark, 1, 2);
    const legsB = px(3, 9, dark, 1, 1) + px(5, 9, dark, 1, 2) + px(8, 9, dark, 1, 1) + px(10, 9, dark, 1, 2);

    return `<svg class="pet pet-${mood} habit-${t.habit}" style="${style}" width="${size}" height="${size}" viewBox="0 -1 ${W} ${H}" shape-rendering="crispEdges" aria-hidden="true">
      <rect class="pet-shadow" x="3" y="11" width="8" height="0.8" fill="rgba(0,0,0,0.35)"/>
      <g class="pet-all">
        <g class="pet-legs"><g class="legs-a">${legsA}</g><g class="legs-b">${legsB}</g></g>
        <g class="pet-top">
          ${hatSvg(t, c)}
          ${body}
          <g class="pet-eyes">${eyesSvg(t)}</g>
        </g>
      </g>
      ${badgeSvg(status)}
    </svg>`;
  }

  window.PETS = { petSvg, traits, COLORS };
})();
