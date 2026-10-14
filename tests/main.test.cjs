const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.GIF_HOOK_SOURCE || path.join(__dirname, '../extension/src/main.js'), 'utf8');
const origin = 'https://www.youtube.com';
const create = `${origin}/youtubei/v1/comment/create_comment?prettyPrint=false`;
const id = '13723327785995541767';
const nonce = 'regression123456';
const marker = `[[gif:${id}:${nonce}]]`;

function hook(reply = { actionResult: { status: 'STATUS_SUCCEEDED' } }, status = 200) {
  const messages = [];
  const requests = [];
  const warnings = [];
  let onMessage;
  const response = new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status });
  const window = {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return response;
    },
    addEventListener: (type, listener) => { if (type === 'message') onMessage = listener; },
    postMessage: (message) => messages.push(message),
  };
  vm.runInNewContext(source, {
    window, location: { origin }, document: { readyState: 'loading' },
    Request, Response, Headers, Blob, DecompressionStream, TextDecoder,
    console: { warn: (...args) => warnings.push(args) },
  });
  return {
    window, response, requests, messages, warnings,
    arm: () => onMessage({ source: window, origin, data: { gcfy: 'to-main', type: 'arm', id, nonce } }),
    result: () => messages.findLast((message) => message.type === 'result'),
    send: (text = `hello ${marker}`, url = create) => window.fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB' } }, createCommentParams: 'original-params', commentText: text, botguardResponse: 'page-attestation' }),
    }),
  };
}

test('a confirmed post strips the marker, retains text and page attestation, and returns the original response', async () => {
  const h = hook();
  h.arm();
  assert.equal(await h.send(), h.response);
  const body = await h.requests[0].json();
  assert.equal(body.commentText, 'hello');
  assert.equal(body.tenorId, id);
  assert.equal(body.createCommentParams, 'original-params');
  assert.equal(body.botguardResponse, 'page-attestation');
  assert.equal(body.context.client.clientName, 'WEB');
  assert.equal(h.result().ok, true);
  assert.equal(h.warnings.length, 0);
  assert.equal((await h.response.json()).actionResult.status, 'STATUS_SUCCEEDED');
});

test('GIF-only replies use the reply endpoint with no marker text', async () => {
  const h = hook();
  h.arm();
  await h.send(marker, `${origin}/youtubei/v1/comment/create_comment_reply`);
  const body = await h.requests[0].json();
  assert.equal(body.tenorId, id);
  assert.equal('commentText' in body, false);
  assert.equal(h.result().ok, true);
});

test('HTTP 200 showErrorAction keeps the actual YouTube explanation', async () => {
  const h = hook({ actions: [{ showErrorAction: { errorMessage: { messageRenderer: { text: { runs: [{ text: 'GIF comments are ' }, { text: 'not available for this account.' }] } } } } }] });
  h.arm();
  await h.send();
  assert.equal(h.result().ok, false);
  assert.match(h.result().error, /GIF comments are not available for this account\./);
  assert.match(h.result().error, /HTTP 200/);
  assert.doesNotMatch(h.result().error, /different one|rates G/);
});

