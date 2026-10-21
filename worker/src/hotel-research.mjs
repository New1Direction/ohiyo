import { createHash } from 'node:crypto';

/** Composition of canonical operations, NOT another ComputerProvider interface.
 * The provider checks known-safe URL grants; the caller cannot grant itself a
 * weaker replay class. Each URL has a stable, separate durable action ID.
 */
export async function batchFetch(computer, identity, urls, { signal, replay_class = 'non_idempotent_effect', screenshots = false } = {}) {
  if (!Array.isArray(urls) || !urls.length || urls.length > 10 || new Set(urls).size !== urls.length
    || !['read_only', 'non_idempotent_effect'].includes(replay_class)) throw new Error('Invalid bounded browser batch.');
  const results = [];
  for (let index = 0; index < urls.length; index++) {
    if (signal?.aborted) break;
    const url = urls[index];
    const request_id = `batch-${createHash('sha256').update(JSON.stringify([identity.request_id, index, url])).digest('hex')}`;
    let result;
    try { result = await computer.execute({ ...identity, request_id }, { operation: 'browser.navigate', args: { url }, replay_class }, { signal }); }
    catch { result = { status: 'unavailable', reason: 'Browser request rejected before execution or unavailable. Inspect saved receipts.' }; }
    if (result.status === 'complete' && result.output?.failure) result = { ...result, status: 'failed', provider_status: 'complete' };
    if (result.status === 'complete' && !result.output?.failure && screenshots && !signal?.aborted) {
      result.screenshot = await computer.execute({ ...identity, request_id: `${request_id}:screenshot` },
        { operation: 'screenshot', args: { surface: 'browser', ...(result.output?.tab_id ? { target: result.output.tab_id } : {}) }, replay_class: 'read_only' }, { signal });
    }
    results.push({ url, request_id, ...result });
    // Uncertainty fences workspace effects. Do not pretend independent URLs
    // permit us to bypass that fence, even with newly generated request IDs.
    if (result.status === 'uncertain' || result.status === 'stopped') break;
  }
  return { results, cancelled: !!signal?.aborted, pending: urls.slice(results.length) };
}

/** Model output is data only. Provenance and advisory status are host supplied.
 * Missing fields remain null/empty; no conversion to Duffel quote/spend types.
 */
export function normalizeHotel(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a hotel object.');
  const fields = ['name', 'address', 'coords', 'displayed_price', 'currency', 'room_types', 'cancellation_text', 'rating', 'amenities'];
  if (Object.keys(value).some(k => !fields.includes(k))) throw new Error('Unexpected hotel extraction fields.');
  const text = (key, max = 2000) => {
    const v = value[key] ?? null;
    if (v !== null && (typeof v !== 'string' || !v.trim() || v.length > max)) throw new Error(`Invalid hotel ${key}.`);
    return v;
  };
  const list = key => {
    const v = value[key] ?? [];
    if (!Array.isArray(v) || v.length > 50 || v.some(x => typeof x !== 'string' || !x.trim() || x.length > 250)) throw new Error(`Invalid hotel ${key}.`);
    return v;
  };
  const coords = value.coords ?? null;
  if (coords !== null && (Object.keys(coords).sort().join() !== 'lat,lng' || !Number.isFinite(coords.lat)
    || !Number.isFinite(coords.lng) || Math.abs(coords.lat) > 90 || Math.abs(coords.lng) > 180)) throw new Error('Invalid hotel coordinates.');
  const rating = value.rating ?? null;
  if (rating !== null && (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 10)) throw new Error('Invalid hotel rating.');
  const currency = text('currency', 3);
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid hotel currency.');
  return { name: text('name', 500), address: text('address'), coords, displayed_price: text('displayed_price', 250), currency,
    room_types: list('room_types'), cancellation_text: text('cancellation_text'), rating, amenities: list('amenities'),
    source_url: source.source_url, fetched_at: source.fetched_at, advisory: true };
}
