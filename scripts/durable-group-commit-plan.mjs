function isPairGroup(group, expectedFirstIndex) {
  if (!group || typeof group !== 'object' || Array.isArray(group)
    || !Object.hasOwn(group, 'state') || !Array.isArray(group.indices)
    || group.indices.length < 1 || group.indices.length > 2) return false;

  for (let offset = 0; offset < group.indices.length; offset++) {
    if (group.indices[offset] !== expectedFirstIndex + offset) return false;
  }
  return true;
}

export function planPairs(states) {
  if (!Array.isArray(states) || states.length < 1 || states.length > 35) {
    throw new TypeError('Invalid durable state list');
  }

  const groups = [];
  for (let first = 0; first < states.length; first += 2) {
    const last = Math.min(first + 1, states.length - 1);
    groups.push(Object.freeze({
      indices: Object.freeze(last === first ? [first] : [first, last]),
      state: states[last],
    }));
  }
  return Object.freeze(groups);
}

export function runPlannedSaves(groups, save) {
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > 35 || typeof save !== 'function') {
    throw new TypeError('Invalid durable save plan');
  }

  let expectedFirstIndex = 0;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    if (!isPairGroup(group, expectedFirstIndex)) throw new TypeError('Invalid durable save group');
    expectedFirstIndex += group.indices.length;
    if (expectedFirstIndex > 35) throw new TypeError('Durable save plan exceeds state limit');
  }

  const publishedIndices = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    try {
      const result = save(group.state);
      if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
        let then;
        try { then = result.then; } catch { return { publishedIndices, failedGroupIndex: groupIndex }; }
        if (typeof then === 'function') {
          // Consume a possible rejection without treating an async save as durable.
          Promise.resolve(result).catch(() => {});
          return { publishedIndices, failedGroupIndex: groupIndex };
        }
      }
    } catch {
      return { publishedIndices, failedGroupIndex: groupIndex };
    }
    publishedIndices.push(...group.indices);
  }

  return { publishedIndices, failedGroupIndex: null };
}
