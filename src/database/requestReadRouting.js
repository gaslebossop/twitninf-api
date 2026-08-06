'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const requestStorage = new AsyncLocalStorage();

function requestReadRouting(req, _res, next) {
  const method = String(req.method || '').toUpperCase();
  requestStorage.run({ allowReplica: method === 'GET' || method === 'HEAD' }, next);
}

function requestAllowsReplica() {
  return requestStorage.getStore()?.allowReplica === true;
}

module.exports = { requestReadRouting, requestAllowsReplica };
