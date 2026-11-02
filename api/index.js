'use strict';

let serverModule;
let serverLoadError = null;

try {
  serverModule = require('../server');
} catch (err) {
  serverLoadError = err;
  console.error('Fatal: Failed to load server.js:', err);
}

function sendError(res, error) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = 500;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error }));
}

module.exports = async function vercelHandler(req, res) {
  try {
    if (serverLoadError || !serverModule || !serverModule.handler) {
      console.error('Module initialization failure:', serverLoadError || new Error('server.js handler not found'));
      sendError(res, 'The store is temporarily unavailable. Please try again shortly.');
      return;
    }

    // vercel.json rewrites every request to /api/index?__route=/<original path>.
    // Restore the original URL (and drop the helper params Vercel adds) before routing.
    const url = new URL(req.url, 'http://vercel.local');
    const originalPath = url.searchParams.get('__route');
    if (originalPath) {
      url.searchParams.delete('__route');
      url.searchParams.delete('path');
      const query = url.searchParams.toString();
      req.url = originalPath + (query ? '?' + query : '');
    }

    await serverModule.handler(req, res);

    if (!res.writableEnded) {
      await new Promise((resolve) => {
        res.on('finish', resolve);
        res.on('close', resolve);
      });
    }
  } catch (error) {
    console.error('Vercel handler runtime error:', error);
    sendError(res, 'Something went wrong. Please try again.');
  }
};
