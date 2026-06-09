'use strict';

const COLORS = ['red', 'blue', 'green', 'yellow'];
const SPECIALS = ['skip', 'reverse', 'draw2'];

function createDeck() {
  const cards = [];
  let uid = 0;

  for (const color of COLORS) {
    cards.push(makeCard(uid++, color, 'number', 0, 0));
    for (let n = 1; n <= 9; n++) {
      cards.push(makeCard(uid++, color, 'number', n, n));
      cards.push(makeCard(uid++, color, 'number', n, n));
    }
    for (const type of SPECIALS) {
      cards.push(makeCard(uid++, color, type, type, 20));
      cards.push(makeCard(uid++, color, type, type, 20));
    }
  }

  for (let i = 0; i < 4; i++) {
    cards.push(makeCard(uid++, 'wild', 'wild', 'wild', 50));
    cards.push(makeCard(uid++, 'wild', 'wild-draw4', 'wild-draw4', 50));
  }

  return cards; // 108 cards
}

function makeCard(uid, color, type, value, points) {
  let imageId;
  if (color === 'wild') {
    imageId = type === 'wild' ? 'wild-normal' : 'wild-draw4';
  } else if (type === 'number') {
    imageId = `${color}-${value}`;
  } else {
    imageId = `${color}-${type}`;
  }
  return { uid: `c${uid}`, color, type, value, points, imageId };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function calculateHandPoints(hand) {
  return hand.reduce((sum, c) => sum + c.points, 0);
}

module.exports = { createDeck, shuffle, calculateHandPoints };
