'use strict';

const { handler } = require('../server');

module.exports = async function vercelHandler(req, res) {
  const url = new URL(req.url, 'http://vercel.local');
  const originalPath = url.searchParams.get('__route');
  if (originalPath) {
    url.searchParams.delete('__route');
    req.url = originalPath + (url.search ? '?' + url.searchParams.toString() : '');
  }
  await handler(req, res);
};
