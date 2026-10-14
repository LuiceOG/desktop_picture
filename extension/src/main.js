// Runs in the page's own JavaScript world. Wraps window.fetch so that a comment
// request whose text is an armed marker is rewritten into a GIF comment.
//
// The content script never sends anything itself: it appends a marker such as
// [[gif:<tenorId>:<nonce>]] to the text in YouTube's comment box and lets the
// page submit it. That way the page supplies the auth headers, context and
// attestation. The hook strips the marker and adds the GIF in its place.
(() => {
  // sw.js also injects this file into tabs that were open before the install;
  // a page must not end up with two wrappers.
  const LOADED = Symbol.for('gcfy.hook');
  if (window[LOADED]) return;
  window[LOADED] = true;

  // Every endpoint a ytd-commentbox can submit to (comments, replies, edits,
  // channel posts). Only the two create endpoints are ever rewritten; a marker
  // heading anywhere else is blocked so it cannot be published as text.
  const API_URL = /\/youtubei\/v1\//;
  const WATCHED_URL = /\/youtubei\/v1\/(comment|backstage)\//;
  const CREATE_URL = /\/youtubei\/v1\/comment\/create_comment(_reply)?(\?|$)/;
  const MARKER = /\[\[gif:(\d{1,20}):([a-z0-9]{8,32})\]\]/;
  const ARM_TTL_MS = 3 * 60 * 1000;

  // nonce -> { id, expires }
  const armed = new Map();

  // At document_start the wrapper is in place before any of YouTube's code.
  // Injected into a page that has already loaded, it only works if YouTube
  // looks window.fetch up at call time, so it does not count as live until one
  // of YouTube's own API requests has come through it. Until then arming is
  // refused, and the content script never types a marker into the box.
  let live = document.readyState === 'loading';

  const toContent = (msg) => window.postMessage({ gcfy: 'to-content', ...msg }, location.origin);

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const msg = e.data;
    if (!msg || msg.gcfy !== 'to-main') return;
    if (msg.type === 'arm' && /^\d{1,20}$/.test(msg.id) && /^[a-z0-9]{8,32}$/.test(msg.nonce)) {
      if (!live) { toContent({ type: 'refused', nonce: msg.nonce }); return; }
      armed.set(msg.nonce, { id: msg.id, expires: Date.now() + ARM_TTL_MS });
      toContent({ type: 'armed', nonce: msg.nonce });
    } else if (msg.type === 'disarm') {
      armed.delete(msg.nonce);
    }
  });

  async function readBody(input, init) {
    const isRequest = input instanceof Request;
    // fetch(Request, init) uses init's body and headers when supplied.
    const headers = new Headers((init && init.headers) || (isRequest ? input.headers : {}));
    let buf;
    if (init && init.body != null) buf = await new Response(init.body).arrayBuffer();
    else if (isRequest) buf = await input.clone().arrayBuffer();
    else return null;
    // YouTube gzips request bodies between 500 bytes and 500 kB.
    const text = headers.get('content-encoding') === 'gzip'
      ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
      : new TextDecoder().decode(buf);
    return { headers, text };
  }

  function textOf(value) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    if (typeof value.simpleText === 'string') return value.simpleText;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.runs)) return value.runs.map((r) => typeof r.text === 'string' ? r.text : '').join('');
    return '';
  }

  function errorsIn(actions) {
    if (!Array.isArray(actions)) return [];
    return actions.flatMap((action) => {
      if (!action || typeof action !== 'object') return [];
      const error = action.showErrorAction && action.showErrorAction.errorMessage;
      const message = textOf(error && error.messageRenderer && error.messageRenderer.text) || textOf(error);
      return [message, ...errorsIn(action.commandExecutorCommand && action.commandExecutorCommand.commands)];
    }).filter(Boolean);
  }

  function reportResponse(response, json, nonce, url, tenorId, hasText) {
    const action = json && json.actionResult;
    const serverErrors = json ? [
      textOf(json.error && json.error.message),
      ...errorsIn(json.actions),
      ...errorsIn(json.onResponseReceivedActions),
      ...errorsIn(json.onResponseReceivedEndpoints),
    ].filter(Boolean) : [];
    const ok = response.ok && action && action.status === 'STATUS_SUCCEEDED' && !serverErrors.length;
    if (ok) { toContent({ type: 'result', nonce, ok: true, error: null }); return; }

    // INVALID_ARGUMENT and a missing actionResult do not identify a rating
    // problem. They also occur when YouTube restricts GIF posting or rejects
    // another part of the request. Keep its actual explanation visible.
    const message = [...new Set([...serverErrors, textOf(action && action.feedbackText)].filter(Boolean))].join(' ');
    const apiStatus = json && json.error && json.error.status;
    const detail = `HTTP ${response.status}${typeof apiStatus === 'string' ? `, ${apiStatus}` : ''}`;
    const rejected = (response.status >= 400 && response.status < 500)
      || serverErrors.length || (action && action.status === 'STATUS_FAILED');
    const error = rejected
      ? `YouTube rejected this GIF comment (${detail}).${message ? ` ${message}` : ''} Nothing was posted.`
      : `YouTube did not confirm this GIF comment (${detail}).${message ? ` ${message}` : ''} Check the comments before trying again.`;

    // Deliberately omit the request, headers, account data and response body.
    // These few fields let a bug report distinguish a rejection from an
    // unreadable response without exposing the user's comment or credentials.
    // Serialize explicitly: Chromium's extension error list otherwise renders
    // the useful diagnostic as just "[object Object]".
    console.warn('Desktop GIFs: comment not confirmed', JSON.stringify({
      endpoint: CREATE_URL.test(url) && /create_comment_reply(\?|$)/.test(url) ? 'create_comment_reply' : 'create_comment',
      tenorId,
      hasText,
      httpStatus: response.status,
      apiStatus: typeof apiStatus === 'string' ? apiStatus : null,
      actionStatus: action && typeof action.status === 'string' ? action.status : null,
      responseReadable: json !== null,
      message,
    }));
    toContent({ type: 'result', nonce, ok: false, error });
  }

  const originalFetch = window.fetch;

  window.fetch = function (input, init) {
    let url = '';
    try {
      url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    } catch (e) { /* fall through to the original fetch */ }
    if (!live && API_URL.test(url)) live = true;
    if (!WATCHED_URL.test(url)) return originalFetch.apply(this, arguments);
    return handleWatched.call(this, url, input, init, arguments);
  };

  async function handleWatched(url, input, init, originalArgs) {
    let parsed = null;
    try {
      parsed = await readBody(input, init);
    } catch (e) { /* a body we cannot read: leave the request alone */ }

    const match = parsed && parsed.text.match(MARKER);
    if (!match) return originalFetch.apply(this, originalArgs);

    // From here on a marker is present, so the original request must never be
    // sent: it would publish the marker as visible text.
    const [whole, id, nonce] = match;
    const entry = armed.get(nonce);
    armed.delete(nonce);

    let body = null;
    try { body = JSON.parse(parsed.text); } catch (e) { /* handled below */ }
    // The marker sits at the very end of the comment; anything before it is
    // the user's own text and is posted alongside the GIF.
    const full = body && typeof body.commentText === 'string' ? body.commentText.trim() : '';
    const ownText = full.endsWith(whole) ? full.slice(0, -whole.length).trim() : null;
    const valid = body && CREATE_URL.test(url)
      && ownText !== null && !MARKER.test(ownText)
      && entry && entry.id === id && entry.expires >= Date.now();
    if (!valid) {
      toContent({ type: 'result', nonce, ok: false, error: 'This box cannot take a GIF, or the request expired. Nothing was posted.' });
      throw new TypeError('GIF comment marker blocked');
    }

    toContent({ type: 'seen', nonce });
    let response;
    try {
      if (ownText) body.commentText = ownText;
      else delete body.commentText;
      body.tenorId = id;
      const headers = parsed.headers;
      headers.delete('content-encoding');
      const payload = JSON.stringify(body);
      response = input instanceof Request
        ? await originalFetch.call(this, new Request(input, { ...init, body: payload, headers }))
        : await originalFetch.call(this, input, { ...init, body: payload, headers });
    } catch (e) {
      toContent({ type: 'result', nonce, ok: false, error: 'The request could not be sent. Nothing was posted.' });
      throw e;
    }

    let json = null;
    try { json = await response.clone().json(); } catch (e) { /* an unreadable response does not confirm a post */ }
    reportResponse(response, json, nonce, url, id, !!ownText);
    return response;
  }
})();
