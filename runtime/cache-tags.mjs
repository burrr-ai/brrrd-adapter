// Owns Next's local tag publication. Rust owns authoritative commits and namespaces.
// Read order is local causality, not a transport or request-completion protocol.
const publications = new WeakMap();
const MAX_REPEATS_PER_BATCH = 64;

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
        uncertaintyFence: null, known: this.manifest.get(tag) };
      this.tags.set(tag, state);
    }
    return state;
  }

  render(tag, state) {
    if (this.manifest.get(tag) !== state.known || !state.committed) return;
    const next = { ...state.committed };
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
    if (state.uncertaintyFence !== null && order <= state.uncertaintyFence) return 'fenced';
    const changed = state.epoch !== epoch;
    if (state.epoch !== undefined && changed && order <= state.epochFence) return 'fenced';
    if (state.uncertaintyFence !== null && order > state.uncertaintyFence) state.uncertaintyFence = null;
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

  read(tag) {
    const state = this.tags.get(tag);
    if (!state?.committed) throw new Error('cache tag has no authoritative snapshot');
    if (state.uncertaintyFence !== null) throw new Error('cache tag outcome unknown; fresh snapshot required');
    return { ...state.committed };
  }

  markUncertain(state) {
    // Certainty may only be restored by a read issued after this observation.
    // This is data, not an uncommitted patch or a producer promise.
    state.uncertaintyFence = this.issued;
  }

  async commit(cache, tag, patch) {
    const state = this.state(tag);
    const issueEpoch = state.epoch;
    const order = this.issueRead();
    try {
      const result = await cache.commitTag(tag, patch);
      if (result?.status !== 'committed') {
        throw new Error(`cache tag commit ${result?.status || 'invalid'}; outcome unknown`);
      }
      let outcome = this.accept(result, order);
      if (outcome === 'fenced') {
        const obsolete = issueEpoch !== undefined && issueEpoch === (result.epoch ?? null)
          && state.epoch !== issueEpoch;
        if (!obsolete) {
          // One fresh native read distinguishes an ambiguous backend incarnation.
          const readOrder = this.issueRead();
          let observed;
          try { observed = await cache.tagSnapshot(tag); }
          catch { this.markUncertain(state); return result; }
          outcome = this.accept(observed, readOrder);
          if (outcome !== 'accepted' && outcome !== 'older') this.markUncertain(state);
        }
      } else if (outcome !== 'accepted' && outcome !== 'older') {
        throw new Error('cache tag commit has invalid authoritative state; outcome unknown');
      }
      return result;
    } catch (error) {
      this.markUncertain(state);
      throw error;
    }
  }

  async update(cache, tags, patch) {
    const keys = Array.isArray(tags) ? [...tags] : [tags];
    if (!keys.every(tag => typeof tag === 'string')) throw new TypeError('cache tags must be strings');
    if (!['stale', 'expired'].every(field => patch[field] === null
      || (Number.isSafeInteger(patch[field]) && patch[field] >= 0))) throw new TypeError('invalid cache tag timestamp');
    const counts = new Map();
    for (const tag of keys) {
      const count = (counts.get(tag) || 0) + 1;
      if (count > MAX_REPEATS_PER_BATCH) throw new Error('cache tag operation batch limit');
      counts.set(tag, count);
    }
    // Sequence only this operation's own batch. Separate requests synchronize
    // through native COMMIT/revision, never through another request's promise.
    for (const tag of keys) await this.commit(cache, tag, patch);
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
