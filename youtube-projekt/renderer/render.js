#!/usr/bin/env node
// Usage: node render.js story.json out.mp4 [--fps 30] [--scale 1] [--gpu]
//   --gpu: use the machine's GPU via EGL (headless Linux with Mesa/AMD) instead of software rendering
// Renders a 9:16 Roblox-style story to MP4 with headless Chromium + ffmpeg.
const fs = require('fs'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const storyFile = args[0], outFile = args[1] || 'out.mp4';
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FPS = +opt('--fps', 30), SCALE = +opt('--scale', 1), GPU = args.includes('--gpu');
const W = Math.round(1080 * SCALE), H = Math.round(1920 * SCALE);
if (!storyFile) { console.error('usage: node render.js story.json out.mp4'); process.exit(1); }
const story = JSON.parse(fs.readFileSync(storyFile, 'utf8'));

const dir = __dirname;
const server = http.createServer((req, res) => {
  const f = path.join(dir, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'scene.html');
  if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const gpuArgs = GPU ? ['--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
                     : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  const browser = await chromium.launch({ args: gpuArgs });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.error('page error:', e.message));
  await page.addInitScript(({ story, W, H }) => { window.STORY = story; window.RW_W = W; window.RW_H = H; }, { story, W, H });
  await page.goto(`http://127.0.0.1:${port}/scene.html`);
  await page.waitForFunction(() => window.RW_ready === true, null, { timeout: 60000 });
  const total = await page.evaluate(() => window.RW_total);
  const frames = Math.round(total * FPS);
  console.log(`rendering ${frames} frames (${total.toFixed(1)} s) at ${W}x${H} ${FPS}fps`);

  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let i = 0; i < frames; i++) {
    const dataUrl = await page.evaluate(t => window.renderFrame(t), i / FPS);
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % (FPS * 5) === 0 && i) console.log(`  ${i}/${frames} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  await browser.close(); server.close();
  console.log(`done: ${outFile} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
})().catch(e => { console.error(e); process.exit(1); });
