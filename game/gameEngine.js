'use strict';

function mod(n, m) {
  return ((n % m) + m) % m;
}

function canPlay(card, topCard, currentColor) {
  if (card.color === 'wild') return true;
  if (card.color === currentColor) return true;
  if (card.type === 'number') {
    return topCard.type === 'number' && card.value === topCard.value;
  }
  return card.type === topCard.type; // skip / reverse / draw2 は同種なら出せる
}

function getPlayableUids(hand, topCard, currentColor) {
  return hand.filter(c => canPlay(c, topCard, currentColor)).map(c => c.uid);
}

// Returns next player index after applying card effect.
// Also returns: effects (draw penalties), newDirection, requiresColorChoice.
// Effects: [{ playerIndex, drawCount }]
function resolveCardEffect(card, currentPlayerIndex, direction, playerCount) {
  const next = (offset) => mod(currentPlayerIndex + offset * direction, playerCount);
  let nextIndex = next(1);
  let newDirection = direction;
  let requiresColorChoice = false;
  const effects = [];

  switch (card.type) {
    case 'skip':
      nextIndex = next(2);
      break;

    case 'reverse':
      newDirection = -direction;
      if (playerCount === 2) {
        // In 2-player, reverse acts like skip (current player goes again)
        nextIndex = currentPlayerIndex;
      } else {
        nextIndex = mod(currentPlayerIndex + newDirection, playerCount);
      }
      break;

    case 'draw2':
      effects.push({ playerIndex: next(1), drawCount: 2 });
      nextIndex = next(2);
      break;

    case 'wild':
      requiresColorChoice = true;
      nextIndex = next(1);
      break;

    case 'wild-draw4':
      requiresColorChoice = true;
      effects.push({ playerIndex: next(1), drawCount: 4 });
      nextIndex = next(2);
      break;
  }

  return { nextIndex, newDirection, requiresColorChoice, effects };
}

module.exports = { mod, canPlay, getPlayableUids, resolveCardEffect };
