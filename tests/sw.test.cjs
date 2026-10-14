const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../extension/src/sw.js'), 'utf8');
const id = '7993045760456588950';
const post = (rating = 'G') => ({
  id, content_rating: rating, content_description: 'Selected GIF',
  flags: [], media_formats: { tinygif: { url: 'https://media.tenor.com/fixture/selected.gif', dims: [120, 80] } },
});

function worker(results, apiStatus = 200) {
  const calls = [];
  const settings = Buffer.from(JSON.stringify({ API_V2_KEY: 'fixture-key', API_V2_CLIENT_KEY: 'fixture-client' })).toString('base64');
  const html = `<script id="store-cache" type="text/x-cache">{}</script><script id="data" type="text/x-cache">${settings}</script>`;
  const context = vm.createContext({
    chrome: { runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} } } },
    URL, URLSearchParams, atob, AbortSignal,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url === 'https://tenor.com/') return { ok: true, url, text: async () => html };
      return { ok: apiStatus === 200, status: apiStatus, json: async () => ({ results }) };
    },
  });
  vm.runInContext(source, context);
  return { check: () => context.handle({ type: 'check', id }), calls };
}

test('selected G-rated IDs get a verified result even when a favorite has no rating metadata', async () => {
  const w = worker([post()]);
  const checked = await w.check();
  assert.equal(checked[0].id, id);
  assert.equal(checked[0].contentRating, 'G');
  const url = new URL(w.calls[1].url);
  assert.equal(url.pathname, '/v2/posts');
  assert.equal(url.searchParams.get('ids'), id);
  assert.equal(url.searchParams.get('contentfilter'), 'off');
  assert.equal(w.calls[1].init.credentials, 'omit');
});

for (const rating of ['PG', 'PG-13', 'R']) {
  test(`${rating}-rated selections are rejected before posting`, async () => {
    await assert.rejects(worker([post(rating)]).check(), new RegExp(`rated ${rating}`));
  });
}

test('missing ratings are never treated as verified G', async () => {
  const item = post();
  delete item.content_rating;
  await assert.rejects(worker([item]).check(), /did not return a rating/);
});

test('a response for another ID cannot verify the selected GIF', async () => {
  await assert.rejects(worker([{ ...post(), id: '12345678' }]).check(), /could not verify this GIF/);
});

test('stickers and missing GIF formats do not pass the posting check', async () => {
  await assert.rejects(worker([{ ...post(), flags: ['sticker'] }]).check(), /could not verify this GIF/);
  await assert.rejects(worker([{ ...post(), media_formats: {} }]).check(), /could not verify this GIF/);
});

test('API failure is surfaced instead of assuming a suitable rating', async () => {
  await assert.rejects(worker([], 503).check(), /Tenor returned HTTP 503/);
});
