// Command Cloud -> Dividia: a working example of YOUR SERVER.
//
// It shows the three rules of the integration:
//   1. Dividia gives you two values for each customer: a Customer ID and a customer secret.
//   2. You store them on your servers. Never on the customer's computer.
//   3. Your servers make every call to Dividia. The customer's computer never calls Dividia.
//
// Read it top to bottom. It has three parts:
//   PART 1  The values        the Customer ID, the secret, and the ticket's site and scale: all on the server
//   PART 2  Your two calls    sendTicket() and getTicketPdf(): the only code that talks to Dividia
//   PART 3  The tester        the page's two buttons call these; in your system your own code does
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
// PART 1  THE VALUES, ON YOUR SERVER
// Everything a request to Dividia needs is here, on the server. Nothing comes from a browser.
// In your system: the Customer ID and the secret are stored against the customer in your database,
// and location.id, location.name and scaleId arrive with each ticket.
// =====================================================================================================
const SETUP = {
  // The two values Dividia gave Command for this customer. Store them before the customer's first ticket.
  dividiaCustomerId: process.env.DIVIDIA_CUSTOMER_ID,   // sent as the Dividia-Customer-Id header
  dividiaSecret: process.env.DIVIDIA_SECRET,            // sent as Authorization: Bearer <secret>. Never leaves this server.
  // The site and the scale this example sends tickets for, fixed when the example is started.
  locationId: option('--location'),                     // sent in the body as location.id. Picks the site.
  locationName: option('--location-name', 'North Yard'),// sent in the body as location.name.
  scaleId: option('--scale'),                           // sent in the body as scaleId. Picks the scale.
};

// An error whose message is ours and safe to show the browser. Any other error's message is NOT
// shown: a library's message can quote the request it failed on, headers and secret included.
class ShownError extends Error {}

// =====================================================================================================
// PART 2  YOUR TWO CALLS TO DIVIDIA
// These two functions are the whole integration. Both send the same two headers.
// =====================================================================================================

// The two headers every request to Dividia carries.
function dividiaHeaders(setup) {
  return {
    'Dividia-Customer-Id': setup.dividiaCustomerId,
    'Authorization': 'Bearer ' + setup.dividiaSecret,   // the whole secret, including "whsec_"
  };
}

