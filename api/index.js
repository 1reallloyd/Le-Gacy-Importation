'use strict';

let serverModule;
let serverLoadError = null;

try {
  serverModule = require('../server');
} catch (err) {
  serverLoadError = err;
  console.error('Fatal: Failed to load server.js:', err);
}

module.exports = async function vercelHandler(req, res) {
  try {
    if (serverLoadError || !serverModule || !serverModule.handler) {
      const err = serverLoadError || new Error('server.js handler not found');
      console.error('Module initialization failure:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: 'Module Initialization Error',
          message: err.message,
          stack: err.stack
        }, null, 2));
      }
      return;
    }

    const url = new URL(req.url, 'http://vercel.local');
    const originalPath = url.searchParams.get('__route');
    if (originalPath) {
      url.searchParams.delete('__route');
      req.url = originalPath + (url.search ? '?' + url.searchParams.toString() : '');
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
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: 'Internal Server Error',
        message: error && error.message,
        stack: error && error.stack
      }, null, 2));
    }
  }
};
