import { readFile } from 'node:fs/promises';
import { CRAWL4AI_VERSION } from '../../src/crawl4ai-engine.mjs';
import { FakeComputerBackend } from './fake-computer.mjs';

export const urls = ['https://hotels.example/css', 'https://hotels.example/xpath', 'https://hotels.example/unknown'];
// Valid tiny PNG fixture, not a screenshot of a real hotel or live browser.
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWQAAAABJRU5ErkJggg==', 'base64');
const timestamp = '2026-10-21T12:00:00Z';

/** Offline transport fixture. Real crawl4ai processors and mocked CDP attachment
 * are exercised separately in browser-engine/test_engine.py. */
export class BrowserServiceFixture {
  constructor() { this.calls = []; this.version = CRAWL4AI_VERSION; this.disconnected = false; this.current = urls[0]; }
  async run(argv, { input }) {
    const { endpoint, body } = JSON.parse(input);
    if (argv[0] !== 'exec' || argv.slice(2).join(' ') !== 'bun /opt/burrow-browser/relay.mjs') throw new Error('Unexpected transport command');
    if (this.disconnected) throw new Error('Lost ImOrb response after write');
    if (endpoint === '/status') return JSON.stringify({ ok: true, data: { state: 'ready', crawl4ai_version: this.version, binding: this.binding ?? body.allocation } });
    if (endpoint === '/cancel') { this.cancelled = body.identity; return JSON.stringify({ ok: true, data: { completed: false, rollback: false } }); }
    this.calls.push(body);
    const { identity, action } = body;
    if (action.operation === 'browser.navigate') {
      this.current = action.args.url;
      if (this.afterNavigate) await this.afterNavigate(body);
      if (this.loseAfterNavigate) { this.disconnected = true; throw new Error('Navigation committed; acknowledgement lost'); }
    }
    if (this.current === 'https://hotels.example/missing') return JSON.stringify({ ok: true, data: { failure: { code: 'http_status', status: 404 }, artifacts: [], advisory: true } });
    const fixture = this.current.split('/').at(-1);
    const html = await readFile(new URL(`../../browser-engine/fixtures/${fixture}.html`, import.meta.url), 'utf8');
    const markdown = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const extraction = { path: fixture === 'unknown' ? 'llm_required' : fixture };
    const hotel = fixture === 'unknown' ? null : {
      name: fixture === 'css' ? 'Shibuya Lantern Hotel (fictional)' : 'Shibuya Cedar Stay (fictional)',
      address: fixture === 'css' ? '1 Fiction Lane, Shibuya, Tokyo' : '2 Imaginary Walk, Shibuya, Tokyo',
      coords: null, displayed_price: fixture === 'css' ? '18,500 per night' : '22,000 per night', currency: 'JPY',
      cancellation_text: fixture === 'css' ? 'Free cancellation until 48 hours before arrival' : 'Non-refundable example rate',
      rating: fixture === 'css' ? 8.7 : 9.1, room_types: [], amenities: [], source_url: this.current, fetched_at: timestamp, advisory: true,
    };
    const artifact = (kind, media_type, content) => ({ identity, kind, media_type, source_url: this.current, fetched_at: timestamp,
      ...(kind === 'screenshot' ? { base64: png.toString('base64') } : { content }) });
    const data = action.operation === 'screenshot'
      ? { artifacts: [artifact('screenshot', 'image/png')], source_url: this.current, fetched_at: timestamp }
      : { markdown, hotel, extraction, tab_id: 'engine', source_url: this.current, fetched_at: timestamp,
        artifacts: [artifact('markdown', 'text/markdown', markdown), artifact('json', 'application/json', JSON.stringify(hotel))] };
    this.mutate?.(data);
    return JSON.stringify({ ok: true, data });
  }
}

export function engineBackend(engine) {
  const backend = new FakeComputerBackend();
  backend.status = a => engine.status(a);
  backend.execute = (...args) => engine.execute(...args);
  backend.cancel = (...args) => engine.cancel(...args);
  return backend;
}
