// Command Cloud -> Dividia: a working example of YOUR SERVER.
//
// It shows the three rules of the integration:
//   1. Dividia gives you two values for each customer: a Customer ID and a customer secret.
//   2. You store them on your servers. Never on the customer's computer.
//   3. Your servers make every call to Dividia. The customer's computer never calls Dividia.
//
// Read it top to bottom. It has three parts:
//   PART 1  Your records      the customer, its sites and its scales, as your system stores them
//   PART 2  Your two calls    sendTicket() and getTicketPdf(): the only code that talks to Dividia
//   PART 3  Your endpoints    what your own application (the customer's browser) calls
//
// Node.js 18 or later. No packages.
//
// Run:
//   export DIVIDIA_CUSTOMER_ID='the Customer ID Dividia gave you'
//   export DIVIDIA_SECRET='whsec_...'          (the customer secret Dividia gave you)
//   node server.js --location <location.id> --scale <scaleId>
// then open http://localhost:8787
//
// Nothing about a real customer is written in this file. The Customer ID and the secret come from
// the two variables above; the site's location.id and the scale's scaleId come from the options:
//   node server.js --location <location.id> --scale <scaleId> [--location-name "<site name>"]
//
// Options:  --location <location.id>                 the site's location.id, as agreed with Dividia
//           --scale <scaleId>                        the scale's scaleId, as agreed with Dividia
//           --location-name "<name>"                 the site's name, for display
//           --port 8787                              the port this example listens on
//           --dividia https://api.cloud.dividia.net  Dividia's address (only Dividia changes this)
'use strict';

const http = require('http');
const crypto = require('crypto');

