// Owns Next's local tag publication. Rust owns authoritative commits and namespaces.
// Read order is local causality, not a transport or request-completion protocol.
const publications = new WeakMap();
const MAX_PENDING_PER_TAG = 64;

function snapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const field of ['stale', 'expired']) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !('value' in descriptor)
      || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) return null;
    result[field] = descriptor.value;
  }
  return result;
}

export class CacheTagPublication {
  constructor(manifest) {
    if (!(manifest instanceof Map)) throw new TypeError('Next tag manifest must be a Map');
    this.manifest = manifest;
    this.tags = new Map();
    this.issued = 0n;
  }

  issueRead() { return ++this.issued; }

  state(tag) {
    let state = this.tags.get(tag);
    if (!state) {
      state = { revision: null, epoch: undefined, epochFence: 0n, committed: null,
        uncertain: null, pending: [], tail: null, known: this.manifest.get(tag) };
      this.tags.set(tag, state);
    }
    return state;
  }

  render(tag, state) {
    if (this.manifest.get(tag) !== state.known || !state.committed) return;
    const next = { ...state.committed };
    for (const patch of [state.uncertain?.patch, ...state.pending.map(p => p.patch)]) {
      if (!patch) continue;
      for (const field of ['stale', 'expired']) if (patch[field] !== null) next[field] = patch[field];
    }
    this.manifest.set(tag, next);
    state.known = next;
  }

  accept(value, order) {
    if (typeof value?.tag !== 'string' || value.status !== 'committed'
      || typeof order !== 'bigint' || typeof value.revision !== 'string'
      || !/^(0|[1-9][0-9]*)$/.test(value.revision)) return 'invalid';
    const epoch = value.epoch ?? null;
    if (epoch !== null && (typeof epoch !== 'string' || !/^[0-9a-f]{32}$/.test(epoch))) return 'invalid';
    const data = snapshot(value);
    if (!data) return 'invalid';
    const state = this.state(value.tag);
    const changed = state.epoch !== epoch;
    if (state.epoch !== undefined && changed && order <= state.epochFence) return 'fenced';
    if (state.uncertain && order > state.uncertain.fence) state.uncertain = null;
    const revision = BigInt(value.revision);
    if (!changed && state.revision !== null && revision <= state.revision) {
      this.render(value.tag, state);
      return 'older';
    }
    if (changed) {
      state.epoch = epoch;
      state.epochFence = this.issued;
    }
    state.revision = revision;
    state.committed = data;
    this.render(value.tag, state);
    return 'accepted';
  }

  hydrate(states, order) {
    if (!Array.isArray(states)) return;
    for (const value of states) this.accept(value, order);
  }

  reserve(tag, patch) {
    const state = this.state(tag);
    if (state.pending.length >= MAX_PENDING_PER_TAG) throw new Error('cache tag pending operation limit');
    let release;
    const done = new Promise(resolve => { release = resolve; });
    const pending = { tag, state, patch, before: state.tail || Promise.resolve(), release };
    state.tail = pending.before.then(() => done);
    state.pending.push(pending);
    return pending;
  }

  settle(pending) {
    const { tag, state } = pending;
    state.pending.splice(state.pending.indexOf(pending), 1);
    if (!state.pending.length) state.tail = null;
    pending.release();
    this.render(tag, state);
  }

  uncertain(pending) {
    const { state, patch } = pending;
    const combined = { ...(state.uncertain?.patch || { stale: null, expired: null }) };
    for (const field of ['stale', 'expired']) if (patch[field] !== null) combined[field] = patch[field];
    state.uncertain = { patch: combined, fence: this.issued };
  }

  async commit(cache, pending) {
    const { tag, state, patch } = pending;
    await pending.before;
    const issueEpoch = state.epoch;
    const order = this.issueRead();
    try {
      const result = await cache.commitTag(tag, patch);
      if (result?.status !== 'committed') {
        this.uncertain(pending);
        throw new Error(`cache tag commit ${result?.status || 'invalid'}; outcome unknown`);
      }
      let outcome = this.accept(result, order);
      if (outcome === 'fenced') {
        const obsolete = issueEpoch !== undefined && issueEpoch === (result.epoch ?? null)
          && state.epoch !== issueEpoch;
        if (!obsolete) {
          // A raced first observation needs one fresh authoritative read, never a retry loop.
          const readOrder = this.issueRead();
          let observed;
          try { observed = await cache.tagSnapshot(tag); }
          catch { this.uncertain(pending); return result; }
          outcome = this.accept(observed, readOrder);
          if (outcome !== 'accepted' && outcome !== 'older') this.uncertain(pending);
        }
      } else if (outcome !== 'accepted' && outcome !== 'older') {
        this.uncertain(pending);
        throw new Error('cache tag commit has invalid authoritative state; outcome unknown');
      }
      return result;
    } catch (error) {
      this.uncertain(pending);
      throw error;
    }
  }

  async update(cache, tags, patch) {
    const keys = Array.isArray(tags) ? tags : [tags];
    if (!keys.every(tag => typeof tag === 'string')) throw new TypeError('cache tags must be strings');
    if (!['stale', 'expired'].every(field => patch[field] === null
      || (Number.isSafeInteger(patch[field]) && patch[field] >= 0))) throw new TypeError('invalid cache tag timestamp');
    const batch = [];
    try {
      for (const tag of keys) batch.push(this.reserve(tag, patch));
    } catch (error) {
      for (const pending of batch) this.settle(pending);
      throw error;
    }
    // Reserve the complete batch before publishing or submitting any mutation.
    for (const { tag, state } of batch) {
      if (!state.committed) state.committed = snapshot(state.known) || { stale: 0, expired: 0 };
      this.render(tag, state);
    }
    let index = 0;
    try {
      for (; index < batch.length; index++) {
        const pending = batch[index];
        try { await this.commit(cache, pending); }
        finally { this.settle(pending); }
      }
    } finally {
      // Unsubmitted remainder has no backend commit to acknowledge.
      for (let rest = index + 1; rest < batch.length; rest++) this.settle(batch[rest]);
    }
  }
}

export function cacheTagPublication() {
  const manifest = globalThis.__brrrd_next_cache_tags_manifest;
  if (!(manifest instanceof Map)) throw new Error('native Next tag manifest is not initialized');
  let publication = publications.get(manifest);
  if (!publication) publications.set(manifest, publication = new CacheTagPublication(manifest));
  return publication;
}


export function tagMutation(durations, now) {
  const expire = durations?.expire;
  return { stale: durations ? now : null,
    expired: !durations ? now : expire === undefined ? null : now + expire * 1000 };
}