test('INVALID_ARGUMENT keeps its API message instead of asserting a rating problem', async () => {
  const h = hook({ error: { status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' } }, 400);
  h.arm();
  await h.send();
  assert.equal(h.result().ok, false);
  assert.match(h.result().error, /HTTP 400, INVALID_ARGUMENT/);
  assert.match(h.result().error, /Request contains an invalid argument/);
  assert.doesNotMatch(h.result().error, /different one|rates G/);
});

test('nested response commands expose their error text', async () => {
  const h = hook({ onResponseReceivedEndpoints: [{ commandExecutorCommand: { commands: [{ showErrorAction: { errorMessage: { messageRenderer: { text: { simpleText: 'Please sign in again.' } } } } }] } }] });
  h.arm();
  await h.send();
  assert.match(h.result().error, /Please sign in again\./);
});

test('explicit failure keeps action feedback', async () => {
  const h = hook({ actionResult: { status: 'STATUS_FAILED', feedbackText: { runs: [{ text: 'Comments are disabled.' }] } } });
  h.arm();
  await h.send();
  assert.equal(h.result().ok, false);
  assert.match(h.result().error, /Comments are disabled\./);
});

for (const [name, reply] of [['HTML', '<html>Service unavailable</html>'], ['empty JSON', {}], ['null JSON', null]]) {
  test(`HTTP 200 with ${name} does not confirm a post or invite a blind retry`, async () => {
    const h = hook(reply);
    h.arm();
    await h.send();
    assert.equal(h.result().ok, false);
    assert.match(h.result().error, /Check the comments before trying again/);
    assert.doesNotMatch(h.result().error, /Nothing was posted/);
  });
}

test('an error action takes precedence over a success status', async () => {
  const h = hook({ actionResult: { status: 'STATUS_SUCCEEDED' }, actions: [{ showErrorAction: { errorMessage: { simpleText: 'Posting was rejected.' } } }] });
  h.arm();
  await h.send();
  assert.equal(h.result().ok, false);
  assert.match(h.result().error, /Posting was rejected/);
});

test('an unreadable server failure leaves the posting outcome uncertain', async () => {
  const h = hook('Service unavailable', 503);
  h.arm();
  await h.send();
  assert.equal(h.result().ok, false);
  assert.match(h.result().error, /HTTP 503/);
  assert.match(h.result().error, /Check the comments before trying again/);
  assert.doesNotMatch(h.result().error, /Nothing was posted/);
});

test('diagnostics omit the comment, request headers, attestation and response data', async () => {
  const h = hook({ error: { status: 'PERMISSION_DENIED', message: 'Access denied.' }, privateAccountData: 'private-response-data' }, 403);
  h.arm();
  await h.send(`private-comment-text ${marker}`);
  assert.equal(h.warnings.length, 1);
  assert.equal(typeof h.warnings[0][1], 'string');
  const detail = JSON.parse(h.warnings[0][1]);
  assert.equal(detail.tenorId, id);
  assert.equal(detail.hasText, true);
  assert.equal(detail.endpoint, 'create_comment');
  const diagnostics = JSON.stringify(h.warnings);
  assert.match(diagnostics, /PERMISSION_DENIED/);
  assert.doesNotMatch(diagnostics, /private-comment-text|page-attestation|private-response-data|original-params/);
});

test('Request init overrides are read and preserved during rewriting', async () => {
  const h = hook();
  h.arm();
  const original = new Request(create, {
    method: 'POST', headers: { 'X-Test': 'original' }, body: JSON.stringify({ commentText: 'old body' }),
  });
  const controller = new AbortController();
  await h.window.fetch(original, {
    headers: { 'Content-Type': 'application/json', 'X-Test': 'override' },
    body: JSON.stringify({ commentText: `new body ${marker}` }),
    credentials: 'include', signal: controller.signal,
  });
  assert.equal(h.requests[0].headers.get('X-Test'), 'override');
  assert.equal(h.requests[0].credentials, 'include');
  const body = await h.requests[0].json();
  assert.equal(body.commentText, 'new body');
  assert.equal(body.tenorId, id);
  controller.abort();
  assert.equal(h.requests[0].signal.aborted, true);
});

test('gzip requests are decoded and rewritten as uncompressed JSON', async () => {
  const h = hook();
  h.arm();
  const body = await new Response(new Blob([JSON.stringify({ commentText: `hello ${marker}` })]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  await h.window.fetch(create, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body });
  assert.equal(h.requests[0].headers.has('Content-Encoding'), false);
  assert.equal((await h.requests[0].json()).tenorId, id);
  assert.equal(h.result().ok, true);
});

test('ordinary comments pass through without modification', async () => {
  const h = hook();
  await h.send('ordinary comment');
  assert.equal((await h.requests[0].json()).commentText, 'ordinary comment');
  assert.equal(h.messages.length, 0);
});

test('unarmed, reused and unsupported markers never reach YouTube', async () => {
  const unarmed = hook();
  await assert.rejects(unarmed.send(), /marker blocked/);
  assert.equal(unarmed.requests.length, 0);

  const reused = hook();
  reused.arm();
  await reused.send();
  await assert.rejects(reused.send(), /marker blocked/);
  assert.equal(reused.requests.length, 1);

  const edit = hook();
  edit.arm();
  await assert.rejects(edit.send(marker, `${origin}/youtubei/v1/comment/update_comment`), /marker blocked/);
  assert.equal(edit.requests.length, 0);
});