const args = process.argv.slice(2);
// An option's value: "--name value" or "--name=value". A value never starts with "--".
const option = (name, fallback) => {
  const joined = args.find((a) => a.startsWith(name + '='));
  if (joined) return joined.slice(name.length + 1) || fallback;
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
// How long to wait for Dividia before treating the request as "no answer".
const DIVIDIA_TIMEOUT_MS = 20000;
const PORT = Number(option('--port', '8787'));
const DIVIDIA = option('--dividia', 'https://api.cloud.dividia.net').replace(/\/+$/, '');

// =====================================================================================================
// PART 1  YOUR RECORDS
// In your system these are rows in your database. Here they are one object, so the shape is easy to see.
// =====================================================================================================
const CUSTOMERS = {
  // "acme" is YOUR key for the customer: whatever your system already uses.
  acme: {
    name: 'Acme Aggregates',
    // The two values Dividia gave you for this customer. They live here, on your server, and nowhere else.
    dividiaCustomerId: process.env.DIVIDIA_CUSTOMER_ID,   // sent as the Dividia-Customer-Id header
    dividiaSecret: process.env.DIVIDIA_SECRET,            // sent as Authorization: Bearer <secret>. Never leaves this server.
    // The customer's sites. location.id is the value agreed with Dividia for the site.
    sites: {
      'north-yard': {
        locationId: option('--location'),                    // required: the example will not start without it
        locationName: option('--location-name', 'North Yard'),
        // The site's scales. scaleId is the value agreed with Dividia for the scale.
        scales: {
          'scale-1': { scaleId: option('--scale'), name: 'Scale 1' },   // required too
        },
      },
    },
  },
};

// An error whose message is ours and safe to show the browser. Any other error's message is NOT
// shown: a library's message can quote the request it failed on, headers and secret included.
class ShownError extends Error {}

// Look a customer, site and scale up by YOUR keys. Only keys that are really in the records count
// (never an inherited name such as "constructor").
const own = (records, key) => (typeof key === 'string' && Object.hasOwn(records, key) ? records[key] : undefined);
function lookUp(customerKey, siteKey, scaleKey) {
  const customer = own(CUSTOMERS, customerKey);
  if (!customer) throw new ShownError(`Unknown customer "${customerKey}"`);
  const site = own(customer.sites, siteKey);
  if (!site) throw new ShownError(`Unknown site "${siteKey}" for ${customer.name}`);
  const scale = scaleKey === undefined ? undefined : own(site.scales, scaleKey);
  if (scaleKey !== undefined && !scale) throw new ShownError(`Unknown scale "${scaleKey}" at ${site.locationName}`);
  return { customer, site, scale };
}

// =====================================================================================================
// PART 2  YOUR TWO CALLS TO DIVIDIA
// These two functions are the whole integration. Both send the same two headers.
// =====================================================================================================

// The two headers every request to Dividia carries, for one customer.
function dividiaHeaders(customer) {
  return {
    'Dividia-Customer-Id': customer.dividiaCustomerId,
    'Authorization': 'Bearer ' + customer.dividiaSecret,   // the whole secret, including "whsec_"
  };
}

// Send one ticket. `ticket` is your ticket in the approved payload schema.
// Dividia's answers:
//   200 delivered | fallback | duplicate   Dividia has the ticket. Done.
//   200 failed                             location.id is not set up at Dividia. Do not resend.
//   400                                    the body is wrong; the message names the field. Fix, then send.
//   401                                    wrong Customer ID or secret. Stop and check both values.
//   429, 500, 503, or no answer            temporary. Send the SAME ticket again (same uniqueId).
async function sendTicket(customer, ticket) {
  const response = await fetch(DIVIDIA + '/sw/webhooks/cc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...dividiaHeaders(customer) },
    body: JSON.stringify(ticket),
    redirect: 'error',                                  // never follow a redirect: the headers go to Dividia only
    signal: AbortSignal.timeout(DIVIDIA_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.text() };
}

// Send a ticket, and send it again while the answer is temporary. A real system keeps the ticket in
// a queue and retries for much longer (for example 5 s, 30 s, 2 min, 10 min, then hourly for 24 h).
// The same uniqueId never creates a second ticket, so sending again is always safe.
async function sendTicketWithRetry(customer, ticket, trace) {
  const waits = [0, 2000, 5000];
  let last = { status: 0, body: 'No answer from Dividia' };
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt]) await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
    try {
      last = await sendTicket(customer, ticket);
    } catch (error) {
      // Fixed text, never error.message: a failed request's message can quote its headers.
      last = { status: 0, body: 'No answer from Dividia' };
    }
    const temporary = last.status === 0 || last.status === 429 || last.status >= 500;
    trace.push(`Dividia answered ${last.status || 'nothing'}${temporary && attempt < waits.length - 1 ? ' (temporary: sending the same ticket again)' : ''}`);
    if (!temporary) break;
  }
  return last;
}

