'use strict';

const { handler } = require('../server');

module.exports = async function vercelHandler(req, res) {
  try {
    const url = new URL(req.url, 'http://vercel.local');
    const originalPath = url.searchParams.get('__route');
    if (originalPath) {
      url.searchParams.delete('__route');
      req.url = originalPath + (url.search ? '?' + url.searchParams.toString() : '');
    }
    await handler(req, res);
    if (!res.writableEnded) {
      await new Promise((resolve) => {
        res.on('finish', resolve);
        res.on('close', resolve);
      });
    }
  } catch (error) {
    console.error('Vercel handler error:', error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Internal Server Error', message: error && error.message }));
    }
  }
};