// Send one ticket. `ticket` is your ticket in the approved payload schema.
// Dividia's answers:
//   200 delivered | fallback | duplicate   Dividia has the ticket. Done.
//   200 failed                             location.id is not set up at Dividia. Do not resend.
//   400                                    the body is wrong; the message names the field. Fix, then send.
//   401                                    wrong Customer ID or secret. Stop and check both values.
//   429, 500, 503, or no answer            temporary. Send the SAME ticket again (same uniqueId).
async function sendTicket(setup, ticket) {
  const response = await fetch(DIVIDIA + '/sw/webhooks/cc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...dividiaHeaders(setup) },
    body: JSON.stringify(ticket),
    redirect: 'error',                                  // never follow a redirect: the headers go to Dividia only
    signal: AbortSignal.timeout(DIVIDIA_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.text() };
}

// Send a ticket, and send it again while the answer is temporary. A real system keeps the ticket in
// a queue and retries for much longer (for example 5 s, 30 s, 2 min, 10 min, then hourly for 24 h).
// The same uniqueId never creates a second ticket, so sending again is always safe.
async function sendTicketWithRetry(setup, ticket, trace) {
  const waits = [0, 2000, 5000];
  let last = { status: 0, body: 'No answer from Dividia' };
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt]) await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
    try {
      last = await sendTicket(setup, ticket);
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
async function getTicketPdf(setup, ticketNumber) {
  const query = new URLSearchParams({ locationId: setup.locationId, ticket: String(ticketNumber) });
  const response = await fetch(DIVIDIA + '/sw/api/tickets/pdf?' + query, {
    headers: dividiaHeaders(setup),
    redirect: 'error',
    signal: AbortSignal.timeout(DIVIDIA_TIMEOUT_MS),
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    fileName: fileNameOf(response.headers.get('content-disposition'), ticketNumber),
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

// Dividia names the PDF in its Content-Disposition header: <site number>-<location.id>-ticket_<ticket number>.pdf
// Pass that name on, or give the file your own name. Without a name the browser makes one up.
// Only plain file-name characters are kept, so the name is safe to put in a header of your own.
function fileNameOf(contentDisposition, ticketNumber) {
  const match = /filename="([^"]+)"/i.exec(contentDisposition || '');
  const name = (match ? match[1] : '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return /\.pdf$/i.test(name) ? name : `ticket_${String(ticketNumber).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)}.pdf`;
}

// =====================================================================================================
// PART 3  THE TESTER
// The page's two buttons call these. They exist only so you can watch the two calls happen. The
// browser sends nothing but "send a ticket" and a ticket number: every value comes from PART 1.
// In your system there is no page: your own code calls sendTicket() and getTicketPdf().
// The example has no sign-in, so it guards itself another way (see guard() below).
// The trace it returns shows the ticket's location.id and scaleId so you can follow each step. It
// never shows the Customer ID or the secret: those two stay on the server.
// =====================================================================================================

// A sample ticket, in the approved payload schema, for the example's "Send a ticket" button.
function sampleTicket(setup) {
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
    location: { id: setup.locationId, name: setup.locationName },      // picks the site at Dividia
    scaleId: setup.scaleId,                                          // picks the scale at Dividia
  };
}

// The request as it was sent, for the page's trace, with both header values hidden. The Customer ID
// and the secret never go to the browser, not even here.
function shown(method, url, hasBody) {
  return [
    `${method} ${url}`,
    'Authorization: Bearer whsec_... (the secret, from your server; hidden here)',
    'Dividia-Customer-Id: ... (the Customer ID, from your server; hidden here)',
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

    // What the page shows as fixed values: the site and scale this server was started with.
    // Never the Customer ID or the secret.
    if (req.method === 'GET' && url.pathname === '/tester/setup') {
      return sendJson(res, 200, { dividiaUrl: DIVIDIA, locationId: SETUP.locationId, locationName: SETUP.locationName, scaleId: SETUP.scaleId });
    }

    // "Send a ticket": the page only says "send one". Every value is the server's.
    if (req.method === 'POST' && url.pathname === '/tester/tickets') {
      const trace = ['The page asked your server to send a ticket. It sent no values.'];
      const ticket = sampleTicket(SETUP);
      trace.push(`Your server made the ticket: location.id "${SETUP.locationId}", location.name "${SETUP.locationName}", scaleId "${SETUP.scaleId}"`);
      trace.push('Your server took the Customer ID and the secret from its own records');
      trace.push(`Your server called Dividia:\n${shown('POST', DIVIDIA + '/sw/webhooks/cc', true)}`);
      const answer = await sendTicketWithRetry(SETUP, ticket, trace);
      trace.push('Your server answered the page');
      return sendJson(res, 200, { trace, ticket, dividia: { status: answer.status, body: answer.body } });
    }

    // "Get a ticket's PDF": the page sends the ticket number only.
    const pdfRoute = /^\/tester\/tickets\/([^/]+)\/pdf$/.exec(url.pathname);
    if (req.method === 'GET' && pdfRoute) {
      const ticketNumber = decodeURIComponent(pdfRoute[1]);
      const trace = [`The page asked your server for the PDF of ticket ${ticketNumber}. It sent no other value.`];
      trace.push(`Your server used the ticket's location.id "${SETUP.locationId}", and took the Customer ID and the secret from its own records`);
      const query = new URLSearchParams({ locationId: SETUP.locationId, ticket: ticketNumber });
      trace.push(`Your server called Dividia:\n${shown('GET', DIVIDIA + '/sw/api/tickets/pdf?' + query, false)}`);
      let answer;
      try {
        answer = await getTicketPdf(SETUP, ticketNumber);
      } catch (error) {
        answer = { status: 0, contentType: '', fileName: '', bytes: Buffer.from('No answer from Dividia') };   // fixed text, never error.message
      }
      const isPdf = answer.status === 200 && answer.contentType.startsWith('application/pdf');
      trace.push(answer.status ? `Dividia answered ${answer.status} ${answer.contentType}${isPdf ? `, ${answer.bytes.length} bytes` : ''}` : 'Dividia did not answer');
      trace.push(isPdf ? `Your server served the PDF to the page, with the file name Dividia gave it: ${answer.fileName}` : 'Your server told the page there is no PDF');
      // The trace rides in a header so the body can be the PDF itself.
      const headers = { 'X-Example-Trace': encodeURIComponent(JSON.stringify(trace)), 'Cache-Control': 'no-store' };
      if (isPdf) {
        res.writeHead(200, { ...headers, 'Content-Type': 'application/pdf', 'Content-Length': answer.bytes.length,
          'Content-Disposition': `inline; filename="${answer.fileName}"` });
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
  .legend { display:flex; flex-wrap:wrap; gap:8px 18px; font-size:14px; margin:0 0 4px; }
  .chip { display:inline-block; width:12px; height:12px; border-radius:3px; margin-right:6px; vertical-align:-1px; }
  .chip.rec { background:#1d6b3a; } .chip.tic { background:#0b5cad; }
  pre .rec { color:#8fe0a8; font-weight:600; } pre .tic { color:#8cc4ff; font-weight:600; } pre .why { color:#9aa7b8; }
  table.fixed { border-collapse:collapse; margin:8px 0 0; width:100%; } table.fixed th { text-align:left; font-size:13px; color:#566173; padding:6px 14px 6px 0; border-bottom:1px solid #d9dee6; } table.fixed td { padding:7px 14px 7px 0; border-bottom:1px solid #eef1f5; overflow-wrap:anywhere; vertical-align:top; } table.fixed td.rec { color:#1d6b3a; font-weight:600; } table.fixed td.tic { color:#0b5cad; font-weight:600; } code { font:13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:#eef1f5; padding:1px 4px; border-radius:4px; } .rule code, h2 code { background:none; padding:0; font-size:inherit; }
  h3 { font-size:14px; margin:10px 0 0; color:#566173; }
  iframe { width:100%; height:520px; border:1px solid #d9dee6; border-radius:8px; margin-top:8px; background:#fff; }
</style>
</head>
<body>
<div class="page">
  <h1>Command Cloud to Dividia: tester</h1>
  <p class="sub">This page is served by <code>server.js</code>, the program you started in your terminal. <b><code>server.js</code> is "your server":</b> it holds every value and it makes the calls to Dividia. This page holds nothing. It has two buttons that tell <code>server.js</code> to make a call, so you can watch it happen.</p>
  <p class="sub"><b><code>server.js</code> is test code that stands in for your backend service.</b> It is not something to deploy. The real integration is the same two calls, <code>sendTicket()</code> and <code>getTicketPdf()</code>, written inside your own backend.</p>

  <div class="rule">
    <b>In your system</b>
    <ol>
      <li><b>Dividia gives Command two values for each customer:</b> a Customer ID and a customer secret, when the customer is set up in ScaleWatcher Cloud. The customer does not get them.</li>
      <li><b>You store them on your servers</b> before that customer's first ticket.</li>
      <li><b>Your servers make every call to Dividia.</b> No browser takes part. The site and the scale come with each ticket.</li>
    </ol>
  </div>

  <div class="card">
    <h2>1. The values, in <code>server.js</code></h2>
    <p class="note">You set these when you started <code>server.js</code>. The page cannot change them. This is how it was started:</p>
    <pre id="startedWith"></pre>
    <p class="note">To use other values, stop <code>server.js</code> (Ctrl+C in its terminal) and start it again. Setting it up is described in <code>README.md</code>, in the same folder as <code>server.js</code>.</p>
    <table class="fixed">
      <tr><th>Value</th><th>Now</th><th>Set with</th><th>Sent to Dividia as</th><th>In your system it comes from</th></tr>
      <tr><td>Customer ID</td><td>not shown</td><td><code>DIVIDIA_CUSTOMER_ID</code></td><td class="rec">header <code>Dividia-Customer-Id</code></td><td>your record of the customer</td></tr>
      <tr><td>Customer secret</td><td>not shown</td><td><code>DIVIDIA_SECRET</code></td><td class="rec">header <code>Authorization: Bearer</code></td><td>your record of the customer</td></tr>
      <tr><td>Site id</td><td id="vLocationId"></td><td><code>--location</code></td><td class="tic">body <code>location.id</code></td><td>the ticket</td></tr>
      <tr><td>Site name</td><td id="vLocationName"></td><td><code>--location-name</code></td><td class="tic">body <code>location.name</code></td><td>the ticket</td></tr>
      <tr><td>Scale id</td><td id="vScaleId"></td><td><code>--scale</code></td><td class="tic">body <code>scaleId</code></td><td>the ticket</td></tr>
    </table>
  </div>

  <div class="card">
    <h2>2. The two requests <code>server.js</code> sends to Dividia</h2>
    <div class="legend">
      <span><span class="chip rec"></span>The two headers: from your record of the customer.</span>
      <span><span class="chip tic"></span>The site and the scale: from the ticket.</span>
    </div>
    <div class="cols">
      <div><h3>Send a ticket</h3><pre id="requestTicket"></pre></div>
      <div><h3>Get the ticket's PDF</h3><pre id="requestPdf"></pre></div>
    </div>
  </div>

  <div class="card">
    <h2>3. Try it</h2>
    <div class="cols">
      <div>
        <div class="flow"><span class="box cust">This page</span>&rarr;<span class="box you">server.js</span>&rarr;<span class="box div">Dividia</span></div>
        <button id="send" type="button">Send a ticket</button>
        <p class="note">Real: the site's cameras photograph the scale.</p>
        <label for="ticket">Ticket number (each send fills this in)</label><input id="ticket" spellcheck="false">
        <button id="pdf" type="button">Get the PDF</button>
        <p class="note">The PDF has no photos until the site has recorded the weighment. Ask again later for the complete PDF.</p>
      </div>
      <div>
        <h3>What happened</h3>
        <div id="verdict"></div>
        <ol class="trace" id="trace"><li>Nothing yet. Press a button.</li></ol>
      </div>
    </div>
    <div id="detail"></div>
  </div>
</div>
<script>
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function text(tag, value, cls) { var e = document.createElement(tag); e.textContent = value; if (cls) e.className = cls; return e; }
  var setup = null;

  // The picture of the two requests. Each line is a list of [text, class] pieces.
  function write(pre, lines) {
    pre.innerHTML = '';
    lines.forEach(function (parts) {
      parts.forEach(function (part) { pre.appendChild(part[1] ? text('span', part[0], part[1]) : document.createTextNode(part[0])); });
      pre.appendChild(document.createTextNode('\\n'));
    });
  }
  function showRequests() {
    var c = setup, s = setup, k = setup;
    if (!setup) return;
    var headers = [
      [['Authorization: Bearer '], ['whsec_...', 'rec'], ['   the customer secret', 'why']],
      [['Dividia-Customer-Id: '], ['<Customer ID>', 'rec'], ['   the Customer ID', 'why']]
    ];
    write($('requestTicket'), [[['POST ' + c.dividiaUrl + '/sw/webhooks/cc']]].concat(headers, [
      [['Content-Type: application/json']],
      [['']],
      [['{']],
      [['  "uniqueId": "...",'], ['   new for every ticket', 'why']],
      [['  "ticketNumber": "...",']],
      [['  "ticketDateTime": "...",']],
      [['  "vehicle": {...}, "carrier": {...}, "customer": {...},']],
      [['  "project": {...}, "product": {...}, "orderId": "...",']],
      [['  '], ['"location": {', 'tic']],
      [['    '], ['"id": ' + JSON.stringify(s.locationId) + ',', 'tic'], ['   picks the site', 'why']],
      [['    '], ['"name": ' + JSON.stringify(s.locationName), 'tic']],
      [['  '], ['},', 'tic']],
      [['  '], ['"scaleId": ' + JSON.stringify(k.scaleId), 'tic'], ['   picks the scale', 'why']],
      [['}']],
      [['']],
      [['The full body appears below after you send a ticket.', 'why']]
    ]));
    write($('requestPdf'), [
      [['GET ' + c.dividiaUrl + '/sw/api/tickets/pdf']],
      [['    ?locationId='], [s.locationId, 'tic']],
      [['    &ticket='], ['<ticket number>', 'tic']]
    ].concat(headers, [
      [['']],
      [['The same two headers. locationId is the location.id of the ticket.', 'why']],
      [['Dividia answers with the PDF and a file name.', 'why']]
    ]));
  }

  function show(trace, verdictClass, verdictText, detailText, pdfUrl, pdfName) {
    $('trace').innerHTML = '';
    (trace || []).forEach(function (line) { $('trace').appendChild(text('li', line)); });
    $('verdict').innerHTML = '';
    if (verdictText) $('verdict').appendChild(text('div', verdictText, 'verdict ' + verdictClass));
    $('detail').innerHTML = '';
    if (detailText) $('detail').appendChild(text('pre', detailText));
    if (pdfUrl) {
      var a = text('a', 'Save the PDF as ' + pdfName); a.href = pdfUrl; a.download = pdfName; $('detail').appendChild(a);
      var f = document.createElement('iframe'); f.title = 'Ticket PDF'; f.src = pdfUrl; $('detail').appendChild(f);
    }
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
      var response = await fetch('/tester/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: '{}' });
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
      var response = await fetch('/tester/tickets/' + encodeURIComponent(ticket) + '/pdf');
      var header = response.headers.get('X-Example-Trace');
      var trace = header ? JSON.parse(decodeURIComponent(header)) : [];
      if ((response.headers.get('Content-Type') || '').indexOf('application/pdf') === 0) {
        var blob = await response.blob();
        var named = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '');
        show(trace, 'ok', 'PDF received from your server (' + blob.size + ' bytes).', null, URL.createObjectURL(blob), named ? named[1] : 'ticket.pdf');
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

  fetch('/tester/setup').then(function (r) { return r.json(); }).then(function (v) {
    setup = v;
    var quote = function (value) { return "'" + String(value).replace(/'/g, "'\\\\''") + "'"; };
    $('startedWith').textContent = "export DIVIDIA_CUSTOMER_ID='...'     the Customer ID (not shown)\\n"
      + "export DIVIDIA_SECRET='whsec_...'    the customer secret (not shown)\\n"
      + 'node server.js --location ' + quote(v.locationId) + ' --location-name ' + quote(v.locationName) + ' --scale ' + quote(v.scaleId);
    $('vLocationId').textContent = v.locationId; $('vLocationName').textContent = v.locationName; $('vScaleId').textContent = v.scaleId;
    showRequests();
  });
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

module.exports = { SETUP, dividiaHeaders, sendTicket, getTicketPdf, sampleTicket, shown, guard, option, server };