// Get one ticket's PDF. Returns { status, contentType, bytes }.
// Dividia's answers:
//   200 application/pdf     the PDF. It has no photos until the site has recorded the weighment;
//                           ask again later for the complete PDF.
//   200 {"matches": 0}      Dividia has no such ticket at that location.
//   200 application/zip     the ticket number is on more than one transaction there: a ZIP of the PDFs.
//   400                     the request is wrong; the message says what.
//   401                     wrong Customer ID or secret.
//   403                     the location is not this customer's.
//   429                     too many requests; the Retry-After header says when to try again.
//   500, or no answer       temporary. Ask again.
async function getTicketPdf(customer, site, ticketNumber) {
  const query = new URLSearchParams({ locationId: site.locationId, ticket: String(ticketNumber) });
  const response = await fetch(DIVIDIA + '/sw/api/tickets/pdf?' + query, {
    headers: dividiaHeaders(customer),
    redirect: 'error',
    signal: AbortSignal.timeout(DIVIDIA_TIMEOUT_MS),
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

// =====================================================================================================
// PART 3  YOUR ENDPOINTS
// What your own application calls. The customer's browser talks to THESE, never to Dividia, and it
// sends your keys (customer, site, scale), never the Dividia values. Your real endpoints sit behind
// your own sign-in; this example has none, so it guards itself another way (see guard() below).
// The trace it returns shows the Customer ID, location.id and scaleId so you can follow each step;
// a real system has no reason to send those to a browser.
// =====================================================================================================

// A sample ticket, in the approved payload schema, for the example's "Send a ticket" button.
function sampleTicket(site, scale) {
  const gross = 70000 + Math.floor(Math.random() * 9000), tare = 26000 + Math.floor(Math.random() * 3000);
  const pound = (value) => ({ value, uom: 'lb' });
  return {
    uniqueId: crypto.randomUUID(),                                   // new for every ticket
    ticketNumber: String(100000000 + Math.floor(Math.random() * 899999999)),
    ticketDateTime: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    vehicle: { id: 'VEH-7908', name: 'Truck 218', autoId: 'AUTO-218', gross: pound(gross), tare: pound(tare), net: pound(gross - tare), maxGVW: pound(80000) },
    carrier: { id: 'CAR-1', name: 'Example Hauling' },
    customer: { id: 'CUS-1', name: 'Example Customer' },
    project: { id: 'PRJ-1', name: 'Example Project' },
    product: { id: 'PRD-766', name: 'Fill dirt', quantity: pound(gross - tare) },
    orderId: 'ORD-1',
    location: { id: site.locationId, name: site.locationName },      // picks the site at Dividia
    scaleId: scale.scaleId,                                          // picks the scale at Dividia
  };
}

// The request as it was sent, for the page's trace, with the secret hidden. The secret never goes
// to the browser, not even here.
function shown(method, url, customer, hasBody) {
  return [
    `${method} ${url}`,
    'Authorization: Bearer whsec_... (the secret, from your server; hidden here)',
    `Dividia-Customer-Id: ${customer.dividiaCustomerId}`,
    ...(hasBody ? ['Content-Type: application/json'] : []),
  ].join('\n');
}

function sendJson(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

async function readJson(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 100000) throw new Error('Request too large'); }
  return text ? JSON.parse(text) : {};
}

// This example has no sign-in, and it holds a real secret. So it answers only a browser that is
// looking at THIS page on THIS computer:
//   - the Host header must be localhost or 127.0.0.1 on this port (another name pointed at this
//     computer is refused);
//   - an Origin header, when the browser sends one, must be this page's own;
//   - a POST must be application/json, which a page on another site cannot send here.
// Your real endpoints use your own sign-in instead.
function guard(req) {
  const port = server.address().port;
  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (!hosts.includes(req.headers.host)) return 'This example answers only on localhost';
  const origin = req.headers.origin;
  if (origin !== undefined && !hosts.some((host) => origin === 'http://' + host)) return 'This example answers only its own page';
  if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) return 'Send application/json';
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    const refused = guard(req);
    if (refused) return sendJson(res, 403, { error: refused });
    const url = new URL(req.url, 'http://localhost');

    // The page. It may not be shown inside another site's page.
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' });
      return res.end(PAGE);
    }

    // Your records, for the page's lists: YOUR keys and names only. No Dividia value is sent.
    if (req.method === 'GET' && url.pathname === '/your-app/records') {
      return sendJson(res, 200, Object.entries(CUSTOMERS).map(([key, customer]) => ({
        key, name: customer.name,
        sites: Object.entries(customer.sites).map(([siteKey, site]) => ({
          key: siteKey, name: site.locationName,
          scales: Object.entries(site.scales).map(([scaleKey, scale]) => ({ key: scaleKey, name: scale.name })),
        })),
      })));
    }

    // "Send a ticket": the browser names the customer, site and scale by YOUR keys.
    if (req.method === 'POST' && url.pathname === '/your-app/tickets') {
      const asked = await readJson(req);
      const trace = [`The browser asked your server: send a ticket for customer "${asked.customer}", site "${asked.site}", scale "${asked.scale}"`];
      const { customer, site, scale } = lookUp(asked.customer, asked.site, asked.scale);
      trace.push(`Your server looked up its records: location.id "${site.locationId}", scaleId "${scale.scaleId}", and the Customer ID and secret for ${customer.name}`);
      const ticket = sampleTicket(site, scale);
      trace.push(`Your server called Dividia:\n${shown('POST', DIVIDIA + '/sw/webhooks/cc', customer, true)}`);
      const answer = await sendTicketWithRetry(customer, ticket, trace);
      trace.push('Your server answered the browser');
      return sendJson(res, 200, { trace, ticket, dividia: { status: answer.status, body: answer.body } });
    }

    // "Get a ticket's PDF": the browser names the customer and site by YOUR keys, and the ticket number.
    const pdfRoute = /^\/your-app\/tickets\/([^/]+)\/pdf$/.exec(url.pathname);
    if (req.method === 'GET' && pdfRoute) {
      const ticketNumber = decodeURIComponent(pdfRoute[1]);
      const trace = [`The browser asked your server: the PDF of ticket ${ticketNumber} for customer "${url.searchParams.get('customer')}", site "${url.searchParams.get('site')}"`];
      const { customer, site } = lookUp(url.searchParams.get('customer'), url.searchParams.get('site'));
      trace.push(`Your server looked up its records: location.id "${site.locationId}", and the Customer ID and secret for ${customer.name}`);
      const query = new URLSearchParams({ locationId: site.locationId, ticket: ticketNumber });
      trace.push(`Your server called Dividia:\n${shown('GET', DIVIDIA + '/sw/api/tickets/pdf?' + query, customer, false)}`);
      let answer;
      try {
        answer = await getTicketPdf(customer, site, ticketNumber);
      } catch (error) {
        answer = { status: 0, contentType: '', bytes: Buffer.from('No answer from Dividia') };   // fixed text, never error.message
      }
      const isPdf = answer.status === 200 && answer.contentType.startsWith('application/pdf');
      trace.push(answer.status ? `Dividia answered ${answer.status} ${answer.contentType}${isPdf ? `, ${answer.bytes.length} bytes` : ''}` : 'Dividia did not answer');
      trace.push(isPdf ? 'Your server served the PDF to the browser' : 'Your server told the browser there is no PDF');
      // The trace rides in a header so the body can be the PDF itself.
      const headers = { 'X-Example-Trace': encodeURIComponent(JSON.stringify(trace)), 'Cache-Control': 'no-store' };
      if (isPdf) {
        res.writeHead(200, { ...headers, 'Content-Type': 'application/pdf', 'Content-Length': answer.bytes.length });
        return res.end(answer.bytes);
      }
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      // Only text is passed on as text; anything else (a ZIP, say) is named, not dumped.
      const isText = /json|text/i.test(answer.contentType) || answer.status === 0;
      return res.end(JSON.stringify({ dividia: { status: answer.status, contentType: answer.contentType,
        body: isText ? answer.bytes.toString('utf8').slice(0, 2000) : `(${answer.bytes.length} bytes, not shown)` } }));
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    // Our own messages are shown; anything else is not (it could quote a request, secret included).
    sendJson(res, 400, { error: error instanceof ShownError ? error.message : 'Bad request' });
  }
});

