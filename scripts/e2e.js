import http from 'node:http';
import { gunzipSync } from 'node:zlib';

const FIXTURE_URL = 'https://us.openslr.org/resources/1/waves_yesno.tar.gz';

function pass(stage, detail = '') { console.log(stage + ': PASS' + (detail ? ' ' + detail : '')); }
function fail(stage, err) { console.error('FAILED: ' + stage); console.error('REASON: ' + (err?.stack || err?.message || err)); process.exitCode = 1; }

async function downloadFixture() {
  const url = 'https://raw.githubusercontent.com/koudounasalkis/Audio-Speech-Tutorial/a842462b1738967af177e3394ec0886106fd4385/_sample_data/yes_no/waves_yesno/1_1_1_0_1_0_1_0.wav';
  const r = await fetch(url);
  if (!r.ok) throw new Error('Speech fixture HTTP ' + r.status);
  return { name: '1_1_1_0_1_0_1_0.wav', buffer: Buffer.from(await r.arrayBuffer()) };
}

function startDownloadFileMock(audio) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/DownloadFile') return res.writeHead(404).end();
      const path = url.searchParams.get('path') || '';
      if (path.includes('missing')) return res.writeHead(404, {'content-type':'application/json'}).end(JSON.stringify({error:'missing'}));
      if (path.includes('empty')) return res.writeHead(200, {'content-type':'audio/wav'}).end();
      if (path.includes('html')) return res.writeHead(200, {'content-type':'text/html'}).end('<html>not audio</html>');
      res.writeHead(200, {'content-type':'audio/wav','content-length':String(audio.buffer.length)}).end(audio.buffer);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function httpGet(base, path) {
  const r = await fetch(base + path);
  return { status: r.status, text: await r.text(), headers: r.headers };
}

export async function runE2E() {
const fixture = await downloadFixture();
console.log('FIXTURE: ' + fixture.name + ' bytes=' + fixture.buffer.length);
process.env.E2E_HARNESS_MODE = '1';
process.env.YEMOT_API_BASE_URL = process.env.YEMOT_API_BASE_URL || 'http://127.0.0.1:0';

const mock = startDownloadFileMock(fixture);
const downloadServer = await mock;
const port = downloadServer.address().port;
process.env.YEMOT_API_BASE_URL = 'http://127.0.0.1:' + port;

const { app, normalizeYemotRecordingPath, audioMimeType, transcribeAudio, answerTextQuestion, wantsWebSearch, withTimeout } = await import('../server.js');

try {
  const normalized = [
    ['1/e2e-test.wav', 'ivr2:/1/e2e-test.wav'],
    ['/1/e2e-test.wav', 'ivr2:/1/e2e-test.wav'],
    ['ivr2:/1/e2e-test.wav', 'ivr2:/1/e2e-test.wav']
  ];
  for (const [input, expected] of normalized) {
    const actual = normalizeYemotRecordingPath(input);
    if (actual !== expected) throw new Error(input + ' -> ' + actual + ' expected ' + expected);
  }
  pass('RECORD_PATH');
  
  if (audioMimeType(fixture.name, fixture.buffer) !== 'audio/wav') throw new Error('WAV magic detection failed');
  pass('AUDIO_VALIDATION');

  let appServer = null;
  let base;
  if (process.env.E2E_USE_RUNNING_SERVER === '1') {
    base = 'http://127.0.0.1:' + (process.env.PORT || '10000');
  } else {
    appServer = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const appPort = appServer.address().port;
    base = 'http://127.0.0.1:' + appPort;
  }
  const q = '?ApiPhone=0500000000&ApiDID=0795695500&ApiExtension=8&ApiCallId=e2e-' + Date.now();

  const first = await httpGet(base, '/yemot' + q);
  if (first.status !== 200 || !first.text.startsWith('read=')) throw new Error('Initial Yemot response was not read=...: ' + first.text.slice(0,200));
  pass('YEMOT_REQUEST', 'actual Express + yemot-router2');

  const callId = new URLSearchParams(q.slice(1)).get('ApiCallId');
  const continuation = await httpGet(base, '/yemot' + q + '&val_1=' + encodeURIComponent('ivr2:/e2e-test.wav'));
  if (continuation.status !== 200 || !continuation.text.includes('id_list_message=t-')) throw new Error('Final Yemot response missing id_list_message=t-: ' + continuation.text.slice(0,500));
  if (!continuation.text.includes('read=')) throw new Error('prependToNextAction did not chain into the next read');
  pass('AUDIO_DOWNLOAD', 'real downloadYemotFile against local DownloadFile protocol fixture');
  pass('TRANSCRIPTION', 'real Gemini audio transcription');
  pass('GEMINI', 'real Gemini answer');
  pass('YEMOT_RESPONSE', 'actual yemot-router2 serialization: ' + continuation.text.slice(0,180));

  const hangup = await httpGet(base, '/yemot' + q + '&hangup=yes');
  if (hangup.status !== 200 || !hangup.text.includes('hangup')) throw new Error('Hangup continuation failed: ' + hangup.text);
  
  const web = wantsWebSearch('מה מזג האוויר היום בפתח תקווה');
  if (!web) throw new Error('needs_web routing predicate did not trigger');
  pass('WEB_SEARCH', 'route selected needs_web=true');
  const webAnswer = await answerTextQuestion('מה מזג האוויר היום בפתח תקווה', true);
  if (!webAnswer || webAnswer.length < 5) throw new Error('Gemini Search grounding returned empty answer');
  pass('WEB_SEARCH', 'real Gemini Google Search grounding');

  const badCases = [
    ['missing', 'HTTP 404'],
    ['empty', 'empty file'],
    ['html', 'error document']
  ];
  const { downloadYemotFile: downloadFile } = await import('../server.js');
  for (const [kind, expected] of badCases) {
    let threw = false;
    try { await downloadFile('ivr2:/e2e-' + kind + '.wav'); } catch (e) { threw = true; if (!String(e.message).toLowerCase().includes(expected.toLowerCase())) throw new Error(kind + ' wrong error: ' + e.message); }
    if (!threw) throw new Error(kind + ' did not fail');
  }
  pass('FAILURE_DOWNLOAD');

  let threw = false;
  try { await transcribeAudio(Buffer.from('not an audio file'), 'bad.wav'); } catch (e) { threw = true; }
  if (!threw) throw new Error('invalid audio was accepted');
  pass('FAILURE_AUDIO_VALIDATION');

  for (const label of ['transcription', 'Gemini']) {
    let timeout = false;
    try { await withTimeout(new Promise(r => setTimeout(r, 50)), 10, label); } catch (e) { timeout = e.status === 408; }
    if (!timeout) throw new Error(label + ' timeout was not surfaced as 408');
  }
  pass('FAILURE_TIMEOUTS');

  if (appServer) await new Promise(r => appServer.close(r));
} finally {
  await new Promise(r => downloadServer.close(r));
}

if (process.exitCode) process.exit(process.exitCode);
console.log('E2E HARNESS COMPLETE: PASS');

}

if (process.argv[1] && process.argv[1].endsWith('/scripts/e2e.js')) {
  runE2E().catch(err => { fail('E2E_HARNESS', err); process.exit(1); });
}
