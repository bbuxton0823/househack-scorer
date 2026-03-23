// Vercel serverless function — wraps the Express app from dist/index.cjs
const http = require('http');

let handler = null;

const origCreateServer = http.createServer;
http.createServer = function (requestListener) {
  if (typeof requestListener === 'function') {
    handler = requestListener;
  }
  const srv = origCreateServer.call(http, requestListener);
  srv.listen = function () {
    const args = Array.from(arguments);
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    if (cb) setImmediate(cb);
    return srv;
  };
  return srv;
};

const initPromise = new Promise((resolve) => {
  require('../dist/index.cjs');
  setTimeout(resolve, 500);
});

module.exports = async (req, res) => {
  await initPromise;
  if (handler) {
    return handler(req, res);
  }
  res.statusCode = 500;
  res.end(JSON.stringify({ error: 'Server failed to initialize' }));
};