// The example page. It knows YOUR keys and nothing else: open the browser's network view and look.
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your server, calling Dividia: example</title>
<style>
  body { margin:0; background:#f5f7fa; color:#1c2430; font:16px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .page { max-width:1100px; margin:0 auto; padding:22px 16px 48px; }
  h1 { font-size:24px; margin:0 0 4px; }
  .sub { color:#566173; margin:0 0 14px; }
  .rule { background:#e8f1fb; border:2px solid #0b5cad; border-radius:10px; padding:10px 16px; margin:0 0 14px; }
  .rule ol { margin:0; padding-left:20px; } .rule b { color:#0b5cad; }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:14px; align-items:start; }
  @media (max-width:820px) { .cols { grid-template-columns:1fr; } }
  .card { background:#fff; border:1px solid #d9dee6; border-radius:10px; padding:14px 16px; margin:0 0 14px; min-width:0; }
  h2 { font-size:17px; margin:0 0 8px; }
  label { display:block; font-size:13px; font-weight:600; color:#566173; margin:8px 0 2px; }
  select, input { font:inherit; width:100%; padding:7px 9px; border:1px solid #c5ccd6; border-radius:7px; background:#fff; box-sizing:border-box; }
  button { font:inherit; font-weight:600; border:0; border-radius:8px; padding:9px 14px; margin-top:12px; cursor:pointer; background:#0b5cad; color:#fff; }
  button:disabled { opacity:.6; cursor:wait; }
  .note { font-size:14px; color:#566173; margin:8px 0 0; }
  .flow { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin:2px 0 4px; font-size:13px; font-weight:600; }
  .box { border-radius:8px; padding:5px 8px; white-space:nowrap; } .you { background:#e9f4ec; color:#1d6b3a; } .cust { background:#f0ecf9; color:#55399a; } .div { background:#e8f1fb; color:#0b5cad; }
  ol.trace { margin:0; padding-left:22px; } ol.trace li { margin:6px 0; white-space:pre-wrap; overflow-wrap:anywhere; }
  pre { background:#0f1b2b; color:#e6edf5; padding:10px 12px; border-radius:8px; margin:8px 0 0; font:13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
  .verdict { border-left:4px solid; border-radius:0 8px 8px 0; padding:8px 12px; margin:8px 0 0; }
  .ok { background:#e9f4ec; border-color:#1d6b3a; } .warn { background:#fff6e0; border-color:#d9a521; } .bad { background:#fde8e8; border-color:#c0392b; }
  iframe { width:100%; height:520px; border:1px solid #d9dee6; border-radius:8px; margin-top:8px; background:#fff; }
</style>
</head>
<body>
<div class="page">
  <h1>Your server, calling Dividia</h1>
  <p class="sub">A working example of the Command Cloud side. This page stands in for your own application.</p>

  <div class="rule">
    <ol>
      <li><b>Dividia gives you two values for each customer.</b> They are in this example's server, not in this page.</li>
      <li><b>You store them on your servers.</b> This page never receives the secret.</li>
      <li><b>Your servers make every call to Dividia.</b> This page only calls the example server.</li>
    </ol>
  </div>

  <div class="cols">
    <div>
      <div class="card">
        <h2>1. Send a ticket</h2>
        <div class="flow"><span class="box cust">This page</span>&rarr;<span class="box you">Your server</span>&rarr;<span class="box div">Dividia</span></div>
        <label for="customer">Customer (your record)</label><select id="customer"></select>
        <label for="site">Site (your record)</label><select id="site"></select>
        <label for="scale">Scale (your record)</label><select id="scale"></select>
        <button id="send" type="button">Send a ticket</button>
        <p class="note">The page sends your keys only. Your server looks up the Customer ID, the secret, the location.id and the scaleId.</p>
      </div>
      <div class="card">
        <h2>2. Get the ticket's PDF</h2>
        <div class="flow"><span class="box cust">This page</span>&rarr;<span class="box you">Your server</span>&rarr;<span class="box div">Dividia</span>&rarr;<span class="box you">Your server</span>&rarr;<span class="box cust">This page</span></div>
        <label for="ticket">Ticket number (each send fills this in)</label><input id="ticket" spellcheck="false">
        <button id="pdf" type="button">Get the PDF</button>
        <p class="note">The PDF has no photos until the site has recorded the weighment. Ask again later for the complete PDF.</p>
      </div>
    </div>
    <div>
      <div class="card">
        <h2>What happened</h2>
        <div id="verdict"></div>
        <ol class="trace" id="trace"><li>Nothing yet. Press a button.</li></ol>
        <div id="detail"></div>
      </div>
    </div>
  </div>
</div>
<script>
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function text(tag, value, cls) { var e = document.createElement(tag); e.textContent = value; if (cls) e.className = cls; return e; }
  var records = [];

  function fill(select, items) {
    select.innerHTML = '';
    items.forEach(function (item) { var o = document.createElement('option'); o.value = item.key; o.textContent = item.name + '  (' + item.key + ')'; select.appendChild(o); });
  }
  function customerNow() { return records.filter(function (c) { return c.key === $('customer').value; })[0]; }
  function siteNow() { var c = customerNow(); return c && c.sites.filter(function (s) { return s.key === $('site').value; })[0]; }
  function refreshSites() { var c = customerNow(); fill($('site'), c ? c.sites : []); refreshScales(); }
  function refreshScales() { var s = siteNow(); fill($('scale'), s ? s.scales : []); }

  function show(trace, verdictClass, verdictText, detailText, pdfUrl) {
    $('trace').innerHTML = '';
    (trace || []).forEach(function (line) { $('trace').appendChild(text('li', line)); });
    $('verdict').innerHTML = '';
    if (verdictText) $('verdict').appendChild(text('div', verdictText, 'verdict ' + verdictClass));
    $('detail').innerHTML = '';
    if (detailText) $('detail').appendChild(text('pre', detailText));
    if (pdfUrl) { var f = document.createElement('iframe'); f.title = 'Ticket PDF'; f.src = pdfUrl; $('detail').appendChild(f); }
  }
  function busy(on) { $('send').disabled = on; $('pdf').disabled = on; }

  // What Dividia's answer to a ticket means.
  function ticketVerdict(status, body) {
    var j = null; try { j = JSON.parse(body); } catch (e) {}
    var state = j && j.status, reason = (j && (j.reason || j.error)) || '';
    if (status === 200 && state === 'delivered') return ['ok', 'Dividia has the ticket and delivered it to the site. Done.'];
    if (status === 200 && state === 'fallback') return ['ok', 'Dividia has the ticket. The site was not reached just now (' + reason + '). Done.'];
    if (status === 200 && state === 'duplicate') return ['ok', 'Dividia already had this uniqueId. Done.'];
    if (status === 200 && state === 'failed') return ['warn', 'Dividia does not have this location.id set up (' + reason + '). Do not resend.'];
    if (status === 400) return ['bad', 'The body is wrong: ' + reason + '. Fix it, then send.'];
    if (status === 401) return ['bad', 'Wrong Customer ID or secret (' + reason + '). Stop and check both values on your server.'];
    return ['warn', 'Temporary (HTTP ' + (status || 'no answer') + '). Send the same ticket again.'];
  }

  $('send').addEventListener('click', async function () {
    busy(true); show(['Asking your server...']);
    try {
      var response = await fetch('/your-app/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer: $('customer').value, site: $('site').value, scale: $('scale').value }) });
      var result = await response.json();
      if (result.error) { show([], 'bad', result.error); return; }
      $('ticket').value = result.ticket.ticketNumber;
      var v = ticketVerdict(result.dividia.status, result.dividia.body);
      show(result.trace, v[0], v[1], 'Dividia answered:\\nHTTP ' + result.dividia.status + '\\n' + result.dividia.body + '\\n\\nThe ticket your server sent:\\n' + JSON.stringify(result.ticket, null, 2));
    } catch (e) { show([], 'bad', 'Could not reach the example server: ' + e.message); }
    finally { busy(false); }
  });

  $('pdf').addEventListener('click', async function () {
    var ticket = $('ticket').value.trim();
    if (!ticket) { show([], 'bad', 'Fill in a ticket number, or send a ticket first.'); return; }
    busy(true); show(['Asking your server...']);
    try {
      var response = await fetch('/your-app/tickets/' + encodeURIComponent(ticket) + '/pdf?customer=' + encodeURIComponent($('customer').value) + '&site=' + encodeURIComponent($('site').value));
      var header = response.headers.get('X-Example-Trace');
      var trace = header ? JSON.parse(decodeURIComponent(header)) : [];
      if ((response.headers.get('Content-Type') || '').indexOf('application/pdf') === 0) {
        var blob = await response.blob();
        show(trace, 'ok', 'PDF received from your server (' + blob.size + ' bytes).', null, URL.createObjectURL(blob));
        return;
      }
      var result = await response.json();
      if (result.error) { show(trace, 'bad', result.error); return; }
      var status = result.dividia.status, noMatch = false;
      try { noMatch = JSON.parse(result.dividia.body).matches === 0; } catch (e) {}
      show(trace, status === 200 || status === 0 || status === 429 || status >= 500 ? 'warn' : 'bad',
        status === 200 && noMatch ? 'Dividia has no such ticket at that location.'
        : status === 200 ? 'Dividia answered with ' + (result.dividia.contentType || 'something that is not a PDF') + ', not one PDF (a ticket number on several transactions comes back as a ZIP).'
        : status === 0 ? 'Dividia did not answer. Ask again.'
        : status === 400 ? 'Dividia refused the request. The answer below says why.'
        : status >= 500 ? 'Temporary (HTTP ' + status + '). Ask again.'
        : status === 401 ? 'Wrong Customer ID or secret. Check both values on your server.' : status === 403 ? 'That location is not this customer\\'s.' : status === 429 ? 'Too many requests. Try again shortly.' : 'HTTP ' + status,
        status === 0 ? null : 'Dividia answered:\\nHTTP ' + status + '\\n' + result.dividia.body);
    } catch (e) { show([], 'bad', 'Could not reach the example server: ' + e.message); }
    finally { busy(false); }
  });

  $('customer').addEventListener('change', refreshSites);
  $('site').addEventListener('change', refreshScales);
  fetch('/your-app/records').then(function (r) { return r.json(); }).then(function (list) { records = list; fill($('customer'), records); refreshSites(); });
})();
</script>
</body>
</html>
`;

// Start. The example listens on this computer only (127.0.0.1): it has no sign-in of its own.
if (require.main === module) {
  const HOW = `  export DIVIDIA_CUSTOMER_ID='the Customer ID Dividia gave you'\n  export DIVIDIA_SECRET='whsec_...'\n  node server.js --location <location.id> --scale <scaleId>`;
  const stop = (problem) => { console.error(`${problem}\n\nRun it like this:\n${HOW}`); process.exit(1); };
  const missing = ['DIVIDIA_CUSTOMER_ID', 'DIVIDIA_SECRET'].filter((name) => !process.env[name]);
  if (missing.length) stop(`${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set.`);
  // The shapes Dividia issues. A value with a line break or a stray character is refused here,
  // before it can reach a request (the values themselves are never printed).
  if (!/^[\x21-\x7e]{1,100}$/.test(process.env.DIVIDIA_CUSTOMER_ID)) stop('DIVIDIA_CUSTOMER_ID is not a Customer ID: it has a space, a line break or another character that does not belong.');
  if (!/^whsec_[A-Za-z0-9+/=]{1,200}$/.test(process.env.DIVIDIA_SECRET)) stop('DIVIDIA_SECRET is not a customer secret: it starts whsec_ and has no space or line break.');
  // No placeholder is ever sent to Dividia: a ticket for a made-up site or scale is stored there and alerts Dividia.
  if (!option('--location')) stop('--location <location.id> is required: the site\'s location.id, as agreed with Dividia.');
  if (!option('--scale')) stop('--scale <scaleId> is required: the scale\'s scaleId, as agreed with Dividia.');
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) stop('--port must be a port number.');
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Example server ready: http://localhost:${PORT}\nIt calls Dividia at ${DIVIDIA}\nStop it with Ctrl+C.`);
  });
}

module.exports = { CUSTOMERS, lookUp, dividiaHeaders, sendTicket, getTicketPdf, sampleTicket, shown, guard, option, server };
